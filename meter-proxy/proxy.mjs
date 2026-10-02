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
//   BENCH_REASONING    pinned reasoning effort (default high)
//   BENCH_PROVIDER     pinned OpenRouter provider, no fallbacks (default DeepSeek; empty = unpinned)
//   METER_LOG          JSONL output (default /results/meter.jsonl)
//   METER_PRICING=0    skip the price-list fetch (cost then needs usage.cost)
//   METER_CAPTURE=0    do not store request captures (system prompt, tools, messages);
//                      default stores them under <dir of METER_LOG>/<run_id>/captures/
//
// Control plane (loopback of the compose network only):
//   POST /__bench/run  {"run_id":"..","harness":"..","task":".."}  tag subsequent calls
//   GET  /__bench/runs                                 per-run first-request sizes

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { forwardHeaders } from "./headers.mjs";
import zlib from "node:zlib";
import { buildCapture, capResponse, writeCapture } from "./capture.mjs";
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

/** Decoder for a response's content-encoding, or null when it is not compressed. */
function decoderFor(encoding) {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip": return zlib.createGunzip();
    case "deflate": return zlib.createInflate();
    case "br": return zlib.createBrotliDecompress();
    default: return null;
  }
}

// DeepSeek's own endpoint for deepseek/deepseek-v4.1-flash: 99.99% uptime, a 393k output cap (covers the
// DeepSeek harness's max_tokens=256000) and cached tokens at 1/50 of the uncached price. Note that
// pinning it on the older `deepseek-v4-flash` slug silently serves v4.1, so the slug and pin go together.
export const DEFAULT_PROVIDER = "DeepSeek";

export function createProxy(opts) {
  const upstream = new URL(opts.upstream ?? "https://openrouter.ai/api");
  const logPath = path.resolve(opts.logPath ?? "/results/meter.jsonl");
  const model = opts.model;
  const effort = opts.effort ?? "high";
  const provider = opts.provider || null;
  const apiKey = opts.apiKey;
  let pricing = opts.pricing ?? null;
  let run = { run_id: "untagged", harness: "untagged", task: "untagged" };
  let seq = 0;
  const captureRoot = opts.capture === false ? null : path.dirname(logPath);
  const prevState = new Map(); // `${run}/${harness}/${task}` -> last call state, for prefix diffs
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
      let built = null;
      if (format) {
        let parsed = null;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          // forwarded untouched; logged as unparsable
        }
        if (parsed) {
          const sizes = promptSizes(format, parsed);
          if (captureRoot) {
            const key = `${tag.run_id}/${tag.harness}/${tag.task}`;
            built = buildCapture({
              format,
              body: parsed,
              headers: req.headers,
              prev: prevState.get(key) ?? null,
            });
            prevState.set(key, built.state);
          }
          const rewritten = rewriteRequest(format, parsed, { model, effort, provider });
          outBody = Buffer.from(JSON.stringify(rewritten.body));
          record = {
            seq: callSeq,
            at: new Date(startedAt).toISOString(),
            ...tag,
            format,
            model,
            reasoning_effort: effort,
            provider_pinned: provider,
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

      // Every header goes upstream as received (see headers.mjs); only the
      // credential, host and content-length change.
      const fwd = forwardHeaders(req.rawHeaders, {
        host: upstream.host,
        apiKey,
        bodyLength: outBody.length,
      });
      const headers = fwd.list;
      if (built) built.capture.headers_replaced = fwd.replaced;
      if (built) built.capture.headers_dropped = fwd.dropped;

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
          // The client gets the bytes untouched (accept-encoding is forwarded, so
          // the body may be compressed); a decoded copy feeds the metering.
          const decoder = decoderFor(upstreamRes.headers["content-encoding"]);
          const meter = (chunk) => {
            tokens.observe(chunk);
            pieces.push(chunk);
          };
          decoder?.on("data", meter);
          decoder?.on("error", () => {});
          upstreamRes.on("data", (chunk) => {
            if (firstByteAt === null) firstByteAt = Date.now();
            if (decoder) decoder.write(chunk);
            else meter(chunk);
            res.write(chunk);
          });
          const finish = () => {
            const usage = parseResponse(
              format,
              Buffer.concat(pieces).toString("utf8"),
            );
            const responseText = Buffer.concat(pieces).toString("utf8");
            const reported = usage.cost_usd;
            const computed = computeCost(pricing, usage);
            const timing = {
              ttfb_ms: firstByteAt === null ? null : firstByteAt - startedAt,
              ...tokens.result(),
              total_ms: Date.now() - startedAt,
            };
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
              ...timing,
            });
            if (built) {
              try {
                writeCapture(captureRoot, tag, callSeq, built, {
                  at: new Date(startedAt).toISOString(),
                  status: upstreamRes.statusCode || 502,
                  usage,
                  ...timing,
                  cost_usd: reported ?? computed,
                  response_headers: upstreamRes.headers,
                  response: capResponse(responseText),
                });
              } catch (error) {
                process.stderr.write(`[meter] capture failed: ${error.message}\n`);
              }
            }
            res.end();
          };
          // With a decoder, metering completes when it has flushed, not when the socket ends.
          if (decoder) {
            decoder.on("end", finish);
            decoder.on("error", finish);
            upstreamRes.on("end", () => decoder.end());
          } else {
            upstreamRes.on("end", finish);
          }
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
    effort: process.env.BENCH_REASONING || "high",
    provider: process.env.BENCH_PROVIDER ?? DEFAULT_PROVIDER, // "" disables the pin
    apiKey: process.env.OPENROUTER_API_KEY,
    logPath: process.env.METER_LOG || "/results/meter.jsonl",
    capture: process.env.METER_CAPTURE !== "0",
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
