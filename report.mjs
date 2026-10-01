#!/usr/bin/env node
// report.mjs — merge meter.jsonl, per-task result.json and (for SWE runs)
// grade.json into results/<run-id>/summary.{json,md}.
//   node report.mjs --run-id ID

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

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
export function aggregate(meter, tasks) {
  const harnesses = [...new Set(tasks.map((t) => t.harness))];
  const out = {};
  for (const harness of harnesses) {
    const mine = tasks.filter((t) => t.harness === harness);
    const calls = meter.filter((r) => r.harness === harness);
    const ok = calls.filter((r) => r.status >= 200 && r.status < 300);

    const firstCalls = mine
      .map((t) => calls.find((r) => r.task === t.task_key && r.system_prompt_tokens != null))
      .filter(Boolean);
    const coldStart = mine
      .map((t) => {
        const first = calls.find((r) => r.task === t.task_key);
        return first && t.result ? Date.parse(first.at) - t.result.started_epoch_ms : null;
      })
      .filter((x) => typeof x === "number");

    const prompt = sum(ok.map((r) => r.prompt_tokens));
    const cached = sum(ok.map((r) => r.cached_tokens));
    const cost = sum(calls.map((r) => r.cost_usd));
    const unpriced = calls.filter((r) => r.cost_usd == null).length;

    const passed = mine.filter((t) => t.result?.check?.passed).length;
    const resolved = mine.filter((t) => t.grade?.resolved).length;
    const graded = mine.filter((t) => t.grade).length;
    const nonEmptyPatch = mine.filter((t) => (t.result?.patch_bytes ?? 0) > 0).length;

    out[harness] = {
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
      prompt_tokens: prompt,
      completion_tokens: sum(ok.map((r) => r.completion_tokens)),
      cache_pct: prompt ? (100 * cached) / prompt : null,
      cost_usd: cost,
      cost_unpriced_calls: unpriced,
      cost_per_task_usd: mine.length ? cost / mine.length : null,
      cost_per_resolved_usd: resolved ? cost / resolved : null,
      ttft_ms_p50: percentile(ok.map((r) => r.first_token_ms), 50),
      ttft_ms_p95: percentile(ok.map((r) => r.first_token_ms), 95),
      call_latency_ms_p50: percentile(ok.map((r) => r.total_ms), 50),
      task_wall_s_p50: percentile(mine.map((t) => (t.result ? t.result.wall_ms / 1000 : null)), 50),
      cold_start_ms_p50: percentile(coldStart, 50),
      cpu_seconds_mean: mean(mine.map((t) => t.result?.resources?.cpu_seconds)),
      avg_cpu_cores_mean: mean(mine.map((t) => t.result?.resources?.avg_cpu_cores)),
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

const f = (v, d = 0) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
const money = (v) => (v === null || v === undefined ? "-" : `$${Number(v).toFixed(4)}`);

export function toMarkdown(meta, summary) {
  const names = Object.keys(summary);
  const rows = [
    ["resolved (SWE) / checks passed", (s) => (s.swe_resolved === null ? `${s.check_passed}/${s.tasks} checks` : `${s.swe_resolved}/${s.swe_graded} resolved`)],
    ["patch produced", (s) => `${s.patch_produced}/${s.tasks}`],
    ["harness errors / timeouts", (s) => `${s.harness_errors} / ${s.timeouts}`],
    ["system prompt tokens", (s) => f(s.system_prompt_tokens)],
    ["tool schema tokens (count)", (s) => `${f(s.tool_schema_tokens)} (${f(s.tool_count)})`],
    ["cost / task", (s) => money(s.cost_per_task_usd)],
    ["cost / resolved", (s) => money(s.cost_per_resolved_usd)],
    ["total cost", (s) => `${money(s.cost_usd)}${s.cost_unpriced_calls ? ` (+${s.cost_unpriced_calls} unpriced)` : ""}`],
    ["cache hit %", (s) => f(s.cache_pct, 1)],
    ["TTFT p50 / p95 (ms)", (s) => `${f(s.ttft_ms_p50)} / ${f(s.ttft_ms_p95)}`],
    ["LLM call latency p50 (ms)", (s) => f(s.call_latency_ms_p50)],
    ["task wall p50 (s)", (s) => f(s.task_wall_s_p50, 1)],
    ["cold start to first call p50 (ms)", (s) => f(s.cold_start_ms_p50)],
    ["CPU-seconds / task", (s) => f(s.cpu_seconds_mean, 1)],
    ["avg CPU cores", (s) => f(s.avg_cpu_cores_mean, 2)],
    ["peak RAM max (MB)", (s) => f(s.peak_mem_mb_max)],
    ["avg RAM (MB)", (s) => f(s.avg_mem_mb_mean)],
    ["LLM calls (errors)", (s) => `${s.llm_calls} (${s.llm_call_errors})`],
    ["prompt / completion tokens", (s) => `${s.prompt_tokens} / ${s.completion_tokens}`],
  ];
  const head = `| metric | ${names.join(" | ")} |\n|---|${names.map(() => "---").join("|")}|`;
  const body = rows.map(([label, fn]) => `| ${label} | ${names.map((n) => fn(summary[n])).join(" | ")} |`).join("\n");
  return [
    `# Harness benchmark: ${meta.run_id}`,
    "",
    `model \`${meta.model}\`, reasoning \`${meta.reasoning}\`, ${meta.cpus} vCPU / ${meta.mem} per task, suite \`${meta.suite}\`.`,
    "",
    head,
    body,
    "",
    "Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container (memory includes page cache). Cache % = cached / prompt tokens across all calls.",
    "",
  ].join("\n");
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
  const index = readJsonl(path.join(runDir, "runs.jsonl"));
  const meter = readJsonl(path.join(here, "results", "meter.jsonl")).filter((r) => r.run_id === runId);

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

  const summary = aggregate(meter, tasks);
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
