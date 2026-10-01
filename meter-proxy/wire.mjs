// wire.mjs — pure helpers for the three inference wire formats the benchmark
// harnesses speak: OpenAI chat-completions, Anthropic messages, OpenAI
// Responses. No I/O here so every parser is unit-testable on canned streams.

export const FORMATS = Object.freeze({
  CHAT: "chat",
  ANTHROPIC: "anthropic",
  RESPONSES: "responses",
});

/** Map a request path to a wire format, or null for non-inference traffic. */
export function detectFormat(method, urlPath) {
  if (method !== "POST") return null;
  const p = urlPath.split("?")[0].replace(/\/+$/, "");
  if (p.endsWith("/chat/completions")) return FORMATS.CHAT;
  if (p.endsWith("/messages")) return FORMATS.ANTHROPIC;
  if (p.endsWith("/responses")) return FORMATS.RESPONSES;
  return null;
}

/**
 * Normalise a client path onto the upstream's `/v1/...` space. Clients differ:
 * OpenAI-style SDKs use a base ending in `/v1`, Anthropic's appends `/v1`
 * itself, some tools omit it. Upstream (`https://openrouter.ai/api`) always
 * wants `/v1/<route>`.
 */
export function upstreamRoute(urlPath) {
  const [p, query] = urlPath.split("?");
  const route = p.startsWith("/v1/") ? p : `/v1${p.startsWith("/") ? p : `/${p}`}`;
  return query ? `${route}?${query}` : route;
}

/**
 * Pin the controlled variables on one request body: model, reasoning effort,
 * and ask the upstream to report cost/usage. Returns the rewritten object and
 * the fields that were overridden (so the log can show what a harness tried to
 * send versus what was forwarded).
 */
export function rewriteRequest(format, body, { model, effort }) {
  const out = { ...body };
  const overridden = {};
  if (out.model !== model) overridden.model = out.model ?? null;
  out.model = model;

  // One reasoning knob for every harness. OpenRouter normalises
  // `reasoning.effort` across providers; strip the per-protocol spellings so
  // two knobs never disagree.
  const prior =
    out.reasoning ?? out.reasoning_effort ?? out.thinking ?? undefined;
  if (prior !== undefined) overridden.reasoning = prior;
  delete out.reasoning_effort;
  delete out.thinking;
  out.reasoning = { effort };

  // OpenRouter returns `usage.cost` when asked.
  out.usage = { ...(typeof out.usage === "object" ? out.usage : {}), include: true };
  if (format === FORMATS.CHAT && out.stream === true) {
    out.stream_options = { ...(out.stream_options ?? {}), include_usage: true };
  }
  return { body: out, overridden };
}

function eachJsonEvent(text, fn) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith("data:")
      ? trimmed.slice(5).trim()
      : trimmed;
    if (payload === "[DONE]" || !payload.startsWith("{")) continue;
    try {
      fn(JSON.parse(payload));
    } catch {
      // partial or non-JSON line
    }
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Fold a response body (SSE or unary JSON, possibly truncated) into normalised
 * usage. `prompt_tokens` always means the *whole* prompt including cached and
 * cache-write tokens, whichever format reported it, so cache % is comparable.
 */
