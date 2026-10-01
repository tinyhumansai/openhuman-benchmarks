#!/usr/bin/env node
// proxy.mjs — the benchmark's neutral metering proxy. Every harness points its
// base URL here; the proxy pins model + reasoning effort, holds the only real
// OpenRouter key, forwards upstream, and appends one JSONL record per
// inference call (latency, TTFT, tokens, cache, cost, prompt sizes).
//
// Env:
//   METER_PORT (8080)  METER_HOST (0.0.0.0, it lives on the compose network)
//   METER_UPSTREAM     (https://openrouter.ai/api)
//   OPENROUTER_API_KEY real key; injected upstream, harnesses carry a dummy
//   BENCH_MODEL        pinned model slug (required)
//   BENCH_REASONING    pinned reasoning effort (default medium)
//   METER_LOG          JSONL output (default /results/meter.jsonl)
//   METER_PRICING=0    skip the price-list fetch (cost then needs usage.cost)
//
// Control plane (loopback of the compose network only):
//   POST /__bench/run  {"run_id":"..","harness":"..","task":".."}  tag subsequent calls
//   GET  /__bench/runs                                 per-run first-request sizes

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { computeCost, fetchPricing } from "./pricing.mjs";
import {
  FORMATS,
  createFirstTokenTracker,
  detectFormat,
  extractPromptParts,
  parseResponse,
  rewriteRequest,
  upstreamRoute,
} from "./wire.mjs";

let countTokens = (s) => Math.ceil(s.length / 4);
let tokenizer = "chars/4";
try {
  const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
  countTokens = (s) => encode(s).length;
  tokenizer = "o200k_base";
} catch {
  // tokenizer not installed: sizes fall back to a chars/4 estimate, labelled as such
}

export function createProxy(opts) {
  const upstream = new URL(opts.upstream ?? "https://openrouter.ai/api");
  const logPath = path.resolve(opts.logPath ?? "/results/meter.jsonl");
  const model = opts.model;
  const effort = opts.effort ?? "medium";
  const apiKey = opts.apiKey;
  let pricing = opts.pricing ?? null;
  let run = { run_id: "untagged", harness: "untagged", task: "untagged" };
  let seq = 0;
  const firstRequests = new Map(); // `${harness}/${task}` -> prompt sizes
  const transport = upstream.protocol === "https:" ? https : http;

  function append(record) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  }

  function promptSizes(format, body) {
    const key = `${run.run_id}/${run.harness}/${run.task}`;
    if (firstRequests.has(key)) return null;
    const parts = extractPromptParts(format, body);
    const sizes = {
      system_prompt_tokens: countTokens(parts.system),
      tool_schema_tokens: parts.tools ? countTokens(parts.tools) : 0,
      tool_count: parts.tool_count,
      tokenizer,
    };
    firstRequests.set(key, sizes);
    return sizes;
  }

  function control(req, res, body) {
    if (req.method === "POST" && req.url === "/__bench/run") {
      try {
        const next = JSON.parse(body.toString("utf8"));
        run = {
          run_id: String(next.run_id ?? "untagged"),
          harness: String(next.harness ?? "untagged"),
          task: String(next.task ?? "untagged"),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(run));
      } catch {
        res.writeHead(400).end("bad json");
      }
      return;
    }
    if (req.method === "GET" && req.url === "/__bench/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Object.fromEntries(firstRequests)));
      return;
    }
    if (req.method === "GET" && req.url === "/__bench/health") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url.startsWith("/__bench/")) return control(req, res, body);

      const format = detectFormat(req.method, req.url);
      const startedAt = Date.now();
      const tag = { ...run };
      const callSeq = format ? seq++ : null;

      let outBody = body;
      let record = null;
      if (format) {
        let parsed = null;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          // forwarded untouched; logged as unparsable
        }
        if (parsed) {
          const sizes = promptSizes(format, parsed);
          const rewritten = rewriteRequest(format, parsed, { model, effort });
          outBody = Buffer.from(JSON.stringify(rewritten.body));
          record = {
            seq: callSeq,
            at: new Date(startedAt).toISOString(),
            ...tag,
            format,
            model,
            reasoning_effort: effort,
            overridden: rewritten.overridden,
            stream: parsed.stream === true,
            messages: Array.isArray(parsed.messages)
              ? parsed.messages.length
              : Array.isArray(parsed.input)
                ? parsed.input.length
                : null,
            tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
            ...(sizes ?? {}),
          };
        }
      }

      const headers = { ...req.headers, host: upstream.host };
      // Harnesses carry a dummy credential; the real key lives only here.
      delete headers.authorization;
      delete headers["x-api-key"];
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      headers["content-length"] = String(outBody.length);
      delete headers["accept-encoding"]; // keep bodies parseable

      const upstreamReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: req.method,
          path: `${upstream.pathname.replace(/\/$/, "")}${upstreamRoute(req.url)}`,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          if (!format) {
            upstreamRes.pipe(res);
            return;
          }
          let firstByteAt = null;
          const tokens = createFirstTokenTracker(format, startedAt);
          const pieces = [];
          upstreamRes.on("data", (chunk) => {
            if (firstByteAt === null) firstByteAt = Date.now();
            tokens.observe(chunk);
            pieces.push(chunk);
            res.write(chunk);
          });
          upstreamRes.on("end", () => {
            const usage = parseResponse(
              format,
              Buffer.concat(pieces).toString("utf8"),
            );
            const reported = usage.cost_usd;
            const computed = computeCost(pricing, usage);
            append({
              ...(record ?? { seq: callSeq, ...tag, format }),
              status: upstreamRes.statusCode || 502,
              ...usage,
              cost_usd: reported ?? computed,
              cost_source:
                reported !== null
                  ? "reported"
                  : computed !== null
                    ? "computed"
                    : "unknown",
              ttfb_ms: firstByteAt === null ? null : firstByteAt - startedAt,
              ...tokens.result(),
              total_ms: Date.now() - startedAt,
            });
            res.end();
          });
          upstreamRes.on("error", () => res.end());
        },
      );
      upstreamReq.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("meter proxy upstream error");
        if (format) {
          append({
            ...(record ?? { seq: callSeq, ...tag, format }),
            status: 502,
            error: `upstream: ${error.message}`,
            total_ms: Date.now() - startedAt,
          });
        }
      });
      upstreamReq.end(outBody);
    });
  });

  return {
    server,
    setPricing: (p) => {
      pricing = p;
    },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const model = process.env.BENCH_MODEL;
  if (!model) throw new Error("BENCH_MODEL is required");
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  const upstreamUrl = process.env.METER_UPSTREAM || "https://openrouter.ai/api";
  const proxy = createProxy({
    upstream: upstreamUrl,
    model,
    effort: process.env.BENCH_REASONING || "medium",
    apiKey: process.env.OPENROUTER_API_KEY,
    logPath: process.env.METER_LOG || "/results/meter.jsonl",
  });
  if (process.env.METER_PRICING !== "0") {
    try {
      proxy.setPricing(await fetchPricing(new URL(upstreamUrl).origin, model));
    } catch (error) {
      process.stderr.write(`[meter] pricing unavailable: ${error.message}\n`);
    }
  }
  const port = Number.parseInt(process.env.METER_PORT || "8080", 10);
  const host = process.env.METER_HOST || "0.0.0.0";
  proxy.server.listen(port, host, () => {
    process.stdout.write(
      `[meter] listening on ${host}:${port} model=${model} tokenizer=${tokenizer}\n`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => proxy.server.close(() => process.exit(0)));
  }
}

export { FORMATS };
