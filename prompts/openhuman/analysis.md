# OpenHuman harness analysis (smoke-2 / m5-multistep, deepseek-v4.1-flash)

Numbers: system.txt = 4006 chars (~1.0k tok); tools.json = 31 tools, ~25.3k chars compact (~6.3k tok);
request_bytes 28847 on call 14; prompt_tokens 7601 -> 8257 over 4 calls. Tools are ~85% of the prompt (30.2k pretty-printed).

## 1. Prompt structure (system.txt, in order; chars)
| section | chars | static? | source (prompts/) |
|---|---|---|---|
| `### SOUL.md` + `# OpenHuman` + `## When OpenHuman is criticized` | 13+219+137 | static | SOUL.md (355 B) |
| `### IDENTITY.md` / `# Identity` | 17+139 | static | IDENTITY.md |
| `### ROLE.md` / `# Master Agent` | 13+185 | static | ROLE.md |
| `## Routing` | 1174 | static | ROLE.md (the bulk of the prompt) |
| `## Sub-agents` | 399 | static (refers to `[active_subagents]`, injected elsewhere) | ROLE.md |
| `## Grounding and tool use` | 598 | static | ROLE.md |
| `## Current Date & Time` | 206 | static rule only | `DateTimeSection` in sections.rs (~L677) |
| `## Memory access`, `## Remembering` | 188+149 | static | ROLE.md |
| `# Writing style` | 228 | static | STYLE.md (GLOBAL_STYLE_SUFFIX in builder.rs) |
| `## Workspace` | 149 | static by design: "Tools resolve in `pwd`" (no path printed) | `WorkspaceSection` sections.rs ~L491 |
| `## Capabilities not in your tool list` | 192 | static | sections.rs (tool_search hint area) |
Files are inlined with literal `### SOUL.md` headers, a bootstrap-file artefact (budget cap 20K/file per README) that costs nothing but reads oddly. Whole system prompt is
static: the first user message carries the only volatile field, `Current Date & Time: 2026-10-02 08:06:26 UTC (UTC, UTC+00:00), Friday`, prepended to the user text (not in system), so the prefix stays cacheable. No env/cwd/git/OS block, no AGENTS.md, no tool-usage essay, no sampling of memory in this capture (USER.md/memory sections absent for a fresh profile).

## 2. Instruction style
- Extremely terse, telegraphic, descriptive-imperative mix. Persona is one line: "Warm, direct, no filler; say \"I'm not sure\" rather than guess. The user drives."
- Markdown headers + bullets only; no XML, no caps-lock emphasis, no examples. Few negatives, all short: "Never invent names, ids, paths, URLs, quotes or numbers", "never refuse from the list or paste OAuth URLs", "never say saved without a successful write this turn".
- Priority rule via ordering: "First match wins:" routing list. Good, cheap, deterministic.
- Style rule: "Never use em-dashes; use commas, colons or two sentences." Ironically 20+ tool descriptions use em-dashes (e.g. build_workflow "Workflow authoring specialist — owns...", composio_connect "inline in the chat**. ... — the user").
- Weakness: it is a consumer-assistant prompt. There is zero coding doctrine in the base prompt: no read-before-edit, no test-then-finish, no minimal-diff, no git rules. All of that is pushed behind `use_skill coding` ("`use_skill` `coding`/`system`/`web3`/`docs` first; edit and verify in the same turn").

## 3. Tool-use policy
- Parallel: "batch independent calls." and "Fan-out is just several spawns in one message; they run concurrently." Present but one line.
- Which tool for what: Routing list maps intent -> tool (web: `web_answer_tool` / `web_search_tool` / `web_fetch`; memory: `memory_recall`; MCP via `tool_search`). Nothing about shell vs a dedicated read/grep tool because there is none (see gaps).
- Act vs ask: "Ask only if the ambiguity changes the tool." "Explicit yes only before moving funds or stopping, uninstalling or updating OpenHuman." Strong bias to act: "Make a tool call in the message that announces it; keep going until done".
- Verification: only "edit and verify in the same turn" and todo text "mark an item `completed` only after its work has run and its result is in the conversation". Observed run: model did `cat`, `apply_patch`, `python3 -m unittest`, stopped. Fine, but driven by model, not prompt.
- Stop conditions: `goal_complete` "Only call this when concrete evidence confirms the objective is satisfied". No explicit final-answer verbosity rule beyond "# Writing style: ... answer first, only useful context".
- Grounding: "Worker summaries are claims: check them against their evidence. Truncated output is incomplete." Distinctive and good.

