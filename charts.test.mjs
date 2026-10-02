import assert from "node:assert/strict";
import test from "node:test";
import { METRICS, renderSvg } from "./charts.mjs";

const meta = { run_id: "r", suite: "swe", model: "m", reasoning: "medium", cpus: "4", mem: "8g" };
const row = (over) => ({
  tasks: 10, swe_resolved: 5, swe_graded: 10, check_passed: 0, cost_per_task_usd: 0.0123,
  cost_per_resolved_usd: 0.0246, static_prompt_tokens: 4500, cache_pct: 80, ttft_ms_p50: 1200,
  task_wall_s_p50: 60, cold_start_ms_p50: 300, cpu_seconds_mean: 2, peak_anon_mb_max: 100, ...over,
});

test("renders one panel per metric and one column per harness, with a star on the best", () => {
  const svg = renderSvg({ meta, summary: { openhuman: row({}), codex: row({ swe_resolved: 8 }) } });
  assert.match(svg, /^<svg /);
  for (const m of METRICS) assert.ok(svg.includes(m.title.replace(/&/g, "&amp;")), m.title);
  assert.equal((svg.match(/<path d="M/g) ?? []).length, METRICS.length * 2);
  assert.match(svg, /<polygon/);
});

test("lower-is-better metrics star the smallest value", () => {
  const svg = renderSvg(
    { meta, summary: { openhuman: row({ cpu_seconds_mean: 1 }), codex: row({ cpu_seconds_mean: 9 }) } },
    { only: ["cpu"] },
  );
  assert.equal((svg.match(/<polygon/g) ?? []).length, 1);
});

test("missing values render n/a instead of a zero-height column, and bad text is escaped", () => {
  const svg = renderSvg(
    { meta: { ...meta, model: "a<b&c" }, summary: { openhuman: row({ cost_per_resolved_usd: null }), codex: row({}) } },
    { only: ["cost_resolved"] },
  );
  assert.match(svg, />n\/a</);
  assert.ok(svg.includes("a&lt;b&amp;c"));
});

test("dark theme swaps the background", () => {
  const svg = renderSvg({ meta, summary: { openhuman: row({}) } }, { theme: "dark" });
  assert.match(svg, /fill="#0e1120"/);
});
