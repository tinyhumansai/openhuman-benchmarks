#!/usr/bin/env node
// extract.mjs — build the offline context-compaction dataset from local request captures.
//
//   node compaction/extract.mjs [--results results] [--out compaction/data/cp-v1]
//                               [--runs a,b|all] [--fracs 0.4,0.7,0.9] [--min-messages 12]
//
// For every run/harness/task with captures, take the main agent's longest pre-compaction request,
// normalize it to OpenAI chat, cut it at each fraction (right after a complete tool-result round,
// with a next assistant action after the cut), and compute deterministic ground truth from the
// prefix. Writes <out>/checkpoints.jsonl and <out>/index.json. The output carries full prompts
// and tool outputs, so compaction/data/ is gitignored; only aggregate scores get committed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../contexts.mjs";
import { cutAt, normalizeTools, pickTrunk, toChat, validCuts } from "./normalize.mjs";
import { groundTruth } from "./truth.mjs";
import { probesFor } from "./probes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

/** The runs cp-v1 is built from (DeepSWE-10 x 7 harnesses, the OpenHuman capture rerun, SWE-10). */
export const DEFAULT_RUNS = ["deepswe10-x86-2", "deepswe10-oh-cap", "swe-x86-1"];

/** Wire formats this stage converts. Responses (codex) is not reconstructed yet. */
export const SUPPORTED = new Set(["chat", "anthropic"]);

