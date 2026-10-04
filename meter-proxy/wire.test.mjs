import assert from "node:assert/strict";
import test from "node:test";
import { computeCost } from "./pricing.mjs";
import {
  FORMATS,
  createFirstTokenTracker,
  detectFormat,
  extractPromptParts,
  parseResponse,
  rewriteRequest,
  isPassthrough,
  upstreamRoute,
} from "./wire.mjs";

test("detectFormat recognises the three inference routes only", () => {
  assert.equal(detectFormat("POST", "/v1/chat/completions"), FORMATS.CHAT);
  assert.equal(detectFormat("POST", "/chat/completions?x=1"), FORMATS.CHAT);
  assert.equal(detectFormat("POST", "/v1/messages"), FORMATS.ANTHROPIC);
  assert.equal(detectFormat("POST", "/v1/responses"), FORMATS.RESPONSES);
  assert.equal(detectFormat("GET", "/v1/chat/completions"), null);
  assert.equal(detectFormat("POST", "/v1/messages/count_tokens"), null);
});

test("upstreamRoute adds the /v1 prefix only when missing", () => {
  assert.equal(upstreamRoute("/v1/messages"), "/v1/messages");
  assert.equal(upstreamRoute("/chat/completions"), "/v1/chat/completions");
  assert.equal(upstreamRoute("/responses?a=b"), "/v1/responses?a=b");
});

test("rewriteRequest pins model and one reasoning knob, reports overrides", () => {
  const { body, overridden } = rewriteRequest(
    FORMATS.CHAT,
    { model: "gpt-x", stream: true, reasoning_effort: "high", messages: [] },
    { model: "deepseek/deepseek-v4-flash", effort: "medium" },
  );
  assert.equal(body.model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.usage.include, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(overridden.model, "gpt-x");
  assert.equal(overridden.reasoning, "high");
});

test("rewriteRequest drops Anthropic thinking and does not add stream_options", () => {
  const { body } = rewriteRequest(
    FORMATS.ANTHROPIC,
    { model: "m", thinking: { type: "enabled", budget_tokens: 9000 }, stream: true },
    { model: "p", effort: "medium" },
  );
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream_options, undefined);
  assert.deepEqual(body.reasoning, { effort: "medium" });
});

test("parseResponse chat SSE: usage, cached tokens, cost, provider", () => {
  const sse = [
    'data: {"provider":"GMICloud","choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"cost":0.0004,"prompt_tokens_details":{"cached_tokens":800}}}',
    "data: [DONE]",
  ].join("\n");
  const u = parseResponse(FORMATS.CHAT, sse);
  assert.equal(u.provider, "GMICloud");
  assert.equal(u.prompt_tokens, 1000);
  assert.equal(u.cached_tokens, 800);
  assert.equal(u.completion_tokens, 50);
  assert.equal(u.cost_usd, 0.0004);
});

test("parseResponse anthropic folds cache read/write into the whole prompt", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":700,"cache_creation_input_tokens":200}}}',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":42}}',
  ].join("\n");
  const u = parseResponse(FORMATS.ANTHROPIC, sse);
  assert.equal(u.prompt_tokens, 1000);
  assert.equal(u.cached_tokens, 700);
  assert.equal(u.cache_write_tokens, 200);
  assert.equal(u.completion_tokens, 42);
});

test("parseResponse responses: completed event and unary body", () => {
  const sse =
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":500,"output_tokens":20,"input_tokens_details":{"cached_tokens":400}}}}';
  const u = parseResponse(FORMATS.RESPONSES, sse);
  assert.equal(u.prompt_tokens, 500);
  assert.equal(u.cached_tokens, 400);

  const unary = JSON.stringify({
    usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
  });
  assert.equal(parseResponse(FORMATS.RESPONSES, unary).prompt_tokens, 10);
});

