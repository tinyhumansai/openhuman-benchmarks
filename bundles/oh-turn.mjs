// oh-turn.mjs — run one agent turn against a headless `openhuman-core run`
// over JSON-RPC and exit non-zero on a JSON-RPC error. Waits for /health first.
// Env: OH_PORT OH_TOKEN PROMPT_FILE PWD DUMMY_API_KEY BENCH_MODEL INFERENCE_URL TASK_TIMEOUT_S
import fs from "node:fs";
import http from "node:http";

const base = `http://127.0.0.1:${process.env.OH_PORT}`;
const token = process.env.OH_TOKEN;
const deadline = Date.now() + 60_000;
for (;;) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) {
    console.error("openhuman-core did not become healthy");
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 100));
}

// node:http, not fetch: fetch's undici enforces a 5 min headers timeout, and a
// long agent turn holds the response open far longer than that.
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "openhuman.inference_agent_chat",
  params: {
    message: fs.readFileSync(process.env.PROMPT_FILE, "utf8"),
    cwd: process.env.PWD,
    inference_url: process.env.INFERENCE_URL,
    api_key: process.env.DUMMY_API_KEY,
    model_override: process.env.BENCH_MODEL,
  },
});
const text = await new Promise((resolve, reject) => {
  const req = http.request(
    `${base}/rpc`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) },
    },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    },
  );
  req.on("error", reject);
  req.end(body);
});
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error(text.slice(0, 2000));
  process.exit(1);
}
console.log(JSON.stringify(json).slice(0, 4000));
process.exit(json.error ? 1 : 0);
