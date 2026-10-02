import assert from "node:assert/strict";
import test from "node:test";
import { assembleResponse, toMarkdown } from "./transcript.mjs";

const call = {
  run_id: "r", harness: "h", task: "t", seq: 3, format: "chat", status: 200, tool_count: 1,
  same_system_as_prev: true, same_tools_as_prev: true, prefix_reused_messages: 2, prev_messages: 2,
  params: { temperature: 0 }, system: "You are ``` tricky.", tools: [{ type: "function", function: { name: "shell" } }],
  messages: [
    { role: "user", content: "run ls" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "a.txt" },
  ],
  response:
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\ndata: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n',
};

test("transcript is verbatim, fenced safely, and includes tool calls and results", () => {
  const md = toMarkdown(call);
  assert.match(md, /### 1\. user\n\n```text\nrun ls\n```/);
  assert.match(md, /### 3\. tool \(answers c1\)/);
  assert.match(md, /"name": "shell"/);
  // a system prompt containing ``` gets a longer fence, so it cannot terminate early
  assert.match(md, /````text\nYou are ``` tricky\.\n````/);
  assert.match(md, /reasoning:\n\n```text\nthink/);
  assert.match(md, /```text\ndone\n```/);
});

test("assembleResponse stitches streamed tool call arguments", () => {
  const a = assembleResponse(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"sh","arguments":"{\\"a\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n',
  );
  assert.deepEqual(a.tool_calls, [{ id: "c9", name: "sh", arguments: '{"a":1}' }]);
});
