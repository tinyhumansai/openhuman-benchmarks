# opencode (v1.18.34) harness analysis

Sources: system.txt (9578 chars ~2.4k tok), tools.json (21124 chars ~5.3k tok, 10 tools), calls.json, params.json,
aux-system-0.txt (2206 chars), captures m5-multistep seq 15-19. Model: deepseek-v4.1-flash via OpenRouter, chat-completions format.
NOTE: in each task the title-generation call is seq 15 (first), the MAIN agent call is the SECOND call (seq 16). The two
calls have different system prompts and different tool sets, so they cannot share a cache prefix.

## 1. Prompt structure (system.txt, in order; chars)
| # | section | chars | static? |
|---|---------|-------|---------|
| 1 | Identity + URL rule + help/feedback + "When the user directly asks about opencode ... WebFetch" | 883 | static |
| 2 | `# Tone and style` incl. 9 verbosity `<example>` blocks | 3244 (34%) | static |
| 3 | `# Proactiveness` | 627 | static |
| 4 | `# Following conventions` | 1083 | static |
| 5 | `# Code style` ("DO NOT ADD ***ANY*** COMMENTS") | 70 | static |
| 6 | `# Doing tasks` (lint/typecheck, no-commit rule, system-reminder note) | 1434 | static |
| 7 | `# Tool usage policy` | 690 | static |
| 8 | stray `IMPORTANT: Before you begin work, think about what the code you're editing...` | 138 | static |
| 9 | `# Code References` (file_path:line_number + example) | 360 | static |
| 10 | `You are powered by the model named deepseek/...` + `<env>` (cwd, git, platform, date) | 348 | per-session (date = daily) |
| 11 | `<available_skills>` (one skill, customize-opencode) | 701 | per-project/session |
Total 9578 chars. Roughly 90% static, volatile tail (model name, env, date, skill list) is LAST -> good for prefix caching.
Reads like the older Claude Code prompt (near-verbatim "Tone and style", "Proactiveness", "Following conventions").
First user message (captures blob 2391501adbe3fdce) is the raw task text wrapped in literal quotes: `"The tests in test_calc.py fail. ..."`.
No env/reminder is injected into user turns; all volatile context is in the system prompt tail.
Total request prompt = 7370 tokens for first main call, of which system ~2.4k and tools ~5.3k (tools are ~70% of fixed overhead).

## 2. Instruction style
- Imperative, terse, heavy caps emphasis: `IMPORTANT:` x4 in Tone section, `VERY IMPORTANT:`, `NEVER`, `MUST`, `DO NOT ADD ***ANY*** COMMENTS`.
- Markdown headings + bullet lists; XML only for `<example>` blocks and `<env>`/`<available_skills>`.
- Extreme brevity mandate, repeated three times: "You MUST answer concisely with fewer than 4 lines (not including tool use or code generation)",
  again in "Tool usage policy" ("You MUST answer concisely with fewer than 4 lines of text"), plus "One word answers are best."
  Examples teach it: `user: what is 2+2?` / `assistant: 4`.
- Negative rules plentiful: "NEVER generate or guess URLs", "NEVER commit changes unless the user explicitly asks",
  "do not say why or what it could lead to" (refusals), "Only use emojis if the user explicitly requests it".
- Self-contradictions / noise: "explain what the command does and why" for bash vs "NOT answer with unnecessary preamble";
  "Only use tools to complete tasks" vs verbosity; the orphan line "Before you begin work, think about what the code you're editing is supposed to do based on the filenames directory structure" (138 chars, unclear value).

## 3. Tool-use policy
- Parallel: "You have the capability to call multiple tools in a single response... you MUST send a single message with multiple tools calls". Observed: seq 17 assistant issued two parallel `read` calls (test_calc.py + calc.py).
- Dedicated tools over shell: bash description: "DO NOT use it for file operations (reading, writing, editing, searching, finding files)" with a mapping list "File search: Use Glob (NOT find or ls) / Content search: Use Grep (NOT grep or rg) / Read files: Use Read (NOT cat/head/tail) / Edit files: Use Edit (NOT sed/awk)". Contradiction: grep tool says "use the Bash tool with `rg`... Do NOT use `grep`" for counting.
- Read-before-edit: enforced in tool text ("You must use your `Read` tool at least once in the conversation before editing", write: "you MUST use the Read tool first").
- Verification: "Verify the solution if possible with tests. NEVER assume specific test framework"; "VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands"; if unknown "ask the user for the command ... suggest writing it to AGENTS.md".
- Ask-vs-act: "You are allowed to be proactive, but only when the user asks you to do something"; "if the user asks you how to approach something... answer their question first, and not immediately jump into taking actions".
- Stop condition: "After working on a file, just stop, rather than providing an explanation of what you did."
- Search delegation: "When doing file search, prefer to use the Task tool in order to reduce context usage"; but task tool says not to use it for specific files/classes (consistent).
- Convention discovery: "NEVER assume that a given library is available ... check package.json (or cargo.toml...)".
- Output verbosity rule: <4 lines; code refs as `file_path:line_number`.
- Commits only on request; git/PR workflow lives in bash tool description (not system prompt).

