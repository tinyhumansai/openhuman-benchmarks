#!/usr/bin/env node
// grade.mjs — score a finished run with the official SWE-bench evaluator.
//   node swebench/grade.mjs --run-id ID --harness openhuman [--workers 2]
// Collects each task's patch.diff into predictions.jsonl, runs
// swebench.harness.run_evaluation, and writes grade.json {instance_id: resolved}.
// The official grader is the only source of "resolved"; nothing here re-scores.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const runId = opt("--run-id");
const harness = opt("--harness");
const workers = opt("--workers", "2");
if (!runId || !harness) throw new Error("--run-id and --harness are required");

const dir = path.join(root, "results", runId, harness);
const preds = [];
for (const task of fs.readdirSync(dir)) {
  const patch = path.join(dir, task, "patch.diff");
  if (!fs.existsSync(patch)) continue;
  preds.push({
    instance_id: task.replace(/#r\d+$/, ""),
    model_name_or_path: harness,
    model_patch: fs.readFileSync(patch, "utf8"),
  });
}
const predPath = path.join(dir, "predictions.jsonl");
fs.writeFileSync(predPath, preds.map((p) => JSON.stringify(p)).join("\n") + "\n");

const py = path.join(root, ".cache", "swebench-venv", "bin", "python");
const r = spawnSync(
  py,
  [
    "-m", "swebench.harness.run_evaluation",
    "--dataset_name", "princeton-nlp/SWE-bench_Verified",
    "--predictions_path", predPath,
    "--max_workers", workers,
    "--run_id", `${runId}-${harness}`,
    "--instance_ids", ...preds.map((p) => p.instance_id),
  ],
  { cwd: dir, stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

// The evaluator writes <model>.<run_id>.json next to the cwd.
const reportFile = fs.readdirSync(dir).find((f) => f.endsWith(`${runId}-${harness}.json`));
if (!reportFile) throw new Error("evaluator produced no report file");
const report = JSON.parse(fs.readFileSync(path.join(dir, reportFile), "utf8"));
const resolved = new Set(report.resolved_ids ?? []);
const empty = new Set(report.empty_patch_ids ?? []);
const errored = new Set(report.error_ids ?? []);
const out = Object.fromEntries(
  preds.map((p) => [
    p.instance_id,
    { resolved: resolved.has(p.instance_id), empty_patch: empty.has(p.instance_id), error: errored.has(p.instance_id) },
  ]),
);
fs.writeFileSync(path.join(dir, "grade.json"), JSON.stringify(out, null, 2));
console.log(`graded ${preds.length}: resolved ${resolved.size}`);
