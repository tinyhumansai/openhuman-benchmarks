import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProxy } from "./proxy.mjs";

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

test("proxy pins model/reasoning, swaps the credential, tags and logs usage", async () => {
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
