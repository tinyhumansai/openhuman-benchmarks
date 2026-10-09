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

/** A model id as OpenRouter names it: hosts may prefix it with `openrouter/`. */
const routeId = (m) => String(m ?? "").trim().replace(/^openrouter\//, "");

/** Whether `requested` is one of the models that keep their own model instead of the pinned one. */
export function isPassthrough(requested, allowlist) {
  if (!requested || !allowlist?.length) return false;
  const id = routeId(requested);
  return allowlist.some((m) => routeId(m) === id);
}

/** Share of a request's `max_tokens` left for thinking when this proxy pins an
 * effort level. Mirrors OpenHuman's `REASONING_BUDGET_PERCENT` (55%). */
const REASONING_BUDGET_SHARE = 0.55;

/** Smallest thinking budget worth sending; Anthropic models reject less.
 * Mirrors OpenHuman's `MIN_REASONING_BUDGET_TOKENS`. */
const MIN_REASONING_BUDGET_TOKENS = 1024;

/**
 * Pin the controlled variables on one request body: model, reasoning effort,
 * and ask the upstream to report cost/usage. Returns the rewritten object and
 * the fields that were overridden (so the log can show what a harness tried to
 * send versus what was forwarded).
 */
export function rewriteRequest(
  format,
  body,
  { model, effort, provider, passthrough, maxTokens, reasoningBudget = 0 },
) {
  const out = { ...body };
  const overridden = {};
  if (isPassthrough(body.model, passthrough)) {
    // A model the host pins on purpose (OpenHuman's vision sub-agent): the controlled variables
    // describe the main agent's model, not this one, so its model, reasoning and provider stay
    // as sent. Usage and cost are still requested.
    out.usage = { ...(typeof out.usage === "object" ? out.usage : {}), include: true };
    if (format === FORMATS.CHAT && out.stream === true) {
      out.stream_options = { ...(out.stream_options ?? {}), include_usage: true };
    }
    return { body: out, overridden, passthrough: true };
  }
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
  // Pin the effort WITH a thinking budget, not the effort alone. A harness that
  // configures no reasoning of its own (most do not, since this pin is how the
  // run sets effort) also sets no thinking budget, so a bare `{effort}` lets a
  // reasoning model think through the request's whole `max_tokens` and return
  // `finish_reason: "length"` with no content and no tool call. Measured on
  // deepseek-v4.1-flash at high effort, that was 7-17% of every call on the
  // harder tasks and 0% on the same tasks without reasoning pinned: calls
  // billed in full that moved the run nowhere, which depressed those runs and
  // made them look like a model regression.
  //
  // A thinking budget cannot ride alongside the effort: OpenRouter answers 400
  // "Only one of \"reasoning.effort\" and \"reasoning.max_tokens\" can be
  // specified". So bounding the thinking here means giving up the effort pin,
  // which is the run's controlled variable. The dead calls therefore have to be
  // addressed by the request's own `max_tokens` (or a lower effort), not from
  // inside this pin. Measured rate, deepseek-v4.1-flash at high effort:
  // 7-17% of calls on the harder tasks, 0% on models that do not reason.
  // Opt-in alternative control: a thinking budget INSTEAD of the effort label
  // (OpenRouter accepts one or the other). Measured on deepseek-v4.1-flash,
  // 2026-10-07: the effort label is a soft dial -- "high" roughly doubles mean
  // reasoning length versus "low" with a 10x spread within a level -- and the
  // documented "~80% of max_tokens" allocation is not enforced; reasoning runs
  // to the full `max_tokens` and the call returns nothing. A budget fares no
  // better on the providers this account can route to: `max_tokens: 1500` got
  // 481/859/4206 reasoning tokens from Together and 3528/5964/5844 from
  // AtlasCloud. So this knob exists to test a provider, not to rely on; the
  // only bound those providers honour is the request's own `max_tokens`.
  // A harness that switches reasoning OFF for one call keeps it off. That is
  // the harness's own recovery (tinyagents sends `reasoning_effort: "none"`
  // for the calls after one that died at its cap with nothing to show), and
  // it is part of what the run measures: the pin says what effort the run
  // wants where the harness asks for reasoning at all, not that every call
  // must reason. `none` was also the one control measured to give zero
  // reasoning tokens on the routable providers. The effective effort is
  // returned so the meter records it per call.
  const requestedOff = reasoningIsOff(prior);
  out.reasoning = requestedOff
    ? { effort: "none" }
    : reasoningBudget > 0
      ? { max_tokens: reasoningBudget }
      : { effort };
  const effectiveEffort = requestedOff ? "none" : reasoningBudget > 0 ? null : effort;

  // Pin the OpenRouter provider. Prompt caches live inside one provider's
  // deployment, so letting OpenRouter route each call to whichever backend is
  // free (or a harness express its own preference) scatters a thread's prefix
  // across caches. No fallbacks: a pinned provider failing is a visible error,
  // not a silent cache reset on another backend.
  if (provider) {
    if (out.provider !== undefined) overridden.provider = out.provider;
    out.provider = { order: [provider], allow_fallbacks: false };
  }

  // Cap the output reservation. OpenRouter runs a pre-flight balance check
  // against `max_tokens`, not against what the call will actually emit, and
  // refuses the request when the reservation exceeds the remaining balance:
  // "You requested up to 16384 tokens, but can only afford 14021". That 402 is
  // terminal, so a whole task dies on its first call even though the account
  // has credit and typical calls emit ~2,000 tokens. OpenHuman's own cap is the
  // fixed `AGENT_TURN_MAX_OUTPUT_TOKENS` (16384), which cannot know the balance.
  // BENCH_MAX_TOKENS prices the reservation to what the key can actually afford;
  // it is an upper bound, so a lower value changes nothing for a normal call.
  if (maxTokens > 0 && (out.max_tokens ?? Infinity) > maxTokens) {
    if (out.max_tokens !== undefined) overridden.max_tokens = out.max_tokens;
    out.max_tokens = maxTokens;
  }

  // OpenRouter returns `usage.cost` when asked.
  out.usage = { ...(typeof out.usage === "object" ? out.usage : {}), include: true };
  if (format === FORMATS.CHAT && out.stream === true) {
    out.stream_options = { ...(out.stream_options ?? {}), include_usage: true };
  }
  return { body: out, overridden, effort: effectiveEffort };
}

// Whether a request's own reasoning field (any of the three spellings the
// pin strips) asks for reasoning to be OFF: OpenAI's `reasoning_effort:
// "none"`, OpenRouter's `{effort: "none"}` or `{enabled: false}`, Anthropic's
// `thinking: {type: "disabled"}`. OpenRouter's `{exclude: true}` only hides
// the reasoning from the response and is not "off".
export function reasoningIsOff(prior) {
  if (prior === undefined || prior === null) return false;
  if (typeof prior === "string") return prior.trim().toLowerCase() === "none";
  if (typeof prior !== "object") return false;
  if (prior.enabled === false) return true;
  if (typeof prior.effort === "string") return prior.effort.trim().toLowerCase() === "none";
  if (prior.type === "disabled") return true;
  return false;
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