test("parseResponse surfaces upstream errors and tolerates truncation", () => {
  const u = parseResponse(
    FORMATS.CHAT,
    'data: {"error":{"message":"rate limited"}}\ndata: {"choi',
  );
  assert.equal(u.error, "rate limited");
  assert.equal(u.prompt_tokens, null);
});

test("first-token tracker works across chunk boundaries", () => {
  const t = createFirstTokenTracker(FORMATS.CHAT, 1000);
  t.observe(Buffer.from('data: {"choices":[{"delta":{"reasoning":"'), 1100);
  t.observe(Buffer.from('think"}}]}\n'), 1200);
  t.observe(Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}'), 1500);
  const r = t.result();
  assert.equal(r.first_token_ms, 200);
  assert.equal(r.first_content_ms, 500);
});

test("extractPromptParts separates system prompt from tool schemas", () => {
  const chat = extractPromptParts(FORMATS.CHAT, {
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "bash" } }],
  });
  assert.equal(chat.system, "be brief");
  assert.equal(chat.tool_count, 1);
  assert.ok(chat.tools.includes("bash"));

  const anth = extractPromptParts(FORMATS.ANTHROPIC, {
    system: [{ type: "text", text: "sys A" }, { type: "text", text: "sys B" }],
    tools: [],
  });
  assert.equal(anth.system, "sys A\nsys B");
  assert.equal(anth.tools, "[]");
});

test("computeCost discounts cached tokens and never reports unpriced as free", () => {
  const pricing = { prompt: 1e-6, completion: 2e-6, cache_read: 1e-7, cache_write: null };
  const cost = computeCost(pricing, {
    prompt_tokens: 1000,
    completion_tokens: 100,
    cached_tokens: 800,
    cache_write_tokens: 0,
  });
  assert.ok(Math.abs(cost - (200 * 1e-6 + 800 * 1e-7 + 100 * 2e-6)) < 1e-12);
  assert.equal(computeCost(null, { prompt_tokens: 1, completion_tokens: 1 }), null);
  assert.equal(
    computeCost(pricing, { prompt_tokens: null, completion_tokens: 1 }),
    null,
  );
});

test("rewriteRequest pins the provider with no fallbacks and reports a harness preference it overrode", () => {
  const { body, overridden } = rewriteRequest(
    "chat",
    { model: "x", messages: [], provider: { order: ["Other"], allow_fallbacks: true } },
    { model: "m", effort: "medium", provider: "GMICloud" },
  );
  assert.deepEqual(body.provider, { order: ["GMICloud"], allow_fallbacks: false });
  assert.deepEqual(overridden.provider, { order: ["Other"], allow_fallbacks: true });
  const unpinned = rewriteRequest("chat", { model: "m", messages: [] }, { model: "m", effort: "medium" });
  assert.equal(unpinned.body.provider, undefined);
});

test("a passthrough model keeps its model, reasoning and provider; others are still pinned", () => {
  const pin = { model: "deepseek/deepseek-v4-flash", effort: "medium", provider: "DeepSeek", passthrough: ["qwen/qwen3.5-flash-02-23"] };
  for (const sent of ["openrouter/qwen/qwen3.5-flash-02-23", "qwen/qwen3.5-flash-02-23"]) {
    const r = rewriteRequest(FORMATS.CHAT, { model: sent, stream: true, messages: [] }, pin);
    assert.equal(r.passthrough, true);
    assert.equal(r.body.model, sent);
    assert.equal(r.body.reasoning, undefined);
    assert.equal(r.body.provider, undefined);
    assert.equal(r.body.usage.include, true);
    assert.equal(r.body.stream_options.include_usage, true);
    assert.deepEqual(r.overridden, {});
  }
  const main = rewriteRequest(FORMATS.CHAT, { model: "gpt-x", messages: [] }, pin);
  assert.equal(main.passthrough, undefined);
  assert.equal(main.body.model, "deepseek/deepseek-v4-flash");
  assert.equal(isPassthrough("x", []), false);
  assert.equal(isPassthrough(undefined, ["x"]), false);
});