export function parseResponse(format, text) {
  const out = {
    provider: null,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    error: null,
  };
  // Anthropic reports input in two events; keep the pieces and combine at the end.
  const anth = { input: null, read: null, write: null, output: null };

  const absorb = (json) => {
    if (!json || typeof json !== "object") return;
    if (typeof json.provider === "string") out.provider = json.provider;
    if (json.error) {
      out.error =
        typeof json.error === "string"
          ? json.error
          : (json.error.message ?? JSON.stringify(json.error));
    }
    // Responses nests the final object under `response`; Anthropic under `message`.
    const usage =
      json.usage ?? json.response?.usage ?? json.message?.usage ?? null;
    if (json.response?.provider) out.provider = json.response.provider;
    if (!usage || typeof usage !== "object") return;

    if (num(usage.cost) !== null) out.cost_usd = usage.cost;

    if (format === FORMATS.CHAT) {
      out.prompt_tokens = num(usage.prompt_tokens) ?? out.prompt_tokens;
      out.completion_tokens =
        num(usage.completion_tokens) ?? out.completion_tokens;
      out.cached_tokens =
        num(usage.prompt_tokens_details?.cached_tokens) ?? out.cached_tokens;
      out.cache_write_tokens =
        num(usage.prompt_tokens_details?.cache_write_tokens) ??
        out.cache_write_tokens;
    } else if (format === FORMATS.ANTHROPIC) {
      anth.input = num(usage.input_tokens) ?? anth.input;
      anth.read = num(usage.cache_read_input_tokens) ?? anth.read;
      anth.write = num(usage.cache_creation_input_tokens) ?? anth.write;
      anth.output = num(usage.output_tokens) ?? anth.output;
    } else {
      out.prompt_tokens = num(usage.input_tokens) ?? out.prompt_tokens;
      out.completion_tokens = num(usage.output_tokens) ?? out.completion_tokens;
      out.cached_tokens =
        num(usage.input_tokens_details?.cached_tokens) ?? out.cached_tokens;
    }
  };

  eachJsonEvent(text, absorb);
  // A unary (non-SSE) body is one JSON document, possibly pretty-printed.
  if (out.prompt_tokens === null && anth.input === null) {
    try {
      absorb(JSON.parse(text));
    } catch {
      // not JSON
    }
  }

  if (format === FORMATS.ANTHROPIC && anth.input !== null) {
    out.cached_tokens = anth.read ?? 0;
    out.cache_write_tokens = anth.write ?? 0;
    out.prompt_tokens = anth.input + (anth.read ?? 0) + (anth.write ?? 0);
    out.completion_tokens = anth.output;
  }
  return out;
}

const FIRST_TOKEN_RE = {
  [FORMATS.CHAT]: /"(?:content|reasoning|reasoning_content)":"[^"]/,
  [FORMATS.ANTHROPIC]: /"(?:text|thinking)":"[^"]/,
  [FORMATS.RESPONSES]: /"delta":"[^"]/,
};
const FIRST_CONTENT_RE = {
  [FORMATS.CHAT]: /"content":"[^"]/,
  [FORMATS.ANTHROPIC]: /"text":"[^"]/,
  [FORMATS.RESPONSES]: /output_text\.delta"[^}]*"delta":"[^"]/,
};

/**
 * Tracks when a streamed response produced its first model token (reasoning or
 * text) and its first visible text, across arbitrary chunk boundaries.
 */
export function createFirstTokenTracker(format, startedAt) {
  let tail = "";
  const out = { first_token_ms: null, first_content_ms: null };
  const tokenRe = FIRST_TOKEN_RE[format];
  const contentRe = FIRST_CONTENT_RE[format];
  return {
    observe(chunk, now = Date.now()) {
      if (out.first_token_ms !== null && out.first_content_ms !== null) return;
      const window = tail + chunk.toString("utf8");
      tail = window.slice(-256);
      if (out.first_token_ms === null && tokenRe.test(window)) {
        out.first_token_ms = now - startedAt;
      }
      if (out.first_content_ms === null && contentRe.test(window)) {
        out.first_content_ms = now - startedAt;
      }
    },
    result: () => ({ ...out }),
  };
}

/**
 * Split a request body into system prompt text and tool-schema text so the
 * two can be sized separately. Handles all three request shapes.
 */
export function extractPromptParts(format, body) {
  const systemParts = [];
  if (format === FORMATS.CHAT) {
    for (const m of body.messages ?? []) {
      if (m.role === "system" || m.role === "developer") {
        systemParts.push(contentToText(m.content));
      }
    }
  } else if (format === FORMATS.ANTHROPIC) {
    systemParts.push(contentToText(body.system));
  } else {
    systemParts.push(contentToText(body.instructions));
    if (Array.isArray(body.input)) {
      for (const m of body.input) {
        if (m?.role === "system" || m?.role === "developer") {
          systemParts.push(contentToText(m.content));
        }
      }
    }
  }
  return {
    system: systemParts.filter(Boolean).join("\n"),
    tools: body.tools ? JSON.stringify(body.tools) : "",
    tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
  };
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c?.text ?? c?.content ?? "")))
      .join("\n");
  }
  return String(content.text ?? "");
}
