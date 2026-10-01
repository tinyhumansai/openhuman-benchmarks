// oh-turn.mjs — run one agent turn against a headless `openhuman-core run`
// over JSON-RPC and exit non-zero on a JSON-RPC error. Waits for /health first.
// Env: OH_PORT OH_TOKEN PROMPT_FILE PWD DUMMY_API_KEY BENCH_MODEL INFERENCE_URL TASK_TIMEOUT_S
import fs from "node:fs";

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

const res = await fetch(`${base}/rpc`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(Number(process.env.TASK_TIMEOUT_S || 1800) * 1000),
  body: JSON.stringify({
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
  }),
});
const json = await res.json();
console.log(JSON.stringify(json).slice(0, 4000));
process.exit(json.error ? 1 : 0);
