import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProxy, splitTag } from "./proxy.mjs";

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

test("proxy pins model/reasoning, authenticates itself, tags and logs usage", async () => {
  let seen = null;
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = {
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.end(
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}\n\ndata: [DONE]\n\n',
      );
    });
  });
  const fakePort = await listen(fake);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meter-"));
  const logPath = path.join(dir, "meter.jsonl");
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${fakePort}/api`,
    model: "deepseek/deepseek-v4-flash",
    effort: "medium",
    apiKey: "real-key",
    logPath,
    pricing: { prompt: 1e-6, completion: 2e-6, cache_read: 1e-7, cache_write: null },
  });
  const port = await listen(proxy.server);
  const base = `http://127.0.0.1:${port}`;

  await fetch(`${base}/__bench/run`, {
    method: "POST",
    body: JSON.stringify({ run_id: "r1", harness: "demo", task: "t1" }),
  });
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer dummy", "content-type": "application/json" },
    body: JSON.stringify({
      model: "other",
      stream: true,
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "fix it" },
      ],
      tools: [{ type: "function", function: { name: "bash" } }],
    }),
  });
  assert.equal(res.status, 200);
  await res.text();

  assert.equal(seen.url, "/api/v1/chat/completions");
  assert.equal(seen.auth, "Bearer real-key");
  assert.equal(seen.body.model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(seen.body.reasoning, { effort: "medium" });

  const [record] = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(record.run_id, "r1");
  assert.equal(record.harness, "demo");
  assert.equal(record.task, "t1");
  assert.equal(record.prompt_tokens, 100);
  assert.equal(record.cached_tokens, 60);
  assert.equal(record.cost_source, "computed");
  assert.ok(record.cost_usd > 0);
  assert.ok(record.system_prompt_tokens > 0);
  assert.equal(record.tool_count, 1);
  assert.equal(record.overridden.model, "other");
  assert.ok(record.first_token_ms !== null);

  const runs = await (await fetch(`${base}/__bench/runs`)).json();
  assert.ok(runs["r1/demo/t1"].system_prompt_tokens > 0);

  proxy.server.close();
  fake.close();
});

test("splitTag reads and strips a per-request tag prefix", () => {
  assert.deepEqual(splitTag("/__tag/r%201/openhuman/a__b/v1/chat/completions"), {
    tag: { run_id: "r 1", harness: "openhuman", task: "a__b" },
    url: "/v1/chat/completions",
  });
  assert.deepEqual(splitTag("/v1/chat/completions"), { tag: null, url: "/v1/chat/completions" });
});

test("a per-request tag overrides the global tag for that call only", async () => {
  const urls = [];
  const fake = http.createServer((req, res) => {
    urls.push(req.url);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  const fakePort = await listen(fake);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meter-"));
  const logPath = path.join(dir, "meter.jsonl");
  const proxy = createProxy({ upstream: `http://127.0.0.1:${fakePort}/api`, model: "m", apiKey: "k", logPath, capture: false, pricing: {} });
  const base = `http://127.0.0.1:${await listen(proxy.server)}`;
  await fetch(`${base}/__bench/run`, { method: "POST", body: JSON.stringify({ run_id: "g", harness: "h", task: "global" }) });

  const call = (prefix) =>
    fetch(`${base}${prefix}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }).then((r) => r.text());
  await Promise.all([call("/__tag/r2/h/a"), call("/__tag/r2/h/b"), call("")]);

  assert.deepEqual(urls.sort(), Array(3).fill("/api/v1/chat/completions"));
  const tasks = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .map((r) => `${r.run_id}/${r.task}`)
    .sort();
  assert.deepEqual(tasks, ["g/global", "r2/a", "r2/b"]);
  proxy.server.close();
  fake.close();
});

test("an allowlisted model passes through unpinned and is not priced with the pinned model's list", async () => {
  const bodies = [];
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    });
  });
  const fakePort = await listen(fake);
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meter-")), "meter.jsonl");
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${fakePort}/api`,
    model: "deepseek/deepseek-v4-flash",
    effort: "medium",
    provider: "DeepSeek",
    apiKey: "real-key",
    logPath,
    capture: false,
    pricing: { prompt: 1e-6, completion: 2e-6, cache_read: 1e-7, cache_write: null },
    passthroughModels: ["qwen/qwen3.5-flash-02-23"],
  });
  const port = await listen(proxy.server);
  const call = (model) =>
    fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }).then((r) => r.text());
  await call("openrouter/qwen/qwen3.5-flash-02-23");
  await call("gpt-x");

  assert.equal(bodies[0].model, "openrouter/qwen/qwen3.5-flash-02-23");
  assert.equal(bodies[0].provider, undefined);
  assert.equal(bodies[1].model, "deepseek/deepseek-v4-flash");
  assert.deepEqual(bodies[1].provider, { order: ["DeepSeek"], allow_fallbacks: false });

  const [vision, main] = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(vision.passthrough, true);
  assert.equal(vision.model, "openrouter/qwen/qwen3.5-flash-02-23");
  assert.equal(vision.cost_source, "unknown");
  assert.equal(main.passthrough, undefined);
  assert.equal(main.model, "deepseek/deepseek-v4-flash");
  assert.equal(main.cost_source, "computed");

  proxy.server.close();
  fake.close();
});
