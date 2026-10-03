// normalize.mjs — turn captured wire-format requests into one OpenAI-chat conversation, pick the
// main agent's longest pre-compaction request, and find valid checkpoint cuts in it.
//
// Pure functions only (no file I/O) so the unit tests can drive them with small fixtures.

/** Text of a content value that may be a string, an array of blocks, or null. */
export function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") return b.text ?? "";
        if (b?.type === "image" || b?.type === "image_url" || b?.type === "input_image") return "[image]";
        if (b?.type === "tool_result") return textOf(b.content);
        return "";
      })
      .filter((s) => s !== "")
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

// Harness bookkeeping that carries no conversation content (Claude Code's per-turn token counter).
const NOISE_SYSTEM = /^\s*<total_tokens>[^<]*<\/total_tokens>\s*$/;

const argString = (v) => {
  if (typeof v === "string") return v;
  return JSON.stringify(v ?? {});
};

/** One OpenAI-chat tool call from either an OpenAI call or an Anthropic tool_use block. */
const chatToolCall = (tc) => ({
  id: tc.id ?? "",
  type: "function",
  function: { name: tc.function?.name ?? tc.name ?? "", arguments: argString(tc.function?.arguments ?? tc.input ?? tc.arguments) },
});

/**
 * Anthropic Messages wire messages -> OpenAI chat messages. tool_use blocks become assistant
 * tool_calls, tool_result blocks become role:"tool" messages (emitted before any text the same user
 * turn carries), thinking blocks are dropped.
 */
export function anthropicToChat(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      const content = textOf(m.content);
      if (!NOISE_SYSTEM.test(content)) out.push({ role: "system", content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      out.push({ role: m.role, content: textOf(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use" || b.type === "server_tool_use").map(chatToolCall);
      const msg = { role: "assistant", content: text };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // user (or anything else): tool results first, then the remaining text as one user message
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: textOf(b.content) });
    }
    const rest = m.content.filter((b) => b.type !== "tool_result");
    if (rest.length) {
      const text = textOf(rest);
      if (text !== "") out.push({ role: m.role, content: text });
    }
  }
  return out;
}

/** OpenAI chat wire messages -> the canonical subset (drops reasoning_content, names, extras). */
export function chatToChat(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role ?? "user";
    const content = textOf(m.content);
    if (role === "system" && NOISE_SYSTEM.test(content)) continue;
    if (role === "tool") {
      out.push({ role: "tool", tool_call_id: m.tool_call_id ?? "", content });
      continue;
    }
    const msg = { role: role === "developer" ? "system" : role, content };
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls.map(chatToolCall);
    out.push(msg);
  }
  return out;
}

/** Tool declarations of either wire format -> OpenAI function tools. */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      if (t?.function) {
        return { type: "function", function: { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } } };
      }
      if (t?.name) {
        return { type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? t.parameters ?? { type: "object", properties: {} } } };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * The whole conversation of one loaded call: system prompt first, then the normalized messages.
 * @param {{format: string, system: any, messages: object[]}} call
 */
export function toChat(call) {
  const body = call.format === "anthropic" ? anthropicToChat(call.messages) : chatToChat(call.messages);
  const system = textOf(call.system);
  return system ? [{ role: "system", content: system }, ...body] : body;
}

const commonPrefix = (a, b) => {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
  return k;
};

/**
 * The main agent's longest pre-compaction request.
 *
 * Starting at the main context's first call, follow the calls that extend the conversation: a call
 * extends the current tip when it is at least as long and shares at least half of the tip's
 * messages as a prefix (some harnesses rewrite the newest message every turn, e.g. a cache marker,
 * so an exact prefix is too strict). A compaction replaces the history with a summary and so never
 * extends the tip; side calls and sub-agents start from a different first message and never do
 * either. The chain may cross contexts, because a harness can add tools mid-task.
 *
 * @param {object[]} calls  call records of one task, in seq order (message_shas, tool_count, ...)
 * @param {string|null} mainContext  `${system_sha}.${tools_sha}` of the main context
 * @returns {{tip: object|null, compacted: boolean}}
 */
export function pickTrunk(calls, mainContext) {
  const ctx = (c) => `${c.system_sha}.${c.tools_sha}`;
  const mainIdx = calls.findIndex((c) => ctx(c) === mainContext);
  if (mainIdx < 0) return { tip: null, compacted: false };
  // The conversation may have begun under an earlier system prompt (a harness that injects the
  // date or memory into it): start at the first tool-bearing call with the same first message.
  const first = calls[mainIdx].message_shas[0];
  let startIdx = calls.findIndex((c, i) => i <= mainIdx && c.tool_count > 0 && c.message_shas[0] === first);
  if (startIdx < 0) startIdx = mainIdx;
  let tip = calls[startIdx];
  let compacted = false;
  for (const c of calls.slice(startIdx + 1)) {
    if (!(c.tool_count > 0)) continue;
    const t = tip.message_shas;
    const s = c.message_shas;
    const k = commonPrefix(t, s);
    if (s.length >= t.length && k >= Math.max(1, Math.ceil(t.length / 2))) tip = c;
    // A call with the agent's tool list that restarts from a different first message after the
    // trunk began: usually the harness compacted (OpenHuman also moves the summary into the system
    // prompt, so only the tools are compared). Informational; the tip stays pre-compaction.
    else if (c.tools_sha === tip.tools_sha && k === 0 && s.length > 0) compacted = true;
  }
  return { tip, compacted };
}

/**
 * Indices where the conversation can be cut: the prefix msgs[0..i) ends with a tool result, every
 * tool call in it has its result, and msgs[i] is an assistant message (the next action exists).
 */
export function validCuts(messages) {
  const cuts = [];
  const open = new Set();
  let unnamed = 0; // tool calls without ids: matched by count
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (i > 0 && messages[i - 1].role === "tool" && m.role === "assistant" && open.size === 0 && unnamed <= 0) cuts.push(i);
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) open.add(tc.id);
        else unnamed += 1;
      }
    } else if (m.role === "tool") {
      if (m.tool_call_id && open.has(m.tool_call_id)) open.delete(m.tool_call_id);
      else if (unnamed > 0) unnamed -= 1;
      else if (open.size && !m.tool_call_id) open.delete(open.values().next().value);
    } else if (m.role === "user") {
      // A new user turn closes whatever went unanswered.
      open.clear();
      unnamed = 0;
    }
  }
  return cuts;
}

/**
 * The valid cut closest to `frac` of the conversation (measured in messages after the leading
 * system messages). Returns null when there is none.
 */
export function cutAt(messages, frac, cuts = validCuts(messages)) {
  if (!cuts.length) return null;
  let lead = 0;
  while (lead < messages.length && messages[lead].role === "system") lead += 1;
  const target = lead + frac * (messages.length - lead);
  let best = null;
  for (const c of cuts) if (best === null || Math.abs(c - target) < Math.abs(best - target)) best = c;
  return best;
}
