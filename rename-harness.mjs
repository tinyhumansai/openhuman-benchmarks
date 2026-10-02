#!/usr/bin/env node
// rename-harness.mjs — rename a harness inside one finished run: its result
// directory, its runs.jsonl rows and its meter.jsonl records.
//   node rename-harness.mjs <run-id> <from> <to>
// Used when a variant is promoted (openhuman-native -> openhuman) and the old
// default is archived under another name (openhuman -> openhuman-python). Do the
// archive rename first. Do not run it while that run is still executing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function renameInJsonl(file, runId, from, to) {
  if (!fs.existsSync(file)) return 0;
  let changed = 0;
  const out = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => {
      if (!line) return line;
      const row = JSON.parse(line);
      if (row.run_id === runId && row.harness === from) {
        row.harness = to;
        changed += 1;
        return JSON.stringify(row);
      }
      return line;
    })
    .join("\n");
  fs.writeFileSync(file, out);
  return changed;
}

function main() {
  const [runId, from, to] = process.argv.slice(2);
  if (!runId || !from || !to) throw new Error("usage: rename-harness.mjs <run-id> <from> <to>");
  const runDir = path.join(here, "results", runId);
  const src = path.join(runDir, from);
  const dst = path.join(runDir, to);
  if (!fs.existsSync(src)) throw new Error(`no results for ${from} in ${runId}`);
  if (fs.existsSync(dst)) throw new Error(`${dst} already exists; archive it first`);
  fs.renameSync(src, dst);
  const idx = renameInJsonl(path.join(runDir, "runs.jsonl"), runId, from, to);
  const meter = renameInJsonl(path.join(here, "results", "meter.jsonl"), runId, from, to);
  process.stdout.write(`${runId}: ${from} -> ${to} (${idx} index rows, ${meter} proxy records)\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
