// capture.mjs — turns one inference request into a compact, reviewable capture.
//
// The proxy sees exactly what each harness sends to the provider. This module
// keeps that, deduplicated: the system prompt, the tool schemas and every
// message are stored once as content-addressed blobs, and each call is a small
// JSON file of hashes plus the sampling parameters. A 40-call task therefore
// costs the system prompt once, not forty times, and the viewer can still
// rebuild any call's full request.
//
// Layout (under <results>/<run_id>/captures/):
//   blobs/<sha16>.json            a system prompt string, tools array, or message
//   <harness>/<task>/<seq>.json   one capture per inference call
//
// Pure except for `writeCapture`, which does the file I/O.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FORMATS, extractPromptParts } from "./wire.mjs";

// A streamed body is capped, but the END is where the answer is: the final
// chunk carries `finish_reason`, and a provider failure inside an HTTP 200
// stream arrives as a trailing `{"error":…}` payload. Keeping only the head
// discarded exactly that: an `atrx-vep-crispr` turn died after 91 minutes with
// a sanitized "hosted agent invocation failed" and the real cause sat in the
// 844 KB that had been thrown away. Keep both ends.
const RESPONSE_CAP = 256 * 1024;
const RESPONSE_TAIL = 64 * 1024;

export const sha = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);

const safe = (s) => String(s).replace(/[^A-Za-z0-9._#@=-]/g, "_");

/**
 * Which conversation a call continues: the tool list is the stable identity of an agent loop.
 * Side requests (a title generator has no tools) and sub-agents (their own tools) get a different
 * lineage from the main agent, so a call is compared with the previous call of its own lineage
 * and an interleaved side request cannot make the main agent look as if it rewrote its prompt.
 */
export const lineageOf = (body) => (Array.isArray(body.tools) && body.tools.length ? sha(body.tools) : "no-tools");

function conversationOf(format, body) {
  if (format === FORMATS.CHAT) {
    return (body.messages ?? []).filter(
      (m) => m.role !== "system" && m.role !== "developer",
    );
  }
  if (format === FORMATS.ANTHROPIC) return body.messages ?? [];
  return Array.isArray(body.input) ? body.input : [];
}

const STRUCTURAL = new Set(["messages", "input", "tools", "system", "instructions"]);

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Build the capture for one call.
 * @param {object} args
 * @param {string} args.format   wire format (chat | anthropic | responses)
 * @param {object} args.body     the request exactly as the harness sent it
 * @param {object} args.headers  incoming request headers (credentials dropped here)
 * @param {object|null} args.prev  the `state` returned for the previous call of this task
 * @returns {{capture: object, blobs: Map<string, unknown>, state: object}}
 */
export function buildCapture({ format, body, headers, prev, rawBytes = null }) {
  const blobs = new Map();
  const put = (value) => {
    const id = sha(value);
    if (!blobs.has(id)) blobs.set(id, value);
    return id;
  };

  const parts = extractPromptParts(format, body);
  const systemSha = parts.system ? put(parts.system) : null;
  const toolsSha = Array.isArray(body.tools) && body.tools.length ? put(body.tools) : null;
  const messageShas = conversationOf(format, body).map(put);

  // Everything that is not prompt content: temperature, max tokens, cache keys,
  // reasoning knobs, response_format, ... so provider-side cache hints show up.
  const params = {};
  for (const [k, v] of Object.entries(body)) if (!STRUCTURAL.has(k)) params[k] = v;

  const raw = JSON.stringify(body);
  const state = { systemSha, toolsSha, messageShas };
  const prefix = prev ? commonPrefix(prev.messageShas, messageShas) : 0;

  const safeHeaders = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (/^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k)) continue;
    if (/^(host|content-length|connection|accept-encoding)$/i.test(k)) continue;
    safeHeaders[k] = v;
  }

  return {
    blobs,
    state,
    capture: {
      format,
      system_sha: systemSha,
      system_chars: parts.system.length,
      tools_sha: toolsSha,
      tool_count: parts.tool_count,
      tool_names: toolNames(body.tools),
      message_shas: messageShas,
      params,
      headers: safeHeaders,
      request_bytes: Buffer.byteLength(raw), // the body re-serialised compactly
      // The body exactly as the harness sent it. Larger than request_bytes means the sender pretty-prints
      // (or otherwise pads) its JSON; equal means it already sends minified JSON.
      wire_bytes: rawBytes,
      // Prompt-cache diagnostics, all derived from the request alone:
      cache_control_markers: (raw.match(/"cache_control"/g) ?? []).length,
      prompt_cache_key: body.prompt_cache_key ?? params.user ?? null,
      same_system_as_prev: prev ? prev.systemSha === systemSha : null,
      same_tools_as_prev: prev ? prev.toolsSha === toolsSha : null,
      // How much of the previous call's conversation this call re-sends
      // byte-for-byte. Anything below prev length means history was rewritten,
      // which breaks provider prefix caching from that point on.
      prefix_reused_messages: prev ? prefix : null,
      prev_messages: prev ? prev.messageShas.length : null,
    },
  };
}

function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => t?.function?.name ?? t?.name ?? t?.type ?? "?");
}

/** Cap the stored response so a runaway stream cannot fill the disk. */
export function capResponse(text) {
  return text.length > RESPONSE_CAP
    ? `${text.slice(0, RESPONSE_CAP - RESPONSE_TAIL)}\n[truncated ${text.length - RESPONSE_CAP} chars]\n${text.slice(-RESPONSE_TAIL)}`
    : text;
}

/** Persist one capture and any blobs not already on disk. */
export function writeCapture(root, tag, seq, built, extra) {
  const base = path.join(root, safe(tag.run_id), "captures");
  const blobDir = path.join(base, "blobs");
  const callDir = path.join(base, safe(tag.harness), safe(tag.task));
  fs.mkdirSync(blobDir, { recursive: true });
  fs.mkdirSync(callDir, { recursive: true });
  for (const [id, value] of built.blobs) {
    const file = path.join(blobDir, `${id}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value));
  }
  fs.writeFileSync(
    path.join(callDir, `${String(seq).padStart(5, "0")}.json`),
    JSON.stringify({ seq, ...tag, ...built.capture, ...extra }),
  );
}
