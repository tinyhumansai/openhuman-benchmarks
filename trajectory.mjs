// trajectory.mjs — reconstruct what an agent actually did on one task, from the
// captures already on disk.
//
// The capture proxy stores each call's messages content-addressed
// (`captures/blobs/<sha>.json`) and each call keeps only `message_shas`, so a
// task's trajectory — every tool call, its arguments and its result — is on
// disk but nothing joins it back. The viewer does the join, but only as a
// server; this is the CLI the diagnosis work kept needing.
//
// Tool *durations* are the one thing genuinely not recorded. They are derived:
// a meter row's `at` is when the call started and `total_ms` how long it took,
// so the gap to the next call's `at` is the time that call's tools ran. That is
// what answers "which command ate the turn".
//
//   node trajectory.mjs <run>                      # tasks in the run
//   node trajectory.mjs <run> <task>               # the trajectory
//   node trajectory.mjs <run> <task> --gaps        # where the wall clock went
//   node trajectory.mjs <run> <task> --full [--seq N]  # one call, verbatim
import fs from "node:fs";
import path from "node:path";
import { toMarkdown } from "./viewer/transcript.mjs";

let RESULTS = process.env.BENCH_RESULTS ?? "results";
/** Point the reader at another results tree (tests, or a copied run). */
export const setResults = (dir) => {
  RESULTS = dir;
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const dirs = (p) =>
  fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

/** Reject a path segment that could escape the results tree. */
const seg = (s) => {
  if (!s || s.includes("/") || s.includes("\\") || s === "." || s === "..") throw new Error(`bad path segment: ${s}`);
  return s;
};

const blob = (run, id) => {
  const p = path.join(RESULTS, seg(run), "captures", "blobs", `${seg(id)}.json`);
  return fs.existsSync(p) ? readJson(p) : null;
};

/** Every capture for one task, in sequence order. */
function calls(run, harness, task) {
  const dir = path.join(RESULTS, seg(run), "captures", seg(harness), seg(task));
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson(path.join(dir, f)));
}

/** The harness directory holding `task`, or the only one when task is absent. */
function findHarness(run, task, explicit) {
  const base = path.join(RESULTS, seg(run), "captures");
  const names = dirs(base).filter((d) => d !== "blobs");
  if (explicit) return explicit;
  if (!task) return names[0];
  const hit = names.find((h) => fs.existsSync(path.join(base, h, task)));
  if (!hit) throw new Error(`task \`${task}\` not captured in run \`${run}\` (harnesses: ${names.join(", ") || "none"})`);
  return hit;
}

/**
 * The task's conversation in order, deduplicated by sha.
 *
 * A retry re-sends the identical transcript, and the truncated-empty recovery
 * pops a row before re-sending, so the same message appears in many calls.
 * Walking calls in order and emitting each sha once reconstructs the history
 * including rows a later call dropped.
 */
export function conversation(run, callList) {
  const seen = new Set();
  const out = [];
  for (const c of callList) {
    for (const sha of c.message_shas ?? []) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const m = blob(run, sha);
      if (m) out.push({ sha, seq: c.seq, ...m });
    }
  }
  return out;
}

const text = (c) =>
  typeof c === "string" ? c : c == null ? "" : Array.isArray(c) ? c.map((p) => p?.text ?? JSON.stringify(p)).join("\n") : JSON.stringify(c);

/** A tool result that reports a refused or malformed call, not an output. */
export function toolError(body) {
  return /^(invalid arguments for tool|expected [`,]|validation error|unknown tool|error:)/i.test(body.trim());
}

/**
 * Per-call model time and the gap to the next call, which is when that call's
 * tools ran. `at` is the call's start, so the gap is
 * `next.at - (at + total_ms)`.
 */
export function gaps(rows) {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  return sorted.map((r, i) => {
    const start = Date.parse(r.at);
    const next = sorted[i + 1] ? Date.parse(sorted[i + 1].at) : null;
    return {
      seq: r.seq,
      model_s: Math.round((r.total_ms ?? 0) / 100) / 10,
      tools_s: next === null ? null : Math.round((next - start - (r.total_ms ?? 0)) / 100) / 10,
      out: r.completion_tokens,
    };
  });
}

function meterRows(run) {
  const file = path.join(RESULTS, "meter.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.includes(run))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const seqArg = argv.find((a) => a.startsWith("--seq="))?.slice(6);
  const [run, task] = positional;
  if (!run) {
    console.error("usage: node trajectory.mjs <run> [task] [--gaps] [--full] [--seq=N]");
    process.exit(2);
  }
  const harness = findHarness(run, task, argv.find((a) => a.startsWith("--harness="))?.slice(10));
  if (!task) {
    for (const t of dirs(path.join(RESULTS, seg(run), "captures", seg(harness)))) console.log(t);
    return;
  }
  const callList = calls(run, harness, task);

  if (flags.has("--full")) {
    const c = seqArg ? callList.find((x) => String(x.seq) === seqArg) : callList[callList.length - 1];
    if (!c) throw new Error(`no capture with seq ${seqArg}`);
    console.log(
      toMarkdown({
        ...c,
        system: c.system_sha ? blob(run, c.system_sha) : "",
        tools: c.tools_sha ? blob(run, c.tools_sha) : [],
        messages: (c.message_shas ?? []).map((id) => blob(run, id)),
      }),
    );
    return;
  }

  if (flags.has("--gaps")) {
    const rows = gaps(meterRows(run).filter((r) => r.task === task));
    const total = rows.reduce((a, r) => a + r.model_s + (r.tools_s ?? 0), 0);
    console.log(`${harness} · ${task} — ${rows.length} calls, ${Math.round(total)}s accounted`);
    console.log("seq  model_s  tools_s  out_tokens");
    for (const r of rows) {
      const flag = (r.tools_s ?? 0) >= 120 ? "  <-- long tool call" : "";
      console.log(
        `${String(r.seq).padStart(3)}  ${String(r.model_s).padStart(7)}  ${String(r.tools_s ?? "-").padStart(7)}  ${String(r.out ?? "-").padStart(10)}${flag}`,
      );
    }
    const worst = rows.filter((r) => r.tools_s !== null).sort((a, b) => b.tools_s - a.tools_s)[0];
    if (worst) console.log(`\nlongest single tool step: ${worst.tools_s}s at seq ${worst.seq}`);
    return;
  }

  const msgs = conversation(run, callList);
  console.log(`# ${harness} · ${task} · ${msgs.length} messages across ${callList.length} calls\n`);
  msgs.forEach((m, i) => {
    const body = text(m.content ?? m.output ?? "");
    const names = (m.tool_calls ?? []).map((t) => t.function?.name).filter(Boolean);
    const head = body.split("\n").find((l) => l.trim()) ?? "";
    const bad = m.role === "tool" && toolError(body);
    const label = [m.role, names.length ? `-> ${names.join(",")}` : "", bad ? "  ** REFUSED **" : ""].join("");
    console.log(`${String(i).padStart(3)} [call ${m.seq}] ${label}  (${body.length}ch)`);
    if (head) console.log(`      ${head.slice(0, 160)}`);
  });
  const refused = msgs.filter((m) => m.role === "tool" && toolError(text(m.content ?? "")));
  if (refused.length) console.log(`\n${refused.length} refused/malformed tool call(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