## 4. Tool schema design (tool-table.json)
| tool | desc chars | schema chars | params (req) | note |
|------|-----------|--------------|--------------|------|
| bash | 4628 | 492 (5310 total) | command, timeout, workdir (1) | heaviest: embeds git/PR policy, quoting rules, tool-substitution table |
| task | 3019 | 724 (3897) | description, prompt, subagent_type, task_id, command (3) | subagent list (explore, general) embedded in description |
| todowrite | 2012 | 536 (2728) | todos[] of {content,status,priority} (1) | long when/when-not policy + examples |
| edit | 1369 | 498 (1994) | filePath, oldString, newString, replaceAll (3) | |
| read | 1158 | 479 (1771) | filePath, offset, limit (1) | |
| webfetch | 750 | 443 (1328) | url, format(enum text/markdown/html, default), timeout | |
| grep | 657 | 431 (1212) | pattern, path, include | |
| write | 623 | 317 (1051) | content, filePath (2) | |
| glob | 517 | 510 (1138) | pattern, path | |
| skill | 399 | 194 (695) | name | |
Total 21124 chars. Descriptions are 15-20x larger than param schemas: policy lives in descriptions (bash has 4.6k chars; ~22% of tool bytes, ~1.2k tok).
- Names: lowercase single words; camelCase params (filePath, oldString, newString, replaceAll).
- Edit primitive: exact str-replace, `replaceAll` bool; errors spelled out ("oldString not found in content", "Found multiple matches...") so the model can self-correct. Whole-file `write` is separate.
- Shell: persistent session, `timeout` ms (default 120000), `workdir` param to avoid `cd &&`; output truncation >2000 lines/51200 bytes saved to file, read with Read offset/limit. No background/pty flag. Schema has silly bounds `minimum: -9007199254740991, maximum: 9007199254740991` on integers (zod defaults, wasted tokens, repeated in read offset/limit).
- No `strict` flags (strict: null on all). todo `status`/`priority` are free strings with allowed values only in the description, not enum.
- `task.command` param ("The command that triggered this task") is odd internal plumbing exposed to the model.
- Lazy loading: none of tool_search/describe; all 10 tools always sent. Skills are lazy (listed in system prompt, body loaded via `skill` tool).
- Read: can read dirs, images, PDFs; line-prefixed `<line>: <content>`; "Avoid tiny repeated slices (30 line chunks)".

## 5. Caching / context layout
- Order: system (static first, env/skills last) -> tools -> messages. Tool order is stable (alphabetical: bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write).
- No cache_control markers (0), no prompt_cache_key (null). Relies on provider automatic prefix caching plus session headers
  `x-session-affinity` / `x-session-id` / `x-opencode-session-id` (same value) to pin the same backend. Smart: affinity header serves cache without explicit keys.
- Measured (calls.json): seq16 prompt 7370, cached 0; seq17 7662 / cached 7424 (96.9%); seq18 7797 / 7552 (96.9%); seq19 7869 / 7680 (97.6%).
  same_system=true, same_tools=true, prefix_reused 1/1, 4/4, 6/6 messages. Cost fell from $0.00231 to $0.00026/call.
- Cache ratio is block-quantised (7424 = 58*128); the uncached remainder is just the new messages.
- Title call (seq 15): 581 prompt tokens, no tools, cached 0, different system -> the title call never warms the main cache and the main
  call's first request is always cold (7370 tok). The title call runs in parallel/before, so cost is tiny ($0.00018).
- Volatile in system: date ("Fri Oct 02 2026") and model name in the `<env>` tail; date flip at midnight would bust the cache once per day. Sits after 9.2k chars of static text, so only the tail is at risk. No git status/timestamp-by-second.
- Assistant turns replay `reasoning_content` back to the provider (blob 4f6f371a351a81ff).

