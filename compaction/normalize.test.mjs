import assert from "node:assert/strict";
import test from "node:test";
import { anthropicToChat, chatToChat, cutAt, normalizeTools, pickTrunk, toChat, validCuts } from "./normalize.mjs";

test("anthropic blocks become chat messages: tool_use -> tool_calls, tool_result -> role tool, thinking dropped", () => {
  const out = anthropicToChat([
    { role: "user", content: [{ type: "text", text: "<task>do it</task>" }] },
    { role: "system", content: "<total_tokens>100 tokens left</total_tokens>" },
    { role: "system", content: "# Environment\ncwd /app" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "" },
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/app/a.go" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "a.go" },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "package a" }, { type: "image", source: {} }] },
        { type: "text", text: "<system-reminder>note</system-reminder>" },
      ],
    },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "<task>do it</task>" },
    { role: "system", content: "# Environment\ncwd /app" },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        { id: "t2", type: "function", function: { name: "Read", arguments: '{"file_path":"/app/a.go"}' } },
      ],
    },
    { role: "tool", tool_call_id: "t1", content: "a.go" },
    { role: "tool", tool_call_id: "t2", content: "package a\n[image]" },
    { role: "user", content: "<system-reminder>note</system-reminder>" },
  ]);
});

test("chat messages keep only the canonical fields", () => {
  const out = chatToChat([
    { role: "assistant", content: null, reasoning_content: "x", tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
    { content: "ok", role: "tool", tool_call_id: "c", name: "bash" },
    { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
  ]);
  assert.deepEqual(out, [
    { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
    { role: "tool", tool_call_id: "c", content: "ok" },
    { role: "user", content: "a\nb" },
  ]);
});

test("toChat puts the system prompt first; tools normalize from both wire formats", () => {
  const msgs = toChat({ format: "anthropic", system: [{ type: "text", text: "You are X." }], messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(msgs[0], { role: "system", content: "You are X." });
  assert.deepEqual(normalizeTools([{ name: "Bash", description: "d", input_schema: { type: "object" } }]), [
    { type: "function", function: { name: "Bash", description: "d", parameters: { type: "object" } } },
  ]);
  assert.deepEqual(normalizeTools([{ function: { name: "read", parameters: { type: "object" }, description: "r" }, type: "function" }]), [
    { type: "function", function: { name: "read", description: "r", parameters: { type: "object" } } },
  ]);
});

const call = (id) => ({ id, type: "function", function: { name: "bash", arguments: "{}" } });
const convo = [
  { role: "system", content: "s" },
  { role: "user", content: "task" },
  { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
  { role: "tool", tool_call_id: "a", content: "1" },
  { role: "tool", tool_call_id: "b", content: "2" },
  { role: "assistant", content: "", tool_calls: [call("c")] },
  { role: "tool", tool_call_id: "c", content: "3" },
  { role: "assistant", content: "thinking aloud" },
  { role: "assistant", content: "", tool_calls: [call("d")] },
  { role: "tool", tool_call_id: "d", content: "4" },
  { role: "assistant", content: "done" },
];

test("valid cuts end right after a complete tool round and have an assistant action next", () => {
  const cuts = validCuts(convo);
  assert.deepEqual(cuts, [5, 7, 10]);
  for (const c of cuts) {
    assert.equal(convo[c - 1].role, "tool");
    assert.equal(convo[c].role, "assistant");
  }
  // never between a call and its results: index 4 (after only "a" answered) is not a cut
  assert.ok(!cuts.includes(4));
});

test("cutAt picks the valid cut nearest the requested fraction", () => {
  assert.equal(cutAt(convo, 0.1), 5);
  assert.equal(cutAt(convo, 0.9), 10);
  assert.equal(cutAt([{ role: "user", content: "x" }], 0.5), null);
});

const rec = (seq, shas, over = {}) => ({ seq, system_sha: "S", tools_sha: "T", tool_count: 5, message_shas: shas, ...over });

test("the trunk follows calls that extend it, tolerating a rewritten newest message", () => {
  const calls = [
    rec(0, ["u"]),
    rec(1, ["u", "a1", "r1x"]),
    rec(2, ["u", "a1", "r1", "a2", "r2x"]), // r1x was rewritten (cache marker) to r1
    rec(3, ["t"], { tools_sha: null, tool_count: 0 }), // title side call
    rec(4, ["u", "a1", "r1", "a2", "r2", "a3", "r3"]),
  ];
  const { tip, compacted } = pickTrunk(calls, "S.T");
  assert.equal(tip.seq, 4);
  assert.equal(compacted, false);
});

test("a compaction restart never extends the trunk, so the tip stays pre-compaction", () => {
  const calls = [rec(0, ["u", "a", "r", "a2", "r2"]), rec(1, ["u", "a", "r", "a2", "r2", "a3", "r3"]), rec(2, ["summary", "a3", "r3", "a4", "r4", "a5", "r5", "a6", "r6"])];
  const { tip, compacted } = pickTrunk(calls, "S.T");
  assert.equal(tip.seq, 1);
  assert.equal(compacted, true);
});

test("the trunk starts at an earlier system prompt carrying the same first message", () => {
  const calls = [rec(0, ["u"], { system_sha: "S0" }), rec(1, ["u", "a", "r"], { system_sha: "S0" }), rec(2, ["u", "a", "r", "a2", "r2"]), rec(3, ["u", "a", "r", "a2", "r2", "a3", "r3"])];
  assert.equal(pickTrunk(calls, "S.T").tip.seq, 3);
});
