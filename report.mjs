#!/usr/bin/env node
// report.mjs — merge meter.jsonl, per-task result.json and (for SWE runs)
// grade.json into results/<run-id>/summary.{json,md}.
//   node report.mjs --run-id ID

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Retired variants stay on disk for the record but are left out of the tables and charts. */
export const ARCHIVED = ["openhuman-python"];

export function percentile(values, p) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number");
  return v.length ? sum(v) / v.length : null;
};

/**
 * @param meter   parsed meter.jsonl rows for ONE run
 * @param tasks   [{harness, task_key, task, result, grade}] one per executed task
 * @returns       {[harness]: metrics}
 */
/**
 * The request that carries a task's real static prompt: the call with the largest system prompt
 * plus tool schemas. Usually the first call, but some harnesses open with a small tool-less side
 * request (OpenCode's title generator), which would otherwise read as "no tools".
 */
export function mainRequest(calls, taskKey) {
  const { main, contexts } = classify(calls.filter((r) => r.task === taskKey));
  return contexts.get(main)?.calls.find((r) => r.system_prompt_tokens != null) ?? null;
}

/** Calls of a harness that are not its main agent: side requests and sub-agents, per task. */
function sideCalls(calls, taskKeys) {
  return taskKeys.flatMap((t) => {
    const { main, contexts } = classify(calls.filter((r) => r.task === t));
    return [...contexts.values()].filter((c) => c.id !== main).flatMap((c) => c.calls);
  });
}

