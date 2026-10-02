import assert from "node:assert/strict";
import test from "node:test";
import { count, mem, ms, pct, secs, usd } from "./format.mjs";

test("count: commas under 10k, then k / M / B", () => {
  assert.equal(count(0), "0");
  assert.equal(count(9876), "9,876");
  assert.equal(count(10_000), "10.0k");
  assert.equal(count(248_845), "248.8k");
  assert.equal(count(2_400_000), "2.40M");
  assert.equal(count(3_100_000_000), "3.10B");
  assert.equal(count(null), "–");
});

test("mem: MB input to KB / MB / GB", () => {
  assert.equal(mem(0.4), "410 KB");
  assert.equal(mem(5.25), "5.3 MB");
  assert.equal(mem(351), "351 MB");
  assert.equal(mem(1536), "1.50 GB");
  assert.equal(mem(undefined), "–");
});

test("ms / secs: ms, s, then minutes", () => {
  assert.equal(ms(696), "696 ms");
  assert.equal(ms(1240), "1.24 s");
  assert.equal(ms(12_400), "12.4 s");
  assert.equal(ms(95_000), "1m 35s");
  assert.equal(secs(4.7), "4.70 s");
});

test("usd and pct", () => {
  assert.equal(usd(0.00184), "$0.0018");
  assert.equal(usd(1.5), "$1.50");
  assert.equal(pct(97.31), "97.3%");
});

import { orderHarnesses } from "./format.mjs";

test("orderHarnesses puts openhuman first, then the lineup, unknowns last", () => {
  assert.deepEqual(
    orderHarnesses(["hermes", "zeta", "codex", "openhuman", "claude-code", "alpha"]),
    ["openhuman", "claude-code", "codex", "hermes", "alpha", "zeta"],
  );
  assert.deepEqual(orderHarnesses([{ h: "codex" }, { h: "openhuman" }], (x) => x.h).map((x) => x.h), ["openhuman", "codex"]);
});
