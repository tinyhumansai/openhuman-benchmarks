// transcript.mjs — render one captured inference call as Markdown, exactly as the
// provider received it: system prompt, tool schemas, then every message with its
// tool calls and results, then what came back. Content is placed verbatim inside
// fences (never interpreted as Markdown), so what you read is what was sent.

/** A backtick fence longer than any run of backticks in `text`, so content cannot close it. */
function fence(text, lang = "text") {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

const asText = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === "string" ? p : (p?.text ?? JSON.stringify(p, null, 2)))).join("\n")
      : c == null
        ? ""
        : JSON.stringify(c, null, 2);

function renderMessage(m, i) {
  const role = m.role ?? m.type ?? "?";
  const label = m.tool_call_id ? `${role} (answers ${m.tool_call_id})` : m.name ? `${role} (${m.name})` : role;
  const out = [`### ${i + 1}. ${label}`];
  const body = asText(m.content ?? m.output ?? "");
  if (body) out.push(fence(body));
  if (m.reasoning_content) out.push("reasoning_content:", fence(m.reasoning_content));
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.push("tool_calls:", fence(JSON.stringify(m.tool_calls, null, 2), "json"));
  }
  // Responses-API items (function_call, ...) carry their payload outside `content`.
  if (!body && !m.tool_calls && !m.role) out.push(fence(JSON.stringify(m, null, 2), "json"));
  return out.join("\n\n");
}

/** Assemble the assistant turn from an OpenAI-style SSE stream or a unary JSON body. */
export function assembleResponse(raw) {
  if (!raw) return null;
  const text = [];
  const reasoning = [];
  const calls = new Map();
  const absorb = (delta) => {
    if (!delta) return;
    if (delta.content) text.push(delta.content);
    if (delta.reasoning_content ?? delta.reasoning) reasoning.push(delta.reasoning_content ?? delta.reasoning);
    for (const t of delta.tool_calls ?? []) {
      const c = calls.get(t.index ?? 0) ?? { id: null, name: "", arguments: "" };
      c.id = t.id ?? c.id;
      c.name += t.function?.name ?? "";
      c.arguments += t.function?.arguments ?? "";
      calls.set(t.index ?? 0, c);
    }
  };
  let parsed = false;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      parsed = true;
      absorb(j.choices?.[0]?.delta);
    } catch {
      // keep-alive comments and partial lines
    }
  }
  if (!parsed) {
    try {
      const j = JSON.parse(raw);
      absorb(j.choices?.[0]?.message);
      parsed = true;
    } catch {
      return null;
    }
  }
  return { content: text.join(""), reasoning: reasoning.join(""), tool_calls: [...calls.values()] };
}

/**
 * @param {object} call  a capture with `system`, `tools`, `messages` resolved from blobs
 */
export function toMarkdown(call) {
  const out = [
    `# ${call.harness} · ${call.task} · call ${call.seq}`,
    "",
    `- run: \`${call.run_id}\`  format: \`${call.format}\`  status: \`${call.status ?? "?"}\``,
    `- messages: ${call.messages.length}, tools: ${call.tool_count}, request: ${((call.request_bytes ?? 0) / 1024).toFixed(1)} KB`,
    `- cache: system ${call.same_system_as_prev === null ? "n/a" : call.same_system_as_prev ? "same" : "CHANGED"}, tools ${call.same_tools_as_prev === null ? "n/a" : call.same_tools_as_prev ? "same" : "CHANGED"}, prefix reused ${call.prefix_reused_messages ?? "n/a"}/${call.prev_messages ?? "n/a"}`,
    "",
    "## Request parameters (as the harness sent them)",
    fence(JSON.stringify(call.params ?? {}, null, 2), "json"),
    "",
    "## System prompt",
    call.system ? fence(call.system) : "_none_",
    "",
    `## Tools (${call.tool_count})`,
    call.tools?.length ? fence(JSON.stringify(call.tools, null, 2), "json") : "_none_",
    "",
    `## Conversation (${call.messages.length})`,
    "",
    ...call.messages.flatMap((m, i) => [renderMessage(m, i), ""]),
    "## Response",
    "",
  ];
  const a = assembleResponse(call.response);
  if (a) {
    out.push("### assistant", "");
    if (a.reasoning) out.push("reasoning:", fence(a.reasoning), "");
    if (a.content) out.push(fence(a.content), "");
    if (a.tool_calls.length) out.push("tool_calls:", fence(JSON.stringify(a.tool_calls, null, 2), "json"), "");
  } else {
    out.push(call.response ? fence(call.response) : "_none_", "");
  }
  return out.join("\n");
}
