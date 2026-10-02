import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "./contexts.mjs";

const rec = (context, calls = 1, over = {}) =>
  Array.from({ length: calls }, () => ({ context, system_prompt_tokens: 100, tool_schema_tokens: 50, ...over }));

test("the context with the most calls is main; others are numbered side contexts", () => {
  const calls = [...rec("title", 1, { tool_schema_tokens: 0 }), ...rec("agent", 4), ...rec("sub", 2)];
  const { main, contexts } = classify(calls);
  assert.equal(main, "agent");
  assert.equal(contexts.get("title").label, "side 1");
  assert.equal(contexts.get("sub").label, "side 2");
  assert.equal(contexts.get("agent").label, "main");
});

test("a tie goes to the larger static prompt, so a tool-less title call never wins", () => {
  const calls = [...rec("title", 1, { tool_schema_tokens: 0, system_prompt_tokens: 500 }), ...rec("agent", 1, { tool_schema_tokens: 3000 })];
  assert.equal(classify(calls).main, "agent");
});

test("records without a context id fall back to their measured sizes", () => {
  const calls = [{ system_prompt_tokens: 5, tool_schema_tokens: 0, tool_count: 0 }, { system_prompt_tokens: 9, tool_schema_tokens: 70, tool_count: 3 }, { system_prompt_tokens: 9, tool_schema_tokens: 70, tool_count: 3 }];
  const { contexts } = classify(calls);
  assert.equal(contexts.size, 2);
});

test("unsized legacy records continue the previous call's context instead of forming a new one", () => {
  const calls = [{ system_prompt_tokens: 100, tool_schema_tokens: 50, tool_count: 2 }, {}, {}, {}];
  const { contexts } = classify(calls);
  assert.equal(contexts.size, 1);
});
