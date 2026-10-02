import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCapture } from "./capture.mjs";
import { createProxy } from "./proxy.mjs";

const chat = (extra = []) => ({
  model: "x",
  temperature: 0.2,
  messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }, ...extra],
  tools: [{ type: "function", function: { name: "shell", parameters: {} } }],
});

test("system, tools and messages become blobs; credentials never stored", () => {
  const a = buildCapture({
    format: "chat",
    body: chat(),
    headers: { authorization: "Bearer secret", "x-session": "s1" },
    prev: null,
  });
  assert.equal(a.capture.tool_names[0], "shell");
  assert.equal(a.capture.headers.authorization, undefined);
  assert.equal(a.capture.headers["x-session"], "s1");
  assert.equal(a.capture.params.temperature, 0.2);
  assert.equal(a.capture.message_shas.length, 1); // system lives in system_sha, not the conversation
  assert.equal(a.blobs.get(a.capture.system_sha), "SYS");
  assert.equal(a.capture.same_system_as_prev, null);
});

test("prefix reuse flags a rewritten history", () => {
  const first = buildCapture({ format: "chat", body: chat(), headers: {}, prev: null });
  const grown = buildCapture({
    format: "chat",
    body: chat([{ role: "assistant", content: "ok" }]),
    headers: {},
    prev: first.state,
  });
  assert.equal(grown.capture.prefix_reused_messages, 1);
  assert.equal(grown.capture.same_system_as_prev, true);
  const rewritten = buildCapture({
    format: "chat",
    body: { ...chat(), messages: [{ role: "system", content: "SYS2" }, { role: "user", content: "changed" }] },
    headers: {},
    prev: grown.state,
  });
  assert.equal(rewritten.capture.prefix_reused_messages, 0);
  assert.equal(rewritten.capture.same_system_as_prev, false);
});

test("proxy writes a capture file with the system prompt as sent", async () => {
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"message":{"content":"yo"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}');
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${fake.address().port}/api`,
    model: "m",
    apiKey: "real",
    logPath: path.join(dir, "meter.jsonl"),
  });
  await new Promise((r) => proxy.server.listen(0, "127.0.0.1", r));
  const port = proxy.server.address().port;
  await fetch(`http://127.0.0.1:${port}/__bench/run`, {
    method: "POST",
    body: JSON.stringify({ run_id: "r1", harness: "h", task: "t#r1" }),
  });
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify(chat()) });
  const callDir = path.join(dir, "r1", "captures", "h", "t#r1");
  const call = JSON.parse(fs.readFileSync(path.join(callDir, "00000.json"), "utf8"));
  const sys = JSON.parse(fs.readFileSync(path.join(dir, "r1", "captures", "blobs", `${call.system_sha}.json`), "utf8"));
  assert.equal(sys, "SYS");
  assert.equal(call.status, 200);
  assert.match(call.response, /yo/);
  proxy.server.close();
  fake.close();
});
