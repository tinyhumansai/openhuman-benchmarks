# Codex CLI 0.159.3 harness analysis (deepseek-v4.1-flash via Responses API, task m5-multistep)

Sizes: system.txt 19,303 chars (~4.8k tok); tools.json 20,250 chars (~5k tok); calls 11-14 prompt_tokens 9,155 -> 10,147.
Wire: Responses API, `store:false`, `stream:true`, `tool_choice:"auto"`, `parallel_tool_calls:true`, `reasoning:{effort:"high",summary:"auto"}`, `include:["reasoning.encrypted_content"]`.

## 1. Prompt structure (order, size, volatility)
All of the following lives in `instructions` (system.txt); lines refer to system.txt.
| # | Section | ~chars | Static? |
|---|---|---|---|
| 1 | Identity + capabilities (L1-9): "You are a coding agent running in the Codex CLI" | 1.2k | static |
| 2 | `# How you work` / `## Personality` (L11-15) | 0.6k | static |
| 3 | `# AGENTS.md spec` (L17-27) | 1.3k | static (spec only; AGENTS.md contents ride in developer msg) |
| 4 | `## Responsiveness` / preamble messages + 8 example quotes (L29-50) | 1.7k | static |
| 5 | `## Task execution` (L52-76) | 2.4k | static |
| 6 | `## Validating your work` (L78-92) | 2.0k | static |
| 7 | `## Ambition vs. precision` (L94-100) | 0.9k | static |
| 8 | `## Sharing progress updates` (L102-108) | 1.1k | static |
| 9 | `## Presenting your work and final message` + final-answer style rules (L110-185) | 6.0k (largest, ~31%) | static |
| 10 | `# Tool Guidelines` / `## Shell commands` (L187-194) | 0.4k | static |
| 11 | `<skills_instructions>` (L197-207) | 2.0k | per-install (skill list, root `/tmp/bench-home/.codex/skills/.system`) |
| 12 | `<permissions instructions>` (L208-211) | 0.4k | per-run config (sandbox/approval) |

Sections 11-12 appear at the tail of system.txt AND as the first `developer` input message (msg 3799a981), i.e. captured system.txt is instructions+developer-message merged for display; on the wire they are input items.
Per-session volatile context goes in the first user message, not the system prompt: `<environment_context><cwd>/work</cwd><shell>bash</shell><current_date>2026-10-02</current_date><timezone>Etc/UTC</timezone>...` then the real task as a separate user message. Message order: developer(skills+permissions) -> user(env context) -> user(task).
Model-facing metadata (turn_id, installation id, git hash) goes in `client_metadata`/headers, not in the prompt (good for caching).

## 2. Instruction style
- Tone: descriptive persona then imperative rules. "Your default personality and tone is concise, direct, and friendly."
- Markdown headers (`##`), bullets, bold; only one XML-ish block family (`<skills_instructions>`, `<permissions instructions>` - note the space, malformed tag name, `<environment_context>`).
- Emphasis: sparse capitals: "You MUST adhere to the following criteria", "Do NOT guess or make up an answer", "NEVER add copyright or license headers", "NEVER try `applypatch` or `apply-patch`, only `apply_patch`".
- Many negative rules: "Do not attempt to fix unrelated bugs or broken tests", "Do not `git commit` your changes or create new git branches unless explicitly requested", "Do not add inline comments within code unless explicitly requested", "Do not use one-letter variable names unless explicitly requested", "NEVER output inline citations like ...".
- Examples: 8 preamble quotes (e.g. "Spotted a clever caching util; now hunting where it gets used.") and one apply_patch JSON example. The examples are chatty/personality-driven, ~0.7k chars of pure style.
- Contradictory pressure: "Brevity is very important as a default ... no more than 10 lines" vs. "Keep your tone light, friendly and curious: add small touches of personality in preambles" vs. "Before making tool calls, send a brief preamble".

