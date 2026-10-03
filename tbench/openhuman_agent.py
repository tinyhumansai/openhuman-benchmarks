"""OpenHuman as a Harbor agent, for running Terminal-Bench through Harbor itself.

Harbor owns everything Terminal-Bench defines: the task environment (prebuilt image or
Dockerfile), its resources and network, the agent timeout, and the verifier. This agent
only runs the bench's usual in-container entry (runner/entry.mjs: cgroup sampler around
bundles/adapters/openhuman.sh) so every call goes through the metering proxy and the
result has the same shape as the bench's other suites.

The compose overlay written by tbench/run.mjs mounts the OpenHuman bundle at
/opt/harness and the runner at /opt/bench/runner (read-only), and attaches the task
container to the meter proxy's network.

Host env (set by tbench/run.mjs):
  BENCH_RUN_ID          results/<run-id>
  BENCH_METER_PORT      host port of the proxy's control plane (tags calls per task)
  BENCH_METER_LOG       host path of meter.jsonl (to report tokens/cost back to Harbor)
  BENCH_MODEL, BENCH_REASONING
"""

import json
import os
import shlex
import urllib.request
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HARNESS = "openhuman"


def task_key(logs_dir: Path) -> str:
    """Trial dirs are named <task>__<suffix>; the agent's logs dir sits inside one."""
    return logs_dir.parent.name.rsplit("__", 1)[0]


def tag_proxy(port: str, tag: dict) -> None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/__bench/run",
        data=json.dumps(tag).encode(),
        method="POST",
        headers={"connection": "close"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        if res.status != 200:
            raise RuntimeError(f"tagging meter proxy failed: HTTP {res.status}")


def meter_totals(log: str, tag: dict) -> dict:
    totals = {"calls": 0, "prompt": 0, "cached": 0, "completion": 0, "cost": 0.0}
    try:
        with open(log, encoding="utf8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (r.get("run_id"), r.get("harness"), r.get("task")) != (tag["run_id"], tag["harness"], tag["task"]):
                    continue
                totals["calls"] += 1
                totals["prompt"] += r.get("prompt_tokens") or 0
                totals["cached"] += r.get("cached_tokens") or 0
                totals["completion"] += r.get("completion_tokens") or 0
                totals["cost"] += r.get("cost_usd") or 0.0
    except FileNotFoundError:
        pass
    return totals


class OpenHuman(BaseAgent):
    @staticmethod
    def name() -> str:
        return HARNESS

    def version(self) -> str | None:
        return os.environ.get("BENCH_HARNESS_VERSION")

    async def setup(self, environment: BaseEnvironment) -> None:
        r = await environment.exec(
            "test -x /opt/harness/adapter.sh && test -f /opt/bench/runner/entry.mjs",
            timeout_sec=30,
        )
        if r.return_code != 0:
            raise RuntimeError("OpenHuman bundle or bench runner not mounted (run through tbench/run.mjs)")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        key = task_key(self.logs_dir)
        tag = {"run_id": os.environ["BENCH_RUN_ID"], "harness": HARNESS, "task": key}
        tag_proxy(os.environ["BENCH_METER_PORT"], tag)

        # /logs/agent is the host's trial agent dir, mounted into the container.
        (self.logs_dir / "prompt.txt").write_text(instruction, encoding="utf8")
        workdir = (await environment.exec("pwd", timeout_sec=30)).stdout.strip() or "/"
        env = {
            "BENCH_HARNESS": HARNESS,
            "BENCH_TASK_ID": key,
            "WORKDIR": workdir,
            # Harbor enforces the task's own agent timeout; this is only a backstop.
            "TASK_TIMEOUT_S": os.environ.get("BENCH_TASK_TIMEOUT_S", "86400"),
            "RESULT_DIR": f"{self.environment_logs_dir}/bench",
            "PROMPT_FILE": f"{self.environment_logs_dir}/prompt.txt",
            # Terminal-Bench grades the container itself (some tasks its git history): no baseline commit.
            "BENCH_CAPTURE_PATCH": "0",
            "PROXY_URL": "http://meter-proxy:8080",
            "BENCH_MODEL": os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4.1-flash"),
            "BENCH_REASONING": os.environ.get("BENCH_REASONING", "high"),
            "DUMMY_API_KEY": "bench-dummy-key",
            "OPENHUMAN_COMPACTION_TRIGGER_TOKENS": os.environ.get("OPENHUMAN_COMPACTION_TRIGGER_TOKENS", ""),
            "DISABLE_TELEMETRY": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DO_NOT_TRACK": "1",
            "CI": "1",
        }
        cmd = "/opt/harness/node/bin/node /opt/bench/runner/entry.mjs"
        r = await environment.exec(cmd, cwd=workdir, env=env)
        (self.logs_dir / "entry.log").write_text((r.stdout or "") + (r.stderr or ""), encoding="utf8")

        totals = meter_totals(os.environ.get("BENCH_METER_LOG", ""), tag)
        context.n_input_tokens = totals["prompt"]
        context.n_cache_tokens = totals["cached"]
        context.n_output_tokens = totals["completion"]
        context.cost_usd = totals["cost"]
        context.metadata = {"llm_calls": totals["calls"], "entry_exit_code": r.return_code, "workdir": workdir}
        if r.return_code != 0:
            raise RuntimeError(f"bench entry exited {r.return_code}: {shlex.quote((r.stderr or '')[-500:])}")
