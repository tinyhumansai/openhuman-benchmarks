// api.mjs — the viewer's read-only API over results/, shared by the live server
// (server.mjs) and the static GitHub Pages build (build-static.mjs).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { classify } from "../contexts.mjs";
import { orderHarnesses } from "../format.mjs";
import { latestAttempts } from "../report.mjs";
import { toMarkdown } from "./transcript.mjs";

let RESULTS = "";
/** Point the API at a results/ directory before calling any route. */
export const setResults = (dir) => { RESULTS = dir; };

const SEG = /^[A-Za-z0-9._#@=-]+$/;
const seg = (s) => {
  if (!SEG.test(s) || s === "." || s === "..") throw Object.assign(new Error("bad path"), { code: 400 });
  return s;
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const dirs = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/**
 * Meter records for one run, streamed so a large meter.jsonl is never loaded whole. Calls from an
 * earlier, aborted attempt at a task under the same run id are dropped, as in report.mjs.
 */
async function meterRecords(run) {
  const file = path.join(RESULTS, "meter.jsonl");
  const out = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line.includes(`"${run}"`)) continue;
    try {
      const r = JSON.parse(line);
      if (r.run_id === run) out.push(r);
    } catch {
      // a half-written trailing line while a run is live
    }
  }
  const index = path.join(RESULTS, run, "runs.jsonl");
  if (!fs.existsSync(index)) return out;
  const rows = fs.readFileSync(index, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  return latestAttempts(rows, out).meter;
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);

/** Calls that are not the main agent (side requests, sub-agents), classified per task. */
function sideTurns(records) {
  const tasks = new Map();
  for (const r of records) (tasks.get(r.task) ?? tasks.set(r.task, []).get(r.task)).push(r);
  let n = 0;
  for (const calls of tasks.values()) {
    const { main, contexts } = classify(calls);
    for (const c of contexts.values()) if (c.id !== main) n += c.calls.length;
  }
  return n;
}

function aggregate(records) {
  const by = {};
  for (const r of records) {
    const h = (by[r.harness] ??= { harness: r.harness, calls: 0, tasks: new Set(), records: [] });
    h.calls += 1;
    h.tasks.add(r.task);
    h.records.push(r);
  }
  return Object.values(by).map((h) => {
    const prompt = sum(h.records, (r) => r.prompt_tokens);
    const cached = sum(h.records, (r) => r.cached_tokens);
    const first = h.records.find((r) => r.system_prompt_tokens != null);
    return {
      harness: h.harness,
      calls: h.calls,
      tasks: h.tasks.size,
      prompt_tokens: prompt,
      completion_tokens: sum(h.records, (r) => r.completion_tokens),
      cache_pct: prompt ? (100 * cached) / prompt : null,
      cost_usd: sum(h.records, (r) => r.cost_usd),
      system_prompt_tokens: first?.system_prompt_tokens ?? null,
      tool_schema_tokens: first?.tool_schema_tokens ?? null,
      tool_count: first?.tool_count ?? null,
      side_turns: sideTurns(h.records),
      errors: h.records.filter((r) => r.error || (r.status && r.status >= 400)).length,
      overridden: h.records.filter((r) => r.overridden && Object.keys(r.overridden).length).length,
    };
  });
}

const capDir = (run, ...rest) => path.join(RESULTS, seg(run), "captures", ...rest.map(seg));
const blob = (run, id) => readJson(path.join(RESULTS, seg(run), "captures", "blobs", `${seg(id)}.json`));

const loadCall = (run, harness, task, seq) => {
  const dir = capDir(run, harness, task);
  const file = seq === "last" ? fs.readdirSync(dir).sort().pop() : `${String(seq).padStart(5, "0")}.json`;
  const c = readJson(path.join(dir, file));
  return {
    ...c,
    system: c.system_sha ? blob(run, c.system_sha) : "",
    tools: c.tools_sha ? blob(run, c.tools_sha) : [],
    messages: c.message_shas.map((id) => blob(run, id)),
  };
};

/** When a run's last task ended (runs.jsonl), so the order survives a fresh git checkout's mtimes. */
function lastRunEnd(run) {
  const file = path.join(RESULTS, run, "runs.jsonl");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  try {
    return JSON.parse(lines[lines.length - 1]).ended_epoch_ms ?? null;
  } catch {
    return null;
  }
}

export const routes = [
  [/^\/api\/runs$/, () =>
    dirs(RESULTS).filter((d) => fs.existsSync(path.join(RESULTS, d, "runs.jsonl")) || dirs(path.join(RESULTS, d, "captures")).length)
      .map((run) => ({
        run,
        harnesses: dirs(path.join(RESULTS, run)).filter((d) => d !== "captures"),
        captured: dirs(path.join(RESULTS, run, "captures")).filter((d) => d !== "blobs"),
        has_summary: fs.existsSync(path.join(RESULTS, run, "summary.md")),
        mtime: lastRunEnd(run) ?? fs.statSync(path.join(RESULTS, run)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)],

  [/^\/api\/runs\/([^/]+)$/, async ([run]) => {
    seg(run);
    const summaryMd = path.join(RESULTS, run, "summary.md");
    const harnesses = orderHarnesses(aggregate(await meterRecords(run)), (h) => h.harness);
    // The system prompt the first call of each harness sent, from the captures.
    for (const h of harnesses) {
      const tasks = dirs(capDir(run, h.harness));
      const t = tasks.sort()[0];
      if (!t) continue;
      // The main agent request, not a tool-less side call (e.g. a title generator) that may open the task.
      const calls = fs.readdirSync(capDir(run, h.harness, t)).sort().map((f) => readJson(path.join(capDir(run, h.harness, t), f)));
      const size = (x) => (x.tool_count ?? 0) * 1e6 + (x.system_chars ?? 0);
      const c = calls.reduce((best, x) => (size(x) > size(best) ? x : best), calls[0]);
      h.system_sha = c.system_sha;
      h.system_chars = c.system_chars;
      h.sample_task = t;
      h.sample_seq = c.seq;
    }
    return {
      run,
      harnesses,
      summary_md: fs.existsSync(summaryMd) ? fs.readFileSync(summaryMd, "utf8") : null,
    };
  }],

  // Per-task outcome matrix from the committed artifacts (grade.json + result.json), so a run
  // stays browsable where the raw request captures are absent (they never leave the bench host).
  [/^\/api\/runs\/([^/]+)\/outcomes$/, ([run]) => {
    const root = path.join(RESULTS, seg(run));
    const harnesses = orderHarnesses(dirs(root).filter((d) => d !== "captures"), (h) => h);
    const tasks = new Set();
    const cells = {};
    for (const h of harnesses) {
      const gradeFile = path.join(root, h, "grade.json");
      const grade = fs.existsSync(gradeFile) ? readJson(gradeFile) : {};
      for (const t of dirs(path.join(root, h))) {
        const resFile = path.join(root, h, t, "result.json");
        if (!fs.existsSync(resFile)) continue;
        const r = readJson(resFile);
        tasks.add(t);
        cells[`${h}/${t}`] = {
          resolved: grade[t]?.resolved ?? null,
          empty_patch: grade[t]?.empty_patch ?? r.patch_bytes === 0,
          error: (grade[t]?.error ?? false) || (r.exit_code != null && r.exit_code !== 0),
          timed_out: r.timed_out ?? false,
          wall_ms: r.wall_ms ?? null,
          patch_bytes: r.patch_bytes ?? null,
        };
      }
    }
    return { harnesses, tasks: [...tasks].sort(), cells };
  }],

  [/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)$/, ([run, harness]) =>
    dirs(capDir(run, harness)).map((task) => ({
      task,
      calls: fs.readdirSync(capDir(run, harness, task)).length,
    }))],

  [/^\/api\/runs\/([^/]+)\/calls\/([^/]+)\/([^/]+)$/, ([run, harness, task]) => {
    const d = capDir(run, harness, task);
    const full = fs.readdirSync(d).sort().map((f) => readJson(path.join(d, f)));
    // Label each turn main / side N from its system prompt + tool list (tools dominate the size tie-break).
    const { contexts } = classify(full.map((c) => ({
      context: `${c.system_sha}.${c.tools_sha}`,
      system_prompt_tokens: (c.system_chars ?? 0) / 3,
      tool_schema_tokens: (c.tool_count ?? 0) * 1000,
    })));
    return full.map((c) => {
      // Per-call summary only; the heavy fields stay on disk until a call is opened.
      const { response, params, headers, message_shas, ...rest } = c;
      return { ...rest, messages: message_shas.length, agent: contexts.get(`${c.system_sha}.${c.tools_sha}`)?.label ?? "main" };
    });
  }],

  [/^\/api\/runs\/([^/]+)\/call\/([^/]+)\/([^/]+)\/(\d+)$/, ([run, harness, task, seq]) => loadCall(run, harness, task, seq)],

  // Raw transcript as Markdown; `last` is the final call, i.e. the whole conversation of the task.
  [/^\/api\/runs\/([^/]+)\/transcript\/([^/]+)\/([^/]+)\/(\d+|last)$/, ([run, harness, task, seq]) =>
    ({ markdown: toMarkdown(loadCall(run, harness, task, seq)) })],

  // Two harnesses' system prompts side by side.
  [/^\/api\/runs\/([^/]+)\/prompt\/([^/]+)$/, ([run, sha]) => ({ text: blob(run, sha) })],
];


/** Resolve one API path to its JSON value; throws {code: 404} when no route matches. */
export async function handle(pathname) {
  for (const [re, fn] of routes) {
    const m = pathname.match(re);
    if (m) return fn(m.slice(1).map(decodeURIComponent));
  }
  throw Object.assign(new Error("not found"), { code: "ENOENT" });
}