## 4. Tool schema design
31 tools, ~25.3k chars. Heaviest (schema_chars / desc_chars): use_skill 524/1673 (2424 total JSON), run_workflow 473/988 (1580), build_workflow 321/963 (1418), spawn_async_subagent 968/240 (1360), discover_workflows 1162 total, shell 604/281 (1005), todo 448/476 (1046), memory_store 643/199 (959), apply_patch 464/350 (939).
- ~11 of 31 tools are workflow plumbing (`await_workflow`, `build_workflow`, `describe_workflow`, `discover_workflows`, `list_workflow_runs`, `list_workflows`, `read_workflow_run_log`, `run_workflow`) = ~7.0k chars (~28% of tools) shipped on every coding turn, plus `juice_*` x3 + `tinyjuice_retrieve` (~1.5k) and 2 memory-retrieval tools + `retrieve_memory`. Irrelevant to the task.
- Lazy loading: two layers. (a) `tool_search` ("Find a tool that is not in your tool list ... returns the matching tools with their full argument schemas. Invoke a match with `tool_call`") + `tool_call` with `arguments` as a JSON-encoded STRING ("encoded as a JSON string"). (b) `use_skill`: "Their names, descriptions and argument schemas are NOT in your context until you ask for them: call this with `skill` alone to see them". 16 skills listed in an enum inside the description (1673 chars). Good idea; but string-encoded args in `tool_call` lose schema validation and are error-prone for weak models, and double indirection (use_skill -> tool vs tool_search -> tool_call) is two mechanisms for the same job.
- Edit primitive: `apply_patch` is actually multi-file exact-string replace: "Apply a batch of exact-string edits across one or more files atomically. All edits are validated before any are written; validation failure rolls back the whole batch." Create = empty `old_string`. Good: atomic, batch, `replace_all` default false. Misnamed (not a diff patch format; models trained on codex apply_patch will mis-send). Worked first try in capture.
- No read_file, grep, glob, ls tool in the default list: reading is `cat` via `shell` (observed: `pwd && ls -la && ... cat calc.py && cat test_calc.py`). Search/read tools sit behind `use_skill coding`. No line-numbered reads, no offset/limit, no read-before-edit enforcement visible.
- `shell`: params `command` (required), `timeout_secs` (1..3600, good doc "Use a larger value for long-running work (builds, test suites, solvers)"), `category` enum read/write/network/install/destructive "Optional self-declared risk; can only raise the approval requirement" (neat approval hook). No background/pty/cwd param. Description 281 chars, includes policy tip "Only stdout/stderr comes back ... print what you need".
- Descriptions embed policy heavily (todo: "Keep one item `in_progress`"; spawn_async: "never for user-visible answers, writes, financial actions"; continue_subagent: "Always prefer this to re-delegating"; memory_store: "Call it before you confirm."). Good density. But some are too long for weak value: run_workflow 988, build_workflow 963, discover_workflows 718 chars, `use_skill` 1673.
- Waste in schemas: `todo.status` enum has 13 aliases ("pending","todo","open","not_started","in_progress","in-progress","inprogress","started","active","completed","complete","done","finished"), bloating and confusing the schema to tolerate weak models. `todo.todos` type `["array","null"]`. `additionalProperties:false` used on todo only; no `strict` flag anywhere (strict None on all 31).
- Duplicate/overlapping tools: `memory_recall` vs `retrieve_memory` vs `tinyjuice_retrieve`; `web_search_tool`/`web_answer_tool`/`web_contents_tool`/`web_fetch` (4 web tools, `provider` param on three leaks backend: "Backed by: exa (tried in that order; later providers are fallbacks)"); `juice_find/extract/summarize` (3 tools for post-hoc output compression, juice_find has 8 params and mode names grep/sed/awk/jq in one string).
- Naming inconsistent: `web_search_tool` suffix vs `web_fetch`; `retrieve_memory` vs `memory_recall` vs `memory_store`.

