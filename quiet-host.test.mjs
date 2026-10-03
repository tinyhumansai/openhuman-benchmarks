import assert from "node:assert/strict";
import test from "node:test";
import { isBenchProcess, otherRuns } from "./quiet-host.mjs";

test("isBenchProcess counts every runner and grader, not wrapper shells", () => {
  assert.ok(isBenchProcess(["node", "orchestrate.mjs", "--harness", "x"]));
  assert.ok(isBenchProcess(["/usr/bin/node", "/r/tbench/run.mjs", "--bench", "2"]));
  assert.ok(isBenchProcess(["node", "deepswe/grade.mjs", "--run-id", "r"]));
  assert.ok(isBenchProcess(["/home/u/.local/bin/python3", "/home/u/.local/bin/harbor", "run", "-d", "x"]));
  assert.ok(isBenchProcess(["python", "-m", "swebench.harness.run_evaluation"]));
  assert.ok(!isBenchProcess(["bash", "-c", "node orchestrate.mjs --harness x"]));
  assert.ok(!isBenchProcess(["zsh", "./run-tbench.sh", "2"]));
  assert.ok(!isBenchProcess(["node", "report.mjs", "--run-id", "r"]));
});

test("otherRuns never reports the caller or its ancestors", () => {
  const mine = new Set([String(process.pid), String(process.ppid)]);
  assert.ok(otherRuns().every((p) => !mine.has(p)));
});
