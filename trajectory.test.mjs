import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { conversation, gaps, setResults, toolError } from "./trajectory.mjs";

test("gaps attribute the time between calls to the preceding call's tools", () => {
  // `at` is when a call started, so the gap to the next start minus this
  // call's own duration is how long its tools ran. This is the only source of
  // tool durations: nothing records them directly.
  const rows = [
    { seq: 0, at: "2026-01-01T00:00:00.000Z", total_ms: 4_000, completion_tokens: 10 },
    { seq: 1, at: "2026-01-01T00:00:14.000Z", total_ms: 2_000, completion_tokens: 20 },
    { seq: 2, at: "2026-01-01T00:00:16.000Z", total_ms: 1_000, completion_tokens: 30 },
  ];
  assert.deepEqual(gaps(rows), [
    { seq: 0, model_s: 4, tools_s: 10, out: 10 },
    { seq: 1, model_s: 2, tools_s: 0, out: 20 },
    // The last call has no successor, so its tool time is unknown, not zero.
    { seq: 2, model_s: 1, tools_s: null, out: 30 },
  ]);
});

test("gaps sort by sequence, not by file order", () => {
  const rows = [
    { seq: 1, at: "2026-01-01T00:00:10.000Z", total_ms: 1_000 },
    { seq: 0, at: "2026-01-01T00:00:00.000Z", total_ms: 1_000 },
  ];
  assert.deepEqual(
    gaps(rows).map((r) => r.seq),
    [0, 1],
  );
  assert.equal(gaps(rows)[0].tools_s, 9);
});

test("toolError recognises a refused call, not ordinary output that mentions errors", () => {
  assert.ok(toolError("invalid arguments for tool `apply_patch`: validation error: ..."));
  assert.ok(toolError("expected `,` or `]` at line 1 column 11063"));
  assert.ok(toolError("validation error: arguments.edits is required"));
  assert.ok(!toolError("make: *** [all] Error 1\ncompilation failed"));
  assert.ok(!toolError("=== postfix_lmtp ===\n# AUTOMATICALLY GENERATED"));
});

test("conversation keeps each message once, in first-seen order, across retries", () => {
  // A retry re-sends the identical transcript and the truncated-empty recovery
  // pops a row first, so the same sha appears in many calls. The history is the
  // union in order -- including a row a later call dropped.
  const run = "r";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traj-"));
  const blobDir = path.join(dir, run, "captures", "blobs");
  fs.mkdirSync(blobDir, { recursive: true });
  for (const [sha, body] of Object.entries({ a: { role: "user" }, b: { role: "assistant" }, c: { role: "tool" } })) {
    fs.writeFileSync(path.join(blobDir, `${sha}.json`), JSON.stringify(body));
  }
  setResults(dir);
  try {
    const calls = [
      { seq: 0, message_shas: ["a"] },
      { seq: 1, message_shas: ["a", "b"] },
      { seq: 2, message_shas: ["a", "b"] }, // identical retry
      { seq: 3, message_shas: ["a", "c"] }, // `b` was popped
    ];
    assert.deepEqual(
      conversation(run, calls).map((m) => [m.sha, m.seq, m.role]),
      [
        ["a", 0, "user"],
        ["b", 1, "assistant"],
        ["c", 3, "tool"],
      ],
    );
  } finally {
    setResults(process.env.BENCH_RESULTS ?? "results");
  }
});

test("a message whose blob is missing is skipped, not rendered as null", () => {
  const run = "r";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traj-"));
  fs.mkdirSync(path.join(dir, run, "captures", "blobs"), { recursive: true });
  setResults(dir);
  try {
    assert.deepEqual(conversation(run, [{ seq: 0, message_shas: ["gone"] }]), []);
  } finally {
    setResults(process.env.BENCH_RESULTS ?? "results");
  }
});