## 5. Caching / context layout
- Static-first: system (4006 chars, identical across calls: `same_sys` true, `same_tools` true), tools identical, first user message holds the date. Message prefix reused: `prefix_reused` "1/1","3/3","5/5" i.e. append-only history.
- `prompt_cache_key: tap-80b9ff3f3251115b` set (stable across calls) and `cache_control_markers: 0` (implicit prefix cache; DeepSeek). `temperature: 0.4`, `max_tokens: 16384`, `tool_choice: auto`.
- cached_tokens / prompt_tokens: 7424/7601 (97.7%), 7680/7964 (96.4%), 7936/8142 (97.5%), 8064/8257 (97.7%). Cache granularity 128 tokens visible. Call 14 was already warm (no cache write column used).
- Volatile bits are correctly placed: date is in the user turn. Risk: the date line is on "the latest message", so each new turn it changes the user message text; fine because it is after the prefix. README notes a resumed session's prompt/tool list is frozen (CLAUDE.md "Sessions") which protects the cache across restarts at the cost of stale prompts.
- Cost: ~$0.00019-0.00031 per call. The ~6.3k-token tools block is all cached, so waste is latency/context, not dollars on this model.

## 6. Planning / subagents / memory / skills / safety
- Planning: `todo` ("work with 3+ steps"; "Replace the list at most once per assistant response"; "Writing the list is bookkeeping, not work: in the same response ... do the next step"). Excellent anti-stall wording. ROLE: "3+ steps: `todo`, then execute."
- Subagents: `spawn_async_subagent` (enum of 10 agent_ids incl. agent_memory, workflow_builder, vision_agent), `continue_subagent`, `list_subagents`, `[active_subagents]` roster injected: "`[active_subagents]` is the truth about workers; never spawn a duplicate." `blocking: true` on delegate tools for gating results. Handoff protocol: "Act on a returned `## Handoff Plan` yourself; distill replies, never paste them." Rich, but fire-and-forget async spawns are explicitly barred from anything gating the reply.
- Memory: read rule "Asked about people, projects, past decisions or the user: `memory_recall` (or `memory_search`) first. Say something isn't stored only after a retrieval came back empty." Note `memory_search` is named in the prompt but is not in the 31 tools (a dangling reference; real tools are `memory_recall`, `retrieve_memory`). Write rule: "Write it before you confirm with `memory_store`".
- Skills: 16 named skills behind `use_skill` (workflows, web3, mcp, composio, skills, documents, audio, system, coding, storage, scheduling, profile, media, tasks, goals, docs).
- Safety: "Never work around approval or sandbox layers." "Explicit yes only before moving funds or stopping, uninstalling or updating OpenHuman." Approval lives in code via shell `category`. Privacy: "Privacy first." Dangling-name defence: "other unlisted names always fail, so don't retry them."

## 7. Worth copying / avoid
Copy (to others): "First match wins" intent router; todo description anti-stall text; "Worker summaries are claims"; "say whether an answer came from a tool, memory or general knowledge"; shell `category` can-only-raise risk; atomic multi-file `apply_patch` with create-by-empty-old_string; timestamp on user turn not system; 97%+ cache hit with stable `prompt_cache_key`; whole system prompt at ~1k tokens.
Gaps vs strong coding harnesses (be critical):
1. No dedicated read/grep/glob in the default tool list; coding doctrine hidden behind `use_skill coding` (extra round trip, model-dependent: in the capture it skipped the skill and used `cat`). No read-before-edit rule, no "prefer dedicated tools over shell", no cwd/git/OS/env block (only "Tools resolve in `pwd`", forcing a `pwd` call first, seen in call 1).
2. ~7.0k chars of workflow tools + ~1.5k juice tools + 3 memory tools always loaded for a non-workflow task (~9k+ chars, about 2.3k tokens, ~30% of tools) while the system prompt is only 1k tokens. Tools : system ratio is ~6:1; move workflow/juice behind `use_skill` or `tool_search` like the others.
3. Two lazy-loading schemes (tool_search+tool_call with JSON-string args; use_skill with `args` object) and `tool_call.arguments` as a stringified JSON: invites escaping errors and defeats provider-side schema validation.
4. `todo.status` 13-value enum; `apply_patch` name mismatch with its semantics; em-dash rule violated by its own tool text; `memory_search` named in prompt but not provided; 4 web tools with leaky `provider` param.
5. No strict/additionalProperties on 30/31 tools; no `cache_control` markers (fine for DeepSeek, would matter on Anthropic where caching is explicit).
6. Output-verbosity and final-summary guidance is one 228-char style block; no rule on reporting test results/failures honestly beyond "When something fails, try another way, then say what failed."