## 5b. Auxiliary title generation (aux-system-0.txt, 2206 chars, 581 prompt tokens)
- Separate system: "You are a title generator. You output ONLY a thread title. Nothing else." with `<task>`, `<rules>` (15 rules), `<examples>` (10 input -> title pairs).
- User message is literally `"Generate a title for this conversation:\n"` (blob d624df695324e31b) -- the second blob in seq 15 is the same task text as the main call (2391501adbe3fdce), so the conversation is passed as a following user message.
- Constraints: "A single line", "≤50 characters", "Never include tool names", "same language as the user message", "DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT". max_tokens 32000 (not capped to ~20, wasteful but harmless), no tools, no tool_choice.
- Completion was 7 tokens. Good pattern: a cheap side call with its own tiny prompt, not the full harness prompt.
- Cost point: running it with the full 7.4k-token prompt would be 12x larger; isolating it is the right call.

## 6. Planning / todo / subagents / memory / skills / safety
- Todos: `todowrite` carries ~2k chars of policy ("When in doubt, use it."; "exactly ONE `in_progress`"; "Mark `completed` only after the required work is actually done, including any required verification. Never based on intent."). System prompt has NO todo mention (in contrast to older Claude Code) -> policy only in tool description, so it costs 500 tok only if the tool is shipped.
- Subagents: `task` with explore (read-only search) and general agents; rules: "Each agent invocation starts with a fresh context unless you provide task_id", "The agent's outputs should generally be trusted", "Clearly tell the agent whether you expect it to write code or just to do research". Resumable via task_id.
- Memory: only AGENTS.md mention ("suggest writing it to AGENTS.md"); no memory tool, no instruction-file contents injected in this capture (cwd /work had none).
- Skills: lazy, progressive disclosure; name+description listed in `<available_skills>` in system; `skill` tool injects body. Built-in skill `customize-opencode` has a tight "Use ONLY when ..." trigger.
- `<system-reminder>` tags are mentioned as a convention ("Tool results and user messages may include <system-reminder> tags") but none appeared in the captured first user message.
- Safety/approval: no approval text in the prompt (approval is enforced in the host); only "Always follow security best practices. Never introduce code that exposes or logs secrets", git rules in bash description ("Do not update git config, skip hooks, use interactive `-i`, force-push"), "/tmp/opencode ... pre-approved for external directory access".

## 7. Distinctive ideas worth copying
1. Provider-side cache without markers: stable ordering + session-affinity headers -> 97% cached from call 2 (7424/7662).
2. `workdir` param on bash instead of `cd && ...` (saves quoting bugs, makes approvals path-scoped).
3. Truncated bash output spilled to file + instruction to Read/Grep it, "Do NOT use head/tail".
4. Explicit edit failure messages quoted in the description so models recover.
5. Tool-substitution table in bash description (find->Glob, grep->Grep, cat->Read, sed->Edit, echo->Write).
6. Lazy skills with the listing at the end of system prompt.
7. Isolated tiny title-generator call (581 tokens) with examples and hard format limits.
8. Subagent `task_id` resume.
9. Verbosity examples ("what is 2+2? -> 4") are effective few-shot for terseness.

## Wasteful / to avoid
- Tool schemas are 5.3k tok vs 2.4k system: 22% of tool bytes in bash alone (4628 chars ~1.2k tok) incl. a git/PR essay that is irrelevant for most turns; todowrite 2012 chars + task 3019 chars always shipped even for 1-step tasks (m5 needed neither). Candidates for lazy loading: ~9.6k chars (~2.4k tok, ~33% of the 7.4k prompt).
- Integer bounds `-9007199254740991..9007199254740991` on 5 params (zod artefact), `task.command` param, free-text status/priority instead of enum.
- Same "fewer than 4 lines" rule repeated 3x (~450 chars), 9 verbosity examples (~1.2k chars) take 13% of the system prompt.
- Contradictions: explain bash commands vs no preamble; grep tool says use Bash `rg` while bash says never use grep.
- Orphan "think about ... filenames directory structure" sentence; "DO NOT ADD ***ANY*** COMMENTS" shouting.
- Title call has max_tokens 32000 and no stop; cold first main call (0 cached) because the title call has a different prefix.
- Quoted raw task in the first user message (literal quotes) is harness-side artefact, not opencode's, but shows no user-turn context injection.
