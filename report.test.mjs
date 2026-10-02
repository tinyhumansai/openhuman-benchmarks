import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, latestAttempts, percentile, toMarkdown } from "./report.mjs";

const call = (over) => ({
  harness: "h", task: "t1", status: 200, at: "2026-01-01T00:00:01.000Z",
  prompt_tokens: 1000, cached_tokens: 500, completion_tokens: 10,
  cost_usd: 0.001, first_token_ms: 100, total_ms: 300, ...over,
});

test("percentile picks nearest-rank and ignores non-numbers", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([null, 5], 95), 5);
  assert.equal(percentile([], 50), null);
});

test("aggregate computes cache %, cost per resolved, cold start and resources", () => {
  const meter = [
    call({ system_prompt_tokens: 1200, tool_schema_tokens: 800, tool_count: 12 }),
    call({ cached_tokens: 900 }),
  ];
  const tasks = [
    {
      harness: "h", task_key: "t1", task: "t1",
      result: {
        started_epoch_ms: Date.parse("2026-01-01T00:00:00.000Z"),
        wall_ms: 5000, exit_code: 0, timed_out: false, patch_bytes: 10,
        resources: { cpu_seconds: 2, avg_cpu_cores: 0.5, peak_mem_bytes: 2 * 1048576, avg_mem_bytes: 1048576 },
        check: { passed: true },
      },
      grade: { resolved: true },
    },
  ];
  const s = aggregate(meter, tasks).h;
  assert.equal(s.cache_pct, (100 * 1400) / 2000);
  assert.equal(s.cost_per_resolved_usd, 0.002);
  assert.equal(s.cold_start_ms_p50, 1000);
  assert.equal(s.system_prompt_tokens, 1200);
  assert.equal(s.tool_count, 12);
  assert.equal(s.peak_mem_mb_max, 2);
  assert.equal(s.swe_resolved, 1);
  assert.equal(s.harness_errors, 0);
});

test("a task with no result counts as a harness error, and unpriced calls are surfaced", () => {
  const s = aggregate([call({ cost_usd: null })], [
    { harness: "h", task_key: "t1", task: "t1", result: null, grade: null },
  ]).h;
  assert.equal(s.harness_errors, 1);
  assert.equal(s.cost_unpriced_calls, 1);
  assert.equal(s.cost_per_resolved_usd, null);
});

test("toMarkdown renders one column per harness", () => {
  const md = toMarkdown(
    { run_id: "r", suite: "micro", model: "m", reasoning: "medium", cpus: "4", mem: "8g" },
    { a: aggregate([], [{ harness: "a", task_key: "t", task: "t", result: null, grade: null }]).a },
  );
  assert.match(md, /\| metric \| a \|/);
});

test("latestAttempts keeps only the newest attempt's index row and proxy records", () => {
  const index = [
    { harness: "h", task_key: "t", started_epoch_ms: 1000 },
    { harness: "h", task_key: "t", started_epoch_ms: 5000 },
  ];
  const meter = [
    { harness: "h", task: "t", at: new Date(2000).toISOString() },
    { harness: "h", task: "t", at: new Date(6000).toISOString() },
  ];
  const out = latestAttempts(index, meter);
  assert.equal(out.index.length, 1);
  assert.equal(out.index[0].started_epoch_ms, 5000);
  assert.equal(out.meter.length, 1);
});

test("per-task KPIs use only solved tasks; cost per solved task includes failed spend", () => {
  const meter = [
    // task a: solved, fast. task b: failed, slow and expensive.
    call({ task: "a", prompt_tokens: 1000, cached_tokens: 900, first_token_ms: 100, total_ms: 200, cost_usd: 0.01, system_prompt_tokens: 500, tool_schema_tokens: 0, tool_count: 0 }),
    call({ task: "b", prompt_tokens: 1000, cached_tokens: 0, first_token_ms: 9000, total_ms: 9000, cost_usd: 0.03 }),
  ];
  const result = (wall, cpu) => ({
    started_epoch_ms: Date.parse("2026-01-01T00:00:00.000Z"), wall_ms: wall, exit_code: 0, timed_out: false, patch_bytes: 1,
    resources: { cpu_seconds: cpu, peak_anon_bytes: cpu * 1048576 }, check: { passed: false },
  });
  const tasks = [
    { harness: "h", task_key: "a", task: "a", result: result(10_000, 2), grade: { resolved: true } },
    { harness: "h", task_key: "b", task: "b", result: result(90_000, 50), grade: { resolved: false } },
  ];
  const s = aggregate(meter, tasks).h;
  assert.equal(s.solved_tasks, 1);
  assert.equal(s.cost_per_solved_usd, 0.04); // all spend / 1 solved
  assert.equal(s.solved_cache_pct, 90);
  assert.equal(s.solved_ttft_ms_p50, 100);
  assert.equal(s.solved_task_wall_s_p50, 10);
  assert.equal(s.solved_cpu_seconds_mean, 2);
  assert.equal(s.solved_peak_anon_mb_max, 2);
  assert.equal(s.solved_static_prompt_tokens, 500);
});

test("a harness that solved nothing has null solved-task KPIs, not zeros", () => {
  const s = aggregate([call({})], [{ harness: "h", task_key: "t1", task: "t1", result: null, grade: { resolved: false } }]).h;
  assert.equal(s.cost_per_solved_usd, null);
  assert.equal(s.solved_cache_pct, null);
  assert.equal(s.solved_task_wall_s_p50, null);
});

import { rankRow } from "./report.mjs";

test("rankRow marks best and worst per direction, skips ties and single values", () => {
  assert.deepEqual(rankRow([3, 1, 2], "low"), ["worst", "best", null]);
  assert.deepEqual(rankRow([3, 1, 2], "high"), ["best", "worst", null]);
  assert.deepEqual(rankRow([5, 5], "low"), [null, null]);
  assert.deepEqual(rankRow([5, null], "low"), [null, null]);
  assert.deepEqual(rankRow([1, 1, 9], "low"), ["best", "best", "worst"]);
  assert.deepEqual(rankRow([1, 2], null), [null, null]);
});
