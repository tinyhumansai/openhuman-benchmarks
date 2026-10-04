// quiet-host.mjs — one benchmark run at a time per host.
//
// Benchmarks measure CPU and latency, so two runs on one host corrupt each other even with
// separate proxies and compose projects. Every runner (orchestrate.mjs, tbench/run.mjs) calls
// waitForQuietHost() before starting; BENCH_ALLOW_CONCURRENT=1 skips the wait.

import fs from "node:fs";
import path from "node:path";

/**
 * Whether a process command line is an active benchmark run or grading pass. Only real `node`
 * runner processes count: a wrapper shell whose command line merely mentions a script must not
 * block (or deadlock) its own child.
 */
export function isBenchProcess(argv) {
  const exe = path.basename(argv[0] ?? "");
  const script = (s) => argv.slice(1, 3).some((a) => a.endsWith(s));
  if (exe === "node" && (script("orchestrate.mjs") || script("tbench/run.mjs") || script("deepswe/grade.mjs"))) return true;
  // Harbor started outside tbench/run.mjs (or still running after it was killed).
  if (argv.some((a) => path.basename(a) === "harbor") && argv.includes("run")) return true;
  // grading starts and removes many containers: as noisy as a run
  return argv.includes("swebench.harness.run_evaluation");
}

/** Pids of other benchmark runs on this host, excluding `self` and its ancestors. */
export function otherRuns(self = process.pid) {
  const exclude = new Set();
  for (let pid = self; pid > 1; ) {
    exclude.add(pid);
    try {
      pid = Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
    } catch {
      break;
    }
  }
  const pids = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || exclude.has(Number(name))) continue;
    try {
      if (isBenchProcess(fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean))) pids.push(name);
    } catch {
      // process exited
    }
  }
  return pids;
}

export async function waitForQuietHost(log = (m) => process.stdout.write(m)) {
  if (process.env.BENCH_ALLOW_CONCURRENT === "1") return;
  let waited = 0;
  for (let pids = otherRuns(); pids.length; pids = otherRuns()) {
    if (waited % 60 === 0) log(`[bench] another benchmark run is active (pid ${pids.join(",")}); waiting for a quiet host\n`);
    await new Promise((r) => setTimeout(r, 5000));
    waited += 5;
  }
}
