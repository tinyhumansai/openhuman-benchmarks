# Runbook: running the benches on an x86_64 Linux box

For an agent that has to run this rig end to end and hand back results. Read `README.md` for
what the controls are; this file is only the procedure. Do the steps in order and stop at
any "Gate" that fails.

Why x86_64 Linux: the SWE-bench Verified instance images (`swebench/sweb.eval.x86_64.*`) are
published for x86_64 only. On an arm64 host (Apple Silicon) they fail with
`no matching manifest for linux/arm64/v8`. The bundle Dockerfiles pick the Node build from
`uname -m`, so they should build on x86_64, but this has not been tested there; treat the
first build as the test.

## 0. Prerequisites

- Linux x86_64, Docker with the compose plugin, Node >= 22 (host driver; the harnesses
  carry their own), `uv`, `git`, `jq`.
- Resources: 4 CPUs and 8 GB are the task container limits (`BENCH_CPUS`, `BENCH_MEM`), so
  the box needs at least 6 CPUs / 12 GB free for the task plus the proxy, and about 60 GB of
  disk (SWE images are several GB each; the OpenHuman build is large).
- cgroup v2 on the host (`stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`). The runner samples
  CPU and RAM from the container's cgroup.
- `OPENROUTER_API_KEY` in the environment or in `.env`. Never print it, log it or commit it.
  Only the proxy container holds it; harnesses get a dummy token.
- **Nothing else heavy running on the box.** Harnesses run one at a time on purpose; the
  orchestrator refuses to start if the host is busy (it reads `/proc`). Do not set
  `BENCH_ALLOW_CONCURRENT=1`; that override exists only for macOS, where `/proc` is missing,
  and it makes the CPU and latency numbers unreliable.

## 1. Check out the repo

```bash
git clone git@github.com:tinyhumansai/openhuman-benchmarks.git && cd openhuman-benchmarks
# OpenHuman is vendored as a submodule; the openhuman bundle compiles it.
# Move the pin (cd vendor/openhuman && git checkout <sha>) to benchmark another build.
git submodule update --init --recursive vendor/openhuman
cp .env.example .env     # then set OPENROUTER_API_KEY; leave the rest at the defaults
export BENCH_UID=$(id -u) BENCH_GID=$(id -g)
```

Controlled variables (defaults in `.env.example`, enforced by the proxy; do not change them
between harnesses or runs you intend to compare): `BENCH_MODEL=deepseek/deepseek-v4.1-flash`,
`BENCH_REASONING=high`, `BENCH_PROVIDER=DeepSeek`, `BENCH_CPUS=4`, `BENCH_MEM=8g`.

## 2. Build the harness bundles

```bash
for h in openhuman deepseek-harness; do ./bundles/build.sh $h; done
```

Add `claude-code codex opencode openclaw hermes deepseek-harness-minimal` for the full
lineup. OpenHuman compiles the Rust core (10-20 minutes cold). It is built from this
checkout, so the report records this checkout's git SHA as its version.

**Gate:** each build finishes, and `ls .cache/harness/<name>` shows the bundle. If a build
fails, stop and report the exact error; do not work around it silently.

## 3. Smoke test (micro suite)

```bash
HARNESSES="openhuman deepseek-harness" REPEAT=1 ./run-micro.sh smoke-x86
```

**Gate:** every harness passes 5/5 checks and `results/smoke-x86/summary.md` shows non-zero
LLM calls. If a harness gets 0 calls, read its adapter log under
`results/smoke-x86/<harness>/<task>/` before going further.

## 4. SWE-bench Verified sample (10 instances)

```bash
uv venv --python 3.12 .cache/swebench-venv
uv pip install --python .cache/swebench-venv/bin/python swebench datasets
.cache/swebench-venv/bin/python swebench/prepare.py --n 10 --seed 20261001 \
    --out tasks/generated/swe --pull
```

The instance list is fixed in `swebench/instances-10.txt`. Do not re-sample or change the
seed. A harmless `ResourceTracker.__del__ ... _recursion_count` traceback at the end of
`prepare.py` is interpreter-shutdown noise.

**Gate:** `ls tasks/generated/swe` lists the 10 instance dirs plus `tasks.json`, and
`docker images | grep sweb.eval` shows 10 images.

Run the lineup. `run-swe.sh` loops harnesses sequentially, grades each with the official
evaluator, then writes the report:

```bash
HARNESSES="openhuman deepseek-harness" TASK_TIMEOUT_S=1200 ./run-swe.sh swe-x86-1 \
  2>&1 | tee /tmp/swe-x86-1.log
```

harness to the same run (newest attempt wins in the report; every `meter.jsonl` record and `runs.jsonl` row carries an `attempt` id, and the summary and viewer keep only the graded attempt's records. Runs from before the id existed fall back to timestamps):
harness to the same run (newest attempt wins in the report):

```bash
./run-swe-extra.sh swe-x86-1 openhuman sympy__sympy-13031
```

**Gate:** `results/swe-x86-1/summary.md` exists, each harness has `grade.json`, and the
"LLM calls" row is non-zero. Check `docker ps -a` for leftover task containers if a run
was interrupted.

## 5. Report and inspect

```bash
node report.mjs --run-id swe-x86-1
node charts.mjs --run swe-x86-1 --png
node viewer/server.mjs        # http://127.0.0.1:8787, read-only
```

Hand back: `results/swe-x86-1/summary.md`, the chart, and the viewer's per-harness prompt
and cache views. `results/` is git-ignored; copy it out, or tar
`results/swe-x86-1` (it holds the captures, which include full prompts and responses).

## 6. What to report

- The resolved count per harness (from the official grader only) and cost per solved task.
- Cache hit % per harness, and the main-agent vs side-request / sub-agent split.
- Anything that looks wrong: a harness with 0 calls, provider errors (404/429), tasks that
  hit the timeout, or a rejected override. Quote the exact error.
- The state of the box (CPU model, core count, RAM, kernel, Docker version) and the
  checkout SHA, so the numbers can be compared later.

## Do not

- Run harnesses concurrently, or run anything else heavy meanwhile.
- Change the model, provider, reasoning level or resource limits mid-comparison.
- Compare numbers with `RESULTS.md` or the arm64 `smoke-*` runs. They were measured on an
  older setup and a different architecture.
- Write the API key to disk, a log or a commit.
- Skip a failing gate and carry on.

## Known caveats

- Results use the proxy's pinned provider `DeepSeek`. Hermes's title requests 404 under the
  strict provider pin (its `json_schema` response format is not supported). It does not affect
  Hermes's task results.
- `results/meter.jsonl` is append-only and not cleared between runs. Reusing a run id
  double-counts, so use a fresh id for every run.
- One attempt per task, no repeats: treat differences between harnesses as indicative, not
  as a ranking.