## 3. Tool-use policy
- Persistence/stop: "keep going until the query is completely resolved, before ending your turn ... Only terminate your turn when you are sure that the problem is solved."
- Ask-vs-act: approval-mode dependent. "When running in the non-interactive approval mode **never**, proactively run tests, lint"; in "untrusted"/"on-request" "hold off on running tests or lint commands until the user is ready". Permission block here: "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason".
- Verification: "start as specific as possible to the code you changed ... then make your way to broader tests"; formatting retries capped: "you can iterate up to 3 times to get formatting right".
- Edit policy: "Use the `apply_patch` tool to edit files" with an exec JSON example `{"command":["apply_patch","*** Begin Patch\\n*** Update File: ..."]}`. "Do not waste tokens by re-reading files after calling `apply_patch`".
- Search: "prefer using `rg` or `rg --files` ... much faster than alternatives like `grep`"; "Do not use python scripts to attempt to output larger chunks of a file."
- No read-before-edit rule; no dedicated read/grep/glob tools - everything is shell.
- Parallel calls: API flag `parallel_tool_calls:true` but the prompt says nothing about parallelising (zero mentions in system.txt).
- Output verbosity: "no more than 10 lines" default; progress updates "no more than 8-10 words long"; preambles "1-2 sentences ... (8-12 words for quick updates)". Detailed final-answer formatting spec (headers `**Title Case**`, `-` bullets, backticks, "Do not provide range of lines", no nested bullets).
- Observed model behaviour (call 13-14): the model tried `apply_patch <<'EOF'` in the shell and got `apply_patch: command not found`, because the prompt mandates apply_patch but tools.json has NO apply_patch tool (9 tools: exec_command, write_stdin, request_user_input, view_image, multi_agent_v1, get_goal, create_goal, update_goal, web_search). Its reasoning: "the tool list doesn't include apply_patch directly". Prompt/schema mismatch cost a full wasted call (~365 prompt tokens + completion) and a failed verification.

## 4. Tool schema design
| Tool | desc chars | params (req) | schema_chars |
|---|---|---|---|
| exec_command | 82 | 10 (1) | 1,395 |
| write_stdin | 80 | 4 (1) | 618 |
| request_user_input | 120 | 1 (1) | 1,142 |
| view_image | 124 | 1 (1) | 162 |
| multi_agent_v1 (namespace: close_agent, resume_agent, send_input, spawn_agent, wait_agent) | 43 | - | ~10,000 (spawn_agent alone 6,688; its description 5,033) |
| get_goal | 122 | 0 | 76 |
| create_goal | 265 | 2 (1) | 408 |
| update_goal | 1,541 | 1 (1) | 536 |
| web_search (`{"type":"web_search","external_web_access":true}`) | - | - | ~60 |
- Heaviest: `spawn_agent` (6.7k chars, ~1.7k tok, one third of all tool bytes) and whole `multi_agent_v1` namespace ~50% of tools.json; it is shipped on every call though it also says "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents". Listing 5 model overrides ("gpt-6.1-sol", "gpt-6-astra"...) in the description is dead weight for a deepseek run.
- Shell tool design is rich: `exec_command` runs "in a PTY"; params `cmd`, `workdir`, `shell`, `login`, `tty`, `yield_time_ms` ("effective range is 250-30000 ms"), `max_output_tokens` ("Defaults to 10000 tokens"), `sandbox_permissions` enum `["use_default","require_escalated"]`, `justification`, `prefix_rule`. Long-running processes: returns "a session ID for ongoing interaction" and `write_stdin(session_id, chars, yield_time_ms)` polls/writes (empty `chars` polls, "empty polls wait 5000-300000 ms"). No explicit timeout kill param; yield-and-resume instead. Tool output header: `Chunk ID / Wall time / Process exited with code / Original token count / Output:`.
- Descriptions are short for core tools (one sentence) and keep policy in the system prompt; policy lives in descriptions only for goal tools (update_goal 1,541 chars of status rules), spawn_agent, request_user_input ("only available in Plan mode").
- Param descriptions carry the defaults/ranges ("Defaults to true", "Defaults to the turn cwd") - good, cheap.
- `"strict": false` on every function; `additionalProperties:false` everywhere. No lazy tool loading / tool_search; all tools inline each call. Approval-related params (`sandbox_permissions`, `justification`, `prefix_rule`) are shipped even when the policy is "never" (~0.5k chars wasted here).
- Edit primitive: custom patch format (`*** Begin Patch` ... `*** Update File`) but delivered through shell, not a schema'd tool here.

