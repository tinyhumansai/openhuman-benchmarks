#!/usr/bin/env node
// grade.mjs — score a finished DeepSWE run with each task's own verifier.
//   node deepswe/grade.mjs --run-id ID --harness openhuman [--workers 2] [--src .cache/deepswe]
// For every task with a patch.diff: start a fresh container from the task image (HEAD = base
// commit), `git apply` the harness's patch, mount the task's tests/ at /tests and run
// /tests/test.sh, which applies the hidden test patch and writes /logs/verifier/reward.txt (1 = pass).
// The dataset's verifier is the only source of "resolved". Writes grade.json in the same shape as
// swebench/grade.mjs: {task: {resolved, empty_patch, error}}.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const runId = opt("--run-id");
const harness = opt("--harness");
const workers = Number(opt("--workers", "2"));
const src = path.resolve(root, opt("--src", ".cache/deepswe"));
const tasksDir = path.resolve(root, opt("--tasks-dir", "tasks/generated/deepswe"));
if (!runId || !harness) throw new Error("--run-id and --harness are required");

const dir = path.join(root, "results", runId, harness);
const images = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(tasksDir, "tasks.json"), "utf8")).map((t) => [t.id, t.image]));
const cpus = process.env.BENCH_CPUS ?? "4";
const mem = process.env.BENCH_MEM ?? "8g";

function run(cmd, a, outFile, timeoutMs) {
  return new Promise((resolve) => {
    const fd = fs.openSync(outFile, "a");
    const p = spawn(cmd, a, { stdio: ["ignore", fd, fd] });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", (code) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      resolve(code ?? 1);
    });
  });
}

async function gradeOne(key) {
  const id = key.replace(/#r\d+$/, "");
  const tdir = path.join(dir, key);
  const patch = path.join(tdir, "patch.diff");
  const logs = path.join(tdir, "grade");
  fs.rmSync(logs, { recursive: true, force: true });
  fs.mkdirSync(path.join(logs, "verifier"), { recursive: true });
  fs.mkdirSync(path.join(logs, "artifacts"), { recursive: true });
  fs.chmodSync(logs, 0o777);
  for (const s of ["verifier", "artifacts"]) fs.chmodSync(path.join(logs, s), 0o777);
  const log = path.join(tdir, "grade.log");
  fs.writeFileSync(log, "");
  if (!fs.existsSync(patch) || fs.statSync(patch).size === 0) return [key, { resolved: false, empty_patch: true, error: false }];
  const cname = `grade-${runId}-${harness}-${id}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  const script = 'cd /app && git config --global --add safe.directory /app && git apply --whitespace=nowarn /patch.diff && bash /tests/test.sh';
  const code = await run(
    "docker",
    [
      "run", "--rm", "--name", cname, `--cpus=${cpus}`, `--memory=${mem}`, "--network=none",
      "-v", `${path.resolve(patch)}:/patch.diff:ro`,
      "-v", `${path.join(src, "tasks", id, "tests")}:/tests:ro`,
      "-v", `${path.join(logs, "verifier")}:/logs/verifier`,
      "-v", `${path.join(logs, "artifacts")}:/logs/artifacts`,
      "--entrypoint", "bash", images[id], "-lc", script,
    ],
    log,
    2000_000,
  );
  await run("docker", ["rm", "-f", cname], "/dev/null", 60_000);
  let reward = null;
  try {
    reward = fs.readFileSync(path.join(logs, "verifier", "reward.txt"), "utf8").trim();
  } catch {
    // verifier never reached the reward step (patch did not apply, timeout, crash)
  }
  const applyFailed = code !== 0 && reward === null;
  return [key, { resolved: reward === "1", empty_patch: false, error: applyFailed }];
}

const keys = fs.readdirSync(dir).filter((k) => fs.existsSync(path.join(dir, k, "result.json")));
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (next < keys.length) {
      const k = keys[next++];
      const [key, g] = await gradeOne(k);
      console.log(`[grade ${harness}] ${key}: ${g.resolved ? "resolved" : g.empty_patch ? "empty patch" : g.error ? "error" : "failed"}`);
      results.push([key, g]);
    }
  }),
);
const out = Object.fromEntries(results.map(([k, g]) => [k.replace(/#r\d+$/, ""), g]));
fs.writeFileSync(path.join(dir, "grade.json"), JSON.stringify(out, null, 2));
console.log(`graded ${results.length}: resolved ${results.filter(([, g]) => g.resolved).length}`);