function parseArgs(argv) {
  const opt = { results: path.join(repo, "results"), out: path.join(here, "data", "cp-v1"), runs: null, fracs: [0.4, 0.7, 0.9], minMessages: 12 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => argv[(i += 1)];
    if (a === "--results") opt.results = path.resolve(v());
    else if (a === "--out") opt.out = path.resolve(v());
    else if (a === "--runs") {
      const r = v();
      opt.runs = r === "all" ? "all" : r.split(",").filter(Boolean);
    }
    else if (a === "--fracs") opt.fracs = v().split(",").map(Number);
    else if (a === "--min-messages") opt.minMessages = Number(v());
    else if (a === "-h" || a === "--help") {
      console.log("usage: node compaction/extract.mjs [--results DIR] [--out DIR] [--runs a,b|all] [--fracs 0.4,0.7,0.9] [--min-messages N]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opt;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

/** Runs under results/ that have captures. */
const capturedRuns = (results) => dirs(results).filter((r) => fs.existsSync(path.join(results, r, "captures")));

/** Same context sizing the viewer uses: tools dominate, then system prompt size. */
const contextRecords = (calls) =>
  calls.map((c) => ({
    context: `${c.system_sha}.${c.tools_sha}`,
    system_prompt_tokens: (c.system_chars ?? 0) / 3,
    tool_schema_tokens: (c.tool_count ?? 0) * 1000,
  }));

/**
 * One task's dataset items.
 * @returns {{checkpoints: object[], skipped: string|null, meta: object}}
 */
export function extractTask({ capRoot, run, harness, task, fracs, minMessages }) {
  const dir = path.join(capRoot, harness, task);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const calls = files.map((f) => readJson(path.join(dir, f)));
  if (!calls.length) return { checkpoints: [], skipped: "no calls" };
  const format = calls.find((c) => c.tool_count > 0)?.format ?? calls[0].format;
  if (!SUPPORTED.has(format)) return { checkpoints: [], skipped: `format ${format} not supported yet` };
  // The main agent carries tools; a tool-less summarizer or title generator can out-number it.
  const withTools = calls.filter((c) => c.tool_count > 0);
  const { main } = classify(contextRecords(withTools.length ? withTools : calls));
  const { tip, compacted } = pickTrunk(calls, main);
  if (!tip) return { checkpoints: [], skipped: "no main-agent call" };
  const blob = (id) => readJson(path.join(capRoot, "blobs", `${id}.json`));
  const loaded = {
    format: tip.format,
    system: tip.system_sha ? blob(tip.system_sha) : "",
    messages: tip.message_shas.map(blob),
  };
  const tools = normalizeTools(tip.tools_sha ? blob(tip.tools_sha) : []);
  const messages = toChat(loaded);
  const meta = { source_seq: tip.seq, source_messages: tip.message_shas.length, harness_compacted: compacted, calls: calls.length };
  if (messages.length < minMessages) return { checkpoints: [], skipped: `too short (${messages.length} messages)`, meta };
  const cuts = validCuts(messages);
  const seen = new Set();
  const checkpoints = [];
  const dupes = [];
  for (const frac of fracs) {
    const at = cutAt(messages, frac, cuts);
    if (at === null) {
      dupes.push(`${frac}: no valid cut`);
      continue;
    }
    if (seen.has(at)) {
      dupes.push(`${frac}: same cut as an earlier fraction`);
      continue;
    }
    seen.add(at);
    const prefix = messages.slice(0, at);
    const truth = groundTruth(prefix, messages[at], tools);
    const id = `${run}/${harness}/${task}@${frac}`;
    checkpoints.push({
      id,
      run,
      harness,
      task,
      format,
      cut_frac: frac,
      cut_index: at,
      total_messages: messages.length,
      actual_frac: Math.round((at / messages.length) * 1000) / 1000,
      source_seq: tip.seq,
      messages: prefix,
      tools,
      truth,
      probes: probesFor(truth, id),
    });
  }
  return { checkpoints, skipped: checkpoints.length ? null : dupes.join("; ") || "no checkpoints", partial: dupes, meta };
}

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function main(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  const captured = capturedRuns(opt.results);
  const runs = opt.runs === "all" ? captured : (opt.runs ?? DEFAULT_RUNS.filter((r) => captured.includes(r)));
  fs.mkdirSync(opt.out, { recursive: true });
  const outFile = path.join(opt.out, "checkpoints.jsonl");
  const fd = fs.openSync(outFile, "w");
  const counts = {};
  const skipped = [];
  const partial = [];
  const tokensByFrac = {};
  const emptyTruth = {};
  let total = 0;
  for (const run of runs) {
    const capRoot = path.join(opt.results, run, "captures");
    if (!fs.existsSync(capRoot)) {
      skipped.push({ run, reason: "no captures directory" });
      continue;
    }
    for (const harness of dirs(capRoot).filter((d) => d !== "blobs")) {
      for (const task of dirs(path.join(capRoot, harness))) {
        let res;
        try {
          res = extractTask({ capRoot, run, harness, task, fracs: opt.fracs, minMessages: opt.minMessages });
        } catch (e) {
          res = { checkpoints: [], skipped: `error: ${e.message}` };
        }
        if (res.skipped) skipped.push({ run, harness, task, reason: res.skipped });
        for (const p of res.partial ?? []) if (res.checkpoints.length) partial.push({ run, harness, task, reason: p });
        const key = `${run}/${harness}`;
        counts[key] ??= { run, harness, tasks: 0, checkpoints: 0, harness_compacted: 0 };
        counts[key].tasks += 1;
        if (res.meta?.harness_compacted) counts[key].harness_compacted += 1;
        for (const cp of res.checkpoints) {
          fs.writeSync(fd, `${JSON.stringify(cp)}\n`);
          counts[key].checkpoints += 1;
          total += 1;
          (tokensByFrac[cp.cut_frac] ??= []).push(cp.truth.stats.est_tokens);
          const h = (emptyTruth[cp.harness] ??= { checkpoints: 0, files_modified: 0, files_read: 0, last_failing_command: 0, test_command: 0, task_identifiers: 0 });
          h.checkpoints += 1;
          for (const k of ["files_modified", "files_read", "task_identifiers"]) if (!cp.truth[k].length) h[k] += 1;
          for (const k of ["last_failing_command", "test_command"]) if (!cp.truth[k]) h[k] += 1;
        }
      }
    }
  }
  fs.closeSync(fd);
  const index = {
    dataset: path.basename(opt.out),
    created: new Date().toISOString(),
    runs,
    fracs: opt.fracs,
    formats_supported: [...SUPPORTED],
    note: "codex captures use the Responses wire format and are skipped by this stage",
    checkpoints: total,
    counts: Object.values(counts),
    avg_est_tokens_by_frac: Object.fromEntries(Object.entries(tokensByFrac).map(([f, xs]) => [f, mean(xs)])),
    empty_truth_by_harness: emptyTruth,
    skipped,
    partial,
  };
  fs.writeFileSync(path.join(opt.out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = main();
  const lines = [`${index.checkpoints} checkpoints -> ${index.dataset}`];
  for (const c of index.counts) lines.push(`  ${c.run}/${c.harness}: ${c.checkpoints} checkpoints from ${c.tasks} tasks${c.harness_compacted ? ` (${c.harness_compacted} restarted in-run, e.g. compaction; pre-restart trunk used)` : ""}`);
  lines.push(`avg est tokens by frac: ${JSON.stringify(index.avg_est_tokens_by_frac)}`);
  const reasons = {};
  for (const s of index.skipped) {
    const r = s.reason.replace(/\(\d+ messages\)/, "(n messages)");
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  lines.push(`skipped tasks: ${index.skipped.length} ${JSON.stringify(reasons)}`);
  lines.push(`empty truth fields by harness: ${JSON.stringify(index.empty_truth_by_harness)}`);
  console.log(lines.join("\n"));
}