## 5. Caching / context layout
- Layout is static-first: instructions (static) -> tools (static) -> developer msg -> env context -> task -> assistant/tool turns appended. Volatile date/cwd are in a user message AFTER the static prefix, so they do not bust the system cache.
- No cache_control markers (`cache_control_markers: 0`); relies on automatic prefix caching plus `prompt_cache_key` = session/thread id `01a0fba7-8258-7680-876d-6523364745dd` (constant across calls; also `x-client-request-id`, `session-id`, `thread-id` headers).
- calls.json: same_sys true, same_tools true on seq 12-14; prefix_reused 3/3, 6/6, 10/10.
- cached_tokens: call 11 0/9,155 (cold, cost $0.00284); call 12 9,216/9,491 = 97.1% ($0.00029); call 13 9,600/9,856 = 97.4%; call 14 9,984/10,147 = 98.4%. Cached amounts are multiples of 128, so up to 127 tokens trail uncached. ~10x cost drop from call 1 to 2.
- Volatile things: `x-codex-turn-metadata` header contains turn_id and timestamps (header only, not body - fine). `reasoning.encrypted_content` is requested; with this provider reasoning items return with `encrypted_content: null` and ids `rs_tmp_*`, and assistant message ids `msg_tmp_*` in later turns - ids that change are harmless as long as the prior prefix is byte-identical (observed reuse OK).
- Per-call growth is small (~300-370 tokens/turn) so caching dominates.

## 6. Planning / todo / subagents / memory / skills / safety
- Plans: capability line "making & updating plans" but no `update_plan` tool in this capture (tools.json has none); `request_user_input` is Plan-mode only. A goal system (`get_goal`/`create_goal`/`update_goal`) with strict state-machine rules in the description: "Do not mark a goal complete merely because its budget is nearly exhausted" and a blocked audit "at least three consecutive goal turns".
- Subagents: spawn/wait/send_input/close/resume; "Call wait_agent very sparingly", "Do not repeatedly wait by reflex", "disjoint write set" for code tasks, but gated by "Do not spawn sub-agents unless the user ... explicitly ask".
- Memory/instructions: AGENTS.md scope & precedence spec ("More-deeply-nested AGENTS.md files take precedence"; "Direct system/developer/user instructions ... take precedence"). No auto-memory.
- Skills: progressive disclosure - only name+description+short path (`r0/imagegen/SKILL.md`) with a "skill roots" table (`r0` = path) to shorten paths; body loaded on demand. 2.0k chars for 4 skills.
- Safety/approval: sandbox_mode + approval policy injected as a small developer block; escalation via `sandbox_permissions:"require_escalated"` + `justification` + `prefix_rule`. Capability preamble: "you can request that these function calls be escalated to the user for approval". Also "Analyzing code for vulnerabilities is allowed" / "Working on the repo(s) ... even if they are proprietary" (explicit permission statements to curb refusals).

## 7. Ideas worth copying / things to avoid
Copy:
1. Env/date/cwd in a trailing user message and sandbox/approval in a developer message - keeps instructions+tools byte-stable (97-98% cache hits).
2. `prompt_cache_key` = stable session id, and stable tool order.
3. Shell tool with yield-and-poll PTY sessions (`yield_time_ms`, `write_stdin`, `max_output_tokens`) instead of a blocking timeout; output prefixed with exit code, wall time and original token count (cheap self-reporting of truncation).
4. Skills as name+description index with a path-root alias table.
5. Approval-mode-dependent verification policy (run tests proactively only when mode is `never`).
6. "Do not waste tokens by re-reading files after calling apply_patch" and "start as specific as possible" test ladder; capped formatting retries (3).
7. Param descriptions embed defaults/ranges; short one-line tool descriptions.
Avoid / waste:
1. `multi_agent_v1` ~10k chars (~2.5k tok, ~half of tool payload) always shipped, mostly telling the model NOT to use it unless asked; load lazily or only when delegation is authorized. Includes irrelevant model-override list (5 gpt-* models).
2. Prompt mandates `apply_patch` but no such tool/binary exists in this capture - model failed once ("apply_patch: command not found") and fell back to `cat > calc.py`. Ensure prompt and tool list agree.
3. Final-answer formatting spec ~6k chars (~1.5k tok, 31% of the system prompt) with fiddly rules ("Do not provide range of lines", "Never mix monospace and bold markers"); aimed at a CLI renderer and costs tokens every call (though cached).
4. Conflicting verbosity directives (light/curious personality + 8-12-word preambles + 10-line cap) and 8 whimsical example preambles.
5. Approval/escalation params (`sandbox_permissions`, `justification`, `prefix_rule`) and `request_user_input` (Plan-mode only) shipped when approval is "never" and the mode isn't Plan: ~1.5k chars dead.
6. Goal tools (get/create/update, ~2.2k chars incl. a 1.5k-char update_goal) shipped though `create_goal` says "only when explicitly requested".
7. Malformed pseudo-tag `<permissions instructions>` (space in tag name).
8. No parallel-call guidance in prompt despite `parallel_tool_calls:true`; no read-before-edit rule.
Token budget summary: of ~9.2k first-call tokens, ~4.8k system + ~5k tools; roughly 3.5-4k of that is policy for features unused in a simple fix task.