export function aggregate(meter, tasks) {
  const harnesses = [...new Set(tasks.map((t) => t.harness))];
  const out = {};
  for (const harness of harnesses) {
    const mine = tasks.filter((t) => t.harness === harness);
    const calls = meter.filter((r) => r.harness === harness);
    const ok = calls.filter((r) => r.status >= 200 && r.status < 300);

    const firstCalls = mine.map((t) => mainRequest(calls, t.task_key)).filter(Boolean);
    const coldStart = mine
      .map((t) => {
        const first = calls.find((r) => r.task === t.task_key);
        return first && t.result ? Date.parse(first.at) - t.result.started_epoch_ms : null;
      })
      .filter((x) => typeof x === "number");

    const prompt = sum(ok.map((r) => r.prompt_tokens));
    const cached = sum(ok.map((r) => r.cached_tokens));
    const cost = sum(calls.map((r) => r.cost_usd));
    // A failed request is not billed, so only successful calls with no cost are "unpriced".
    const unpriced = ok.filter((r) => r.cost_usd == null).length;
    const side = sideCalls(calls, mine.map((t) => t.task_key));

    const passed = mine.filter((t) => t.result?.check?.passed).length;
    const resolved = mine.filter((t) => t.grade?.resolved).length;
    const graded = mine.filter((t) => t.grade).length;
    const nonEmptyPatch = mine.filter((t) => (t.result?.patch_bytes ?? 0) > 0).length;

    // "Solved" = resolved by the official grader on SWE runs, or the task's own check on the
    // micro suite. Per-task KPIs below are measured over solved tasks only, so a harness is
    // not credited for being fast or cheap at tasks it failed.
    const isSolved = (t) => (t.grade ? t.grade.resolved === true : t.result?.check?.passed === true);
    const solved = mine.filter(isSolved);
    const solvedKeys = new Set(solved.map((t) => t.task_key));
    const sCalls = ok.filter((r) => solvedKeys.has(r.task));
    const sPrompt = sum(sCalls.map((r) => r.prompt_tokens));
    const sCached = sum(sCalls.map((r) => r.cached_tokens));
    const sFirst = firstCalls.filter((r) => solvedKeys.has(r.task));
    const sColdStart = solved
      .map((t) => {
        const first = calls.find((r) => r.task === t.task_key);
        return first && t.result ? Date.parse(first.at) - t.result.started_epoch_ms : null;
      })
      .filter((x) => typeof x === "number");
    const sRes = (key) => solved.map((t) => t.result?.resources?.[key]).filter((x) => typeof x === "number");
    const solvedMetrics = {
      solved_tasks: solved.length,
      // Total spend (failed attempts included) divided by tasks solved: what a solved task costs.
      cost_per_solved_usd: solved.length ? cost / solved.length : null,
      tokens_per_solved: solved.length ? sum(ok.map((r) => (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0))) / solved.length : null,
      solved_static_prompt_tokens: percentile(sFirst.map((r) => (r.system_prompt_tokens ?? 0) + (r.tool_schema_tokens ?? 0)), 50),
      solved_cache_pct: sPrompt ? (100 * sCached) / sPrompt : null,
      solved_ttft_ms_p50: percentile(sCalls.map((r) => r.first_token_ms), 50),
      solved_call_latency_ms_p50: percentile(sCalls.map((r) => r.total_ms), 50),
      solved_task_wall_s_p50: percentile(solved.map((t) => (t.result ? t.result.wall_ms / 1000 : null)), 50),
      solved_cold_start_ms_p50: percentile(sColdStart, 50),
      solved_cpu_seconds_mean: mean(sRes("cpu_seconds")),
      solved_peak_anon_mb_max: sRes("peak_anon_bytes").length ? Math.max(...sRes("peak_anon_bytes")) / 1048576 : null,
    };

    out[harness] = {
      ...solvedMetrics,
      tasks: mine.length,
      check_passed: passed,
      swe_resolved: graded ? resolved : null,
      swe_graded: graded,
      patch_produced: nonEmptyPatch,
      harness_errors: mine.filter((t) => !t.result || t.result.exit_code !== 0 || t.result.timed_out).length,
      timeouts: mine.filter((t) => t.result?.timed_out).length,
      llm_calls: calls.length,
      llm_call_errors: calls.length - ok.length,
      system_prompt_tokens: percentile(firstCalls.map((r) => r.system_prompt_tokens), 50),
      tool_schema_tokens: percentile(firstCalls.map((r) => r.tool_schema_tokens), 50),
      tool_count: percentile(firstCalls.map((r) => r.tool_count), 50),
      // Harnesses differ in where the tool catalogue goes (API `tools` vs text inside
      // the system prompt), so the comparable number is the sum.
      static_prompt_tokens: percentile(
        firstCalls.map((r) => (r.system_prompt_tokens ?? 0) + (r.tool_schema_tokens ?? 0)),
        50,
      ),
      tokens_total: sum(calls.map((r) => (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0))),
      prompt_tokens: prompt,
      completion_tokens: sum(ok.map((r) => r.completion_tokens)),
      cache_pct: prompt ? (100 * cached) / prompt : null,
      cost_usd: cost,
      cost_unpriced_calls: unpriced,
      side_calls: side.length,
      side_tokens: sum(side.map((r) => (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0))),
      side_cost_usd: sum(side.map((r) => r.cost_usd)),
      side_failed_calls: side.filter((r) => !(r.status >= 200 && r.status < 300)).length,
      cost_per_task_usd: mine.length ? cost / mine.length : null,
      cost_per_resolved_usd: resolved ? cost / resolved : null,
      ttft_ms_p50: percentile(ok.map((r) => r.first_token_ms), 50),
      ttft_ms_p95: percentile(ok.map((r) => r.first_token_ms), 95),
      call_latency_ms_p50: percentile(ok.map((r) => r.total_ms), 50),
      task_wall_s_p50: percentile(mine.map((t) => (t.result ? t.result.wall_ms / 1000 : null)), 50),
      cold_start_ms_p50: percentile(coldStart, 50),
      cpu_seconds_mean: mean(mine.map((t) => t.result?.resources?.cpu_seconds)),
      avg_cpu_cores_mean: mean(mine.map((t) => t.result?.resources?.avg_cpu_cores)),
      peak_anon_mb_max: (() => {
        const v = mine.map((t) => t.result?.resources?.peak_anon_bytes).filter((x) => typeof x === "number");
        return v.length ? Math.max(...v) / 1048576 : null;
      })(),
      peak_mem_mb_max: (() => {
        const v = mine.map((t) => t.result?.resources?.peak_mem_bytes).filter((x) => typeof x === "number");
        return v.length ? Math.max(...v) / 1048576 : null;
      })(),
      avg_mem_mb_mean: (() => {
        const m = mean(mine.map((t) => t.result?.resources?.avg_mem_bytes));
        return m === null ? null : m / 1048576;
      })(),
    };
  }
  return out;
}

