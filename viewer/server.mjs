#!/usr/bin/env node
// server.mjs — a small read-only web UI over results/: runs, per-harness
// aggregates, the system prompt each harness actually sent (captured by the
// meter proxy), tool schemas, per-call cache diagnostics, and responses.
//
//   node viewer/server.mjs [--port 8787] [--results ./results]
//
// No dependencies, binds to loopback, reads files on demand (nothing is held
// in memory beyond the request being served) so it stays out of the way of a
// running benchmark.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { orderHarnesses } from "../format.mjs";
import { toMarkdown } from "./transcript.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const RESULTS = path.resolve(flag("--results", path.join(here, "..", "results")));
const PORT = Number(flag("--port", process.env.VIEWER_PORT ?? 8787));

const SEG = /^[A-Za-z0-9._#@=-]+$/;
const seg = (s) => {
  if (!SEG.test(s) || s === "." || s === "..") throw Object.assign(new Error("bad path"), { code: 400 });
  return s;
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const dirs = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/** Meter records for one run, streamed so a large meter.jsonl is never loaded whole. */
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
  return out;
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);

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

const routes = [
  [/^\/api\/runs$/, () =>
    dirs(RESULTS).filter((d) => fs.existsSync(path.join(RESULTS, d, "runs.jsonl")) || dirs(path.join(RESULTS, d, "captures")).length)
      .map((run) => ({
        run,
        harnesses: dirs(path.join(RESULTS, run)).filter((d) => d !== "captures"),
        captured: dirs(path.join(RESULTS, run, "captures")).filter((d) => d !== "blobs"),
        has_summary: fs.existsSync(path.join(RESULTS, run, "summary.md")),
        mtime: fs.statSync(path.join(RESULTS, run)).mtimeMs,
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
      const first = fs.readdirSync(capDir(run, h.harness, t)).sort()[0];
      const c = readJson(path.join(capDir(run, h.harness, t), first));
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

  [/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)$/, ([run, harness]) =>
    dirs(capDir(run, harness)).map((task) => ({
      task,
      calls: fs.readdirSync(capDir(run, harness, task)).length,
    }))],

  [/^\/api\/runs\/([^/]+)\/calls\/([^/]+)\/([^/]+)$/, ([run, harness, task]) => {
    const d = capDir(run, harness, task);
    return fs.readdirSync(d).sort().map((f) => {
      const c = readJson(path.join(d, f));
      // Per-call summary only; the heavy fields stay on disk until a call is opened.
      const { response, params, headers, message_shas, ...rest } = c;
      return { ...rest, messages: message_shas.length };
    });
  }],

  [/^\/api\/runs\/([^/]+)\/call\/([^/]+)\/([^/]+)\/(\d+)$/, ([run, harness, task, seq]) => loadCall(run, harness, task, seq)],

  // Raw transcript as Markdown; `last` is the final call, i.e. the whole conversation of the task.
  [/^\/api\/runs\/([^/]+)\/transcript\/([^/]+)\/([^/]+)\/(\d+|last)$/, ([run, harness, task, seq]) =>
    ({ markdown: toMarkdown(loadCall(run, harness, task, seq)) })],

  // Two harnesses' system prompts side by side.
  [/^\/api\/runs\/([^/]+)\/prompt\/([^/]+)$/, ([run, sha]) => ({ text: blob(run, sha) })],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    if (req.method !== "GET") return send(405, { error: "read-only" });
    if (url.pathname === "/format.mjs") {
      return send(200, fs.readFileSync(path.join(here, "..", "format.mjs"), "utf8"), "text/javascript; charset=utf-8");
    }
    if (url.pathname === "/favicon.ico") return send(204, "", "image/x-icon");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(200, fs.readFileSync(path.join(here, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    for (const [re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m) {
        const out = await fn(m.slice(1).map(decodeURIComponent));
        // ?format=md serves the transcript as a plain Markdown document (curl / download).
        if (url.searchParams.get("format") === "md" && out.markdown) return send(200, out.markdown, "text/markdown; charset=utf-8");
        return send(200, out);
      }
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(e.code === 400 ? 400 : e.code === "ENOENT" ? 404 : 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`[viewer] http://127.0.0.1:${PORT}  results=${RESULTS}\n`);
});
