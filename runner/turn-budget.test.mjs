import assert from "node:assert/strict";
import test from "node:test";
import { turnTimeoutSecs } from "./turn-budget.mjs";

test("task budget minus the margin", () => {
  assert.equal(turnTimeoutSecs({ TASK_TIMEOUT_S: "3600" }), "3480");
  assert.equal(turnTimeoutSecs({ BENCH_TURN_BUDGET_S: "900", TASK_TIMEOUT_S: "86400" }), "780");
  assert.equal(turnTimeoutSecs({ TASK_TIMEOUT_S: "3600", BENCH_TURN_MARGIN_S: "300" }), "3300");
});

test("an explicit setting wins, including 0 (no ceiling); empty means unset", () => {
  assert.equal(turnTimeoutSecs({ OPENHUMAN_AGENT_TURN_TIMEOUT_SECS: "0", TASK_TIMEOUT_S: "3600" }), "0");
  assert.equal(turnTimeoutSecs({ OPENHUMAN_AGENT_TURN_TIMEOUT_SECS: "", TASK_TIMEOUT_S: "3600" }), "3480");
});

test("a short budget keeps at least half; no budget leaves the default", () => {
  assert.equal(turnTimeoutSecs({ TASK_TIMEOUT_S: "150" }), "75");
  assert.equal(turnTimeoutSecs({}), null);
});