import { classify } from "./contexts.mjs";
import { count, mem, ms, orderHarnesses, pct, secs, usd } from "./format.mjs";

const f = (v, d = 0) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
const money = (v) => (v === null || v === undefined ? "-" : usd(v));

/**
 * Mark the harnesses for one metric. `better` is "low" or "high"; values that are not numbers
 * are skipped, and nothing is marked when fewer than two harnesses have a value or they all
 * tie. Ties share a mark: every harness on the top value is "best", every one on the next
 * distinct value is "runner" (when that is not also the worst), and the bottom value is "worst".
 * @returns {Array<"best"|"runner"|"worst"|null>} one entry per input value
 */
export function rankRow(values, better) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!better || nums.length < 2) return values.map(() => null);
  const distinct = [...new Set(nums)].sort((a, b) => (better === "low" ? a - b : b - a));
  if (distinct.length < 2) return values.map(() => null);
  const best = distinct[0];
  const worst = distinct[distinct.length - 1];
  const runner = distinct.length > 2 ? distinct[1] : null;
  return values.map((v) => (v === best ? "best" : v === worst ? "worst" : v === runner ? "runner" : null));
}

const rate = (num, den) => (den ? num / den : null);

export function toMarkdown(meta, summary) {
  const names = orderHarnesses(Object.keys(summary));
  // [label, display(s), raw(s) used for ranking, better: "low" | "high" | null]
  const rows = [
    ["resolved (SWE) / checks passed", (s) => (s.swe_resolved === null ? `${s.check_passed}/${s.tasks} checks` : `${s.swe_resolved}/${s.swe_graded} resolved`), (s) => (s.swe_resolved === null ? rate(s.check_passed, s.tasks) : rate(s.swe_resolved, s.swe_graded)), "high"],
    ["patch produced", (s) => `${s.patch_produced}/${s.tasks}`],
    ["harness errors / timeouts (all tasks)", (s) => `${s.harness_errors} / ${s.timeouts}`, (s) => s.harness_errors + s.timeouts, "low"],
    ["system prompt tokens", (s) => count(s.system_prompt_tokens), (s) => s.system_prompt_tokens, "low"],
    ["tool schema tokens (count)", (s) => `${count(s.tool_schema_tokens)} (${count(s.tool_count)})`, (s) => s.tool_schema_tokens, "low"],
    ["static prompt total (system + tools)", (s) => count(s.solved_static_prompt_tokens ?? s.static_prompt_tokens), (s) => s.solved_static_prompt_tokens ?? s.static_prompt_tokens, "low"],
    ["cost / solved task", (s) => money(s.cost_per_solved_usd), (s) => s.cost_per_solved_usd, "low"],
    ["tokens / solved task", (s) => count(s.tokens_per_solved), (s) => s.tokens_per_solved, "low"],
    ["total cost (all tasks)", (s) => `${money(s.cost_usd)}${s.cost_unpriced_calls ? ` (+${s.cost_unpriced_calls} unpriced)` : ""}`, (s) => s.cost_usd, "low"],
    ["cache hit % (solved tasks)", (s) => pct(s.solved_cache_pct), (s) => s.solved_cache_pct, "high"],
    ["TTFT p50 (solved tasks)", (s) => ms(s.solved_ttft_ms_p50), (s) => s.solved_ttft_ms_p50, "low"],
    ["LLM call latency p50 (solved tasks)", (s) => ms(s.solved_call_latency_ms_p50), (s) => s.solved_call_latency_ms_p50, "low"],
    ["task wall p50 (solved tasks)", (s) => secs(s.solved_task_wall_s_p50), (s) => s.solved_task_wall_s_p50, "low"],
    ["cold start to first call p50 (solved tasks)", (s) => ms(s.solved_cold_start_ms_p50), (s) => s.solved_cold_start_ms_p50, "low"],
    ["CPU time / solved task", (s) => secs(s.solved_cpu_seconds_mean), (s) => s.solved_cpu_seconds_mean, "low"],
    ["peak RAM, process memory (solved tasks)", (s) => mem(s.solved_peak_anon_mb_max), (s) => s.solved_peak_anon_mb_max, "low"],
    ["peak RAM incl. page cache (all tasks)", (s) => mem(s.peak_mem_mb_max), (s) => s.peak_mem_mb_max, "low"],
    ["avg RAM (all tasks)", (s) => mem(s.avg_mem_mb_mean), (s) => s.avg_mem_mb_mean, "low"],
    ["side / sub-agent calls (failed)", (s) => `${count(s.side_calls)} of ${count(s.llm_calls)} (${count(s.side_failed_calls)})`],
    ["side / sub-agent share of tokens", (s) => pct(s.tokens_total ? (100 * s.side_tokens) / s.tokens_total : null)],
    ["LLM calls (errors)", (s) => `${count(s.llm_calls)} (${count(s.llm_call_errors)})`],
    ["prompt / completion tokens", (s) => `${count(s.prompt_tokens)} / ${count(s.completion_tokens)}`],
  ];
  // Best is bold + 🟢, runner-up bold + 🟡, worst bold + 🔴: plain Markdown, so it reads in any renderer,
  // and the viewer turns the markers into green, yellow and red.
  const MARK = { best: "🟢", runner: "🟡", worst: "🔴" };
  const cell = (text, rank) => (rank ? `**${text}** ${MARK[rank]}` : text);
  const head = `| metric | ${names.join(" | ")} |\n|---|${names.map(() => "---").join("|")}|`;
  const body = rows
    .map(([label, fn, raw, better]) => {
      const ranks = rankRow(names.map((n) => (raw ? raw(summary[n]) : null)), better);
      return `| ${label} | ${names.map((n, k) => cell(fn(summary[n]), ranks[k])).join(" | ")} |`;
    })
    .join("\n");
  return [
    `# Harness benchmark: ${meta.run_id}`,
    "",
    `model \`${meta.model}\`, reasoning \`${meta.reasoning}\`, ${meta.cpus} vCPU / ${meta.mem} per task, suite \`${meta.suite}\`.`,
    "",
    head,
    body,
    "",
    "Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.",
    "",
  ].join("\n");
}

