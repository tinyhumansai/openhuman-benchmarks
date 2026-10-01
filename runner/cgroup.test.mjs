import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "./cgroup.mjs";

test("summarize charges CPU between first and last sample, prefers kernel peak", () => {
  const out = summarize([
    { epoch_ms: 0, cpu_usec: 1_000_000, mem_bytes: 100, mem_peak_bytes: 100 },
    { epoch_ms: 1000, cpu_usec: 3_000_000, mem_bytes: 300, mem_peak_bytes: 900 },
    { epoch_ms: 2000, cpu_usec: 5_000_000, mem_bytes: 200, mem_peak_bytes: 900 },
  ]);
  assert.equal(out.cpu_seconds, 4);
  assert.equal(out.avg_cpu_cores, 2);
  assert.equal(out.peak_mem_bytes, 900);
  assert.equal(out.avg_mem_bytes, 200);
});

test("summarize reports null rather than zero when cgroup files were unreadable", () => {
  const out = summarize([{ epoch_ms: 0, cpu_usec: null, mem_bytes: null, mem_peak_bytes: null }]);
  assert.equal(out.cpu_seconds, null);
  assert.equal(out.peak_mem_bytes, null);
});
