#!/opt/harness/node/bin/node
// entry.mjs — runs inside the task container. Executes one task with one
// harness: optional setup, the harness adapter under a wall-clock budget, a
// container-wide CPU/memory sampler around it, then captures the produced
// patch and runs the (uncharged) check. Writes result.json for the host.
//
// Env: BENCH_HARNESS BENCH_TASK_ID WORKDIR PROMPT_FILE RESULT_DIR
//      TASK_TIMEOUT_S (default 1800)  SETUP_SCRIPT CHECK_SCRIPT (optional)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startSampler, summarize } from "./cgroup.mjs";

const env = (k, d) => process.env[k] ?? d;
const harness = env("BENCH_HARNESS");
const taskId = env("BENCH_TASK_ID");
const workdir = env("WORKDIR", "/testbed");
const resultDir = env("RESULT_DIR", "/results");
const timeoutMs = Number(env("TASK_TIMEOUT_S", "1800")) * 1000;
if (!harness || !taskId) throw new Error("BENCH_HARNESS and BENCH_TASK_ID are required");

fs.mkdirSync(resultDir, { recursive: true });
const log = (m) => process.stderr.write(`[entry ${harness}/${taskId}] ${m}\n`);

// Conda-based SWE-bench images keep the project's deps in a `testbed` env; give
// the harness's shell tool the same environment a developer would have.
const activate = fs.existsSync("/opt/miniconda3/bin/activate")
  ? "source /opt/miniconda3/bin/activate testbed && "
  : "";

function runShell(script, { cwd, timeout, outFile }) {
  return new Promise((resolve) => {
    const out = fs.openSync(outFile, "w");
    const child = spawn("bash", ["-lc", `${activate}${script}`], {
      cwd,
      stdio: ["ignore", out, out],
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL"); // whole process group
      } catch {
        // already gone
      }
    }, timeout);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ code: code ?? (signal ? 128 : 1), timedOut });
    });
  });
}

if (process.env.SETUP_SCRIPT) {
  log("setup");
  const r = await runShell(`bash ${process.env.SETUP_SCRIPT}`, {
    cwd: workdir,
    timeout: 300_000,
    outFile: path.join(resultDir, "setup.log"),
  });
  if (r.code !== 0) throw new Error(`setup failed (${r.code})`);
}

// Baseline so the patch contains only what the harness changed.
spawnSync("git", ["add", "-A"], { cwd: workdir });
spawnSync("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "--allow-empty", "-m", "bench-baseline"], { cwd: workdir });
const baseline = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8" }).stdout.trim();

log("running adapter");
const sampler = startSampler(500);
const startedAt = Date.now();
const run = await runShell("/opt/harness/adapter.sh", {
  cwd: workdir,
  timeout: timeoutMs,
  outFile: path.join(resultDir, "harness.log"),
});
const endedAt = Date.now();
const resources = summarize(sampler.stop());

spawnSync("git", ["add", "-A"], { cwd: workdir });
const diff = spawnSync("git", ["diff", "--cached", baseline], {
  cwd: workdir,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
fs.writeFileSync(path.join(resultDir, "patch.diff"), diff.stdout ?? "");

let check = null;
if (process.env.CHECK_SCRIPT) {
  const c = await runShell(`bash ${process.env.CHECK_SCRIPT}`, {
    cwd: workdir,
    timeout: 300_000,
    outFile: path.join(resultDir, "check.log"),
  });
  check = { exit_code: c.code, passed: c.code === 0 };
}

fs.writeFileSync(
  path.join(resultDir, "result.json"),
  JSON.stringify(
    {
      harness,
      task: taskId,
      started_epoch_ms: startedAt,
      ended_epoch_ms: endedAt,
      wall_ms: endedAt - startedAt,
      exit_code: run.code,
      timed_out: run.timedOut,
      patch_bytes: Buffer.byteLength(diff.stdout ?? ""),
      resources,
      check,
    },
    null,
    2,
  ),
);
log(`done exit=${run.code} timed_out=${run.timedOut} wall=${endedAt - startedAt}ms`);