/**
 * A task re-run under the same run id (after fixing a driver bug, say) appends a
 * second index row and a second set of proxy records. Keep only the newest
 * attempt per (harness, task) so nothing is double counted.
 */
export function latestAttempts(index, meter) {
  const newest = new Map();
  for (const row of index) {
    const key = `${row.harness}/${row.task_key}`;
    if (!newest.has(key) || row.started_epoch_ms > newest.get(key).started_epoch_ms) newest.set(key, row);
  }
  return {
    index: [...newest.values()],
    meter: meter.filter((r) => {
      const row = newest.get(`${r.harness}/${r.task}`);
      return !row || Date.parse(r.at) >= row.started_epoch_ms;
    }),
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function main() {
  const args = process.argv.slice(2);
  const runId = args[args.indexOf("--run-id") + 1];
  if (!runId) throw new Error("--run-id is required");
  const runDir = path.join(here, "results", runId);
  const keep = (r) => args.includes("--include-archived") || !ARCHIVED.includes(r.harness);
  const { index, meter } = latestAttempts(
    readJsonl(path.join(runDir, "runs.jsonl")).filter(keep),
    readJsonl(path.join(here, "results", "meter.jsonl")).filter((r) => r.run_id === runId && keep(r)),
  );

  const tasks = index.map((row) => {
    const dir = path.join(runDir, row.harness, row.task_key);
    const read = (n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      } catch {
        return null;
      }
    };
    const grades = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runDir, row.harness, "grade.json"), "utf8"));
      } catch {
        return null;
      }
    })();
    return { ...row, result: read("result.json"), grade: grades?.[row.task] ?? null };
  });

  const aggregated = aggregate(meter, tasks);
  const summary = Object.fromEntries(orderHarnesses(Object.keys(aggregated)).map((n) => [n, aggregated[n]]));
  const meta = {
    run_id: runId,
    suite: [...new Set(index.map((r) => r.suite))].join(","),
    model: meter[0]?.model ?? process.env.BENCH_MODEL ?? "?",
    reasoning: meter[0]?.reasoning_effort ?? "?",
    cpus: process.env.BENCH_CPUS || "4",
    mem: process.env.BENCH_MEM || "8g",
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ meta, summary }, null, 2));
  const md = toMarkdown(meta, summary);
  fs.writeFileSync(path.join(runDir, "summary.md"), md);
  process.stdout.write(md);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
