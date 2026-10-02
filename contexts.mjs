// contexts.mjs — which calls belong to the main agent and which are side or sub-agent requests.
//
// A harness does not talk to the model with one prompt. Besides the main agent loop it may send a
// title generator (OpenCode, Hermes), a summariser, or sub-agents that each carry their own system
// prompt and tool list. A call's *context* is its system prompt plus tool list. Within one task the
// main agent is the context that made the most calls, ties going to the larger static prompt (a
// tool-less title request never beats the agent that has the tools). Everything else is "side".
// Totals (tokens, cost, errors) still count every call: side traffic is real spend. Only
// per-agent facts (static prompt size, cache continuity) are read from the main context.

/** Context id of a meter record: the proxy's hash pair when present, else the measured sizes. */
export const contextOf = (r) => r.context ?? `${r.system_prompt_tokens ?? "?"}/${r.tool_schema_tokens ?? "?"}/${r.tool_count ?? "?"}`;

const staticSize = (r) => (r.system_prompt_tokens ?? 0) + (r.tool_schema_tokens ?? 0);

/**
 * Split one task's calls into contexts and name the main one.
 * @param {object[]} calls  meter records of a single task, in call order
 * @returns {{main: string|null, contexts: Map<string, {id: string, calls: object[], role: string}>}}
 */
export function classify(calls) {
  const contexts = new Map();
  for (const r of calls) {
    const id = contextOf(r);
    if (!contexts.has(id)) contexts.set(id, { id, calls: [], role: "side" });
    contexts.get(id).calls.push(r);
  }
  let main = null;
  for (const c of contexts.values()) {
    const sized = c.calls.find((r) => r.system_prompt_tokens != null) ?? c.calls[0];
    c.size = staticSize(sized);
    if (main === null || c.calls.length > main.calls.length || (c.calls.length === main.calls.length && c.size > main.size)) main = c;
  }
  if (main) main.role = "main";
  // Number the side contexts in order of first appearance: side 1, side 2, ...
  let n = 0;
  for (const c of contexts.values()) if (c.role === "side") c.label = `side ${(n += 1)}`;
  if (main) main.label = "main";
  return { main: main?.id ?? null, contexts };
}
