# What each harness sends to the model

Source: `results/smoke-2/captures` (metering proxy, m5-multistep, first tools-bearing call;
model deepseek-v4 via OpenRouter, trivial tasks). Raw `system.txt`, `tools.json`, params and
per-call cache diagnostics are in [`prompts/<harness>/`](prompts/); per-harness write-ups are
`prompts/<harness>/analysis.md` (deepseek-harness's is summarised below only). Judge the
prompts and schemas here, not the model's behaviour: the tasks are tiny.

## Comparison

| harness | wire | system chars | tools (count / chars) | first-call prompt tok | caching | cached % calls 2+ |
|---|---|---|---|---|---|---|
| claude-code | anthropic | 5.8k | 20 / 46k | 15.3k | 3 `cache_control` | 94-95% |
| codex | responses | 19.3k | 9 / 17k | 9.2k | `prompt_cache_key` = session | 97-98% |
| deepseek-harness | chat | 4.5k | 25 / 25k | 7.2k | automatic prefix | 97% |
| hermes | chat | 17.1k / 20.1k | 24 / 40k | 13.7-14.4k | automatic prefix | 97-99% |
| openclaw | chat | 25.7k | 11 / 9k | 8.7k | automatic prefix | 94-96% |
| opencode | chat | 9.6k (+2.1k title call) | 10 / 21k | 7.4k | prefix + session-affinity headers | ~97% |
| openhuman | chat | 4.0k | 31 / 24k | 7.6k | `prompt_cache_key` stable | 96-98% |

Every harness keeps system + tools byte-identical and history append-only across calls, so
cache hit rate is ~95%+ everywhere after call 1. Cache is not where they differ; the
**fixed prefix size** and **what is in it** is.

## Cross-cutting findings

1. **Tool schemas dominate the fixed prefix, not the system prompt.** Tools are 2-12x the
   system prompt in claude-code (46k vs 5.8k chars), openhuman (6x), deepseek-harness (5.7x),
   opencode (2.2x). Only openclaw/codex/hermes carry big prompts. Trimming the always-on tool
   list is the biggest lever.
2. **Niche tools shipped every turn are the main waste.** claude-code: ~21k of 28.5k description
   chars are rarely used tools (SendMessage 4.3k, Workflow 3.5k, ScheduleWakeup 3.4k,
   EnterWorktree 3.2k, CronCreate 2.9k). codex: `multi_agent_v1` is about half of tool bytes
   (`spawn_agent` 6.7k). openhuman: ~6.0k chars workflow tools + 1.5k juice + 3 overlapping
   memory tools. opencode: `task`/`todowrite` unused in a one-step task. Fix: lazy-load by
   capability or intent, not a flat catalog.
3. **Lazy tool loading exists in three harnesses, all with the same shape**
   (`tool_search` -> `tool_call`; openclaw and hermes add a `tool_describe` step between them,
   openhuman's `tool_search` returns the full argument schemas directly): openclaw, hermes, openhuman. Pitfalls seen:
   hermes defers cheap-and-relevant tools (`todo_list`, `process_manage`) while always shipping
   browser/TTS/vision (~2k tokens in a coding run); openhuman's `tool_call` takes arguments as a
   JSON *string*, so the provider cannot validate them; openclaw still lists 30 deferred names
   (6.3k chars) in the prompt. Defer by relevance, take structured args, and keep the name
   catalog short.
4. **Put routing/usage policy in tool descriptions, one line in the prompt.** claude-code has a
   single routing line ("Prefer the dedicated file/search tools over shell commands when one
   fits"); read-before-edit lives in the Edit/Read descriptions. hermes' `read_file`: "Use this
   instead of cat/head/tail in terminal". deepseek-harness repeats "Use the read tool — not
   shell commands like cat" for read/glob/grep. Caveat: cheap models ignore it (deepseek ran
   `cat` through Bash under claude-code; openhuman's model skipped `use_skill coding` and used
   `shell cat`). Ship the dedicated read/grep/glob tools by default if you want them used.
5. **Volatile context belongs in the user turn, not the system prompt.** claude-code (git
   status/cwd/date in `<system-reminder>` user blocks), codex (`<environment_context>` user
   message), deepseek-harness ("Current runtime context. This snapshot supersedes earlier
   snapshots" user message), openclaw (`Runtime:` suffix + explicit STABLE/DYNAMIC markers),
   openhuman (date prepended to user message). Counter-example: hermes puts date/cwd/git at the
   end of the system prompt, and gates a 2.8k-char coding block on git detection, so the prefix
   differs across repos/days/tasks (17.1k vs 20.1k chars; two cache prefixes).
6. **Edit primitive converged on exact string replace** (claude-code Edit, opencode, hermes
   `patch`, deepseek-harness `edit`, openclaw `edit` with batched `{oldText,newText}`, openhuman
   `apply_patch`). Only codex mandates a diff-format `apply_patch`. Two lessons:
   - codex's prompt tells the model to use `apply_patch` but that tool isn't in the 9 tools; the
     model hit `command not found` and fell back to `cat > file` (one wasted call). Keep prompt
     and tool list in sync (hermes' prompt mentions `patch mode='patch'` which its schema lacks;
     openhuman's prompt names `memory_search`, which is not a tool).
   - openhuman's `apply_patch` is actually multi-file exact-string edit; the name collides with
     the codex diff format that models are trained on. Rename or accept the diff format.
7. **Shell tool design:** the good ones have `timeout`, background/yield, and a `workdir`
   param. opencode `workdir` instead of `cd &&`; codex `exec_command` + `write_stdin` (PTY,
   yield-and-poll) and output prefixed with exit code, wall time and original token count;
   deepseek-harness truncates long output to a file and reports the path; hermes
   notify/heartbeat/pty options. openhuman's `shell` has `timeout_secs` and a `category` enum
   that "can only raise the approval requirement" (a nice approval hook) but no background,
   pty or cwd.
8. **Schema hygiene:** none use `strict`. Cheap token wins: claude-code and opencode repeat
   `$schema` and zod `±9007199254740991` bounds in every integer param; deepseek-harness
   duplicates `sandbox_permissions`/`justification` across bash/edit/write (~1.3k chars);
   codex/openclaw ship approval/escalation/host/node params on every shell call; openhuman
   `todo.status` has a 13-value alias enum. Prefer short descriptions, defaults in param text,
   `additionalProperties:false` (claude-code does it everywhere; openhuman only on `todo`).
9. **Verbosity rules are cheap and high-value, but keep them non-contradictory.** opencode's
   "fewer than 4 lines" appears 3x plus 9 `<example>` blocks (~34% of its prompt); codex asks
   for both "Brevity is very important" and "light, friendly and curious" and spends ~6k chars
   (31%) on a final-answer format spec. claude-code spends one line on anti-dithering: "When
   you have enough information to act, act."
10. **Skills as an index with lazy bodies** (opencode `<available_skills>` + `skill` tool; codex
    name/description/path index; hermes 5.7k-char skills index; openclaw 6.2k, 19 skills;
    openhuman `use_skill` description 1.7k listing 16 skills). The index is itself a
    per-turn cost; keep it to name + one clause and cap its size.
11. **Auxiliary calls are separate and cheap when isolated.** opencode's title call: own 2.2k
    system, no tools, 581 prompt tokens (but `max_tokens` 32000 is wasteful). hermes' title call
    sends `json_schema` + `reasoning_effort: none`, gets a 404 from the provider, and silently
    loses the title every session (wasted request). Never put the main prompt on a side call.
12. **Planning/todo:** claude-code has no todo tool (Plan agent type instead). opencode's
    `todowrite` policy is ~2k chars of description only. deepseek-harness `todo_write` replaces
    the whole list. openhuman's `todo` text is the best phrasing seen: "Writing the list is
    bookkeeping, not work: in the same response... do the next step".

## Per-harness one-liners

- **claude-code**: smallest *prompt* (1.4k tok), biggest *tools* (12.5k tok). Terse bullets, rules
  with reasons, token counter appended after each result (`<total_tokens>`), result strings that
  prevent extra calls ("no need to Read it back"), typed file-memory (~2.4k chars) always on.
- **codex**: persona + big formatting spec; skills and sandbox/approval in a developer message;
  stable `prompt_cache_key`; goal tools carry long state machines (`update_goal` 1.5k).
- **deepseek-harness** (analysis returned inline, no `analysis.md`): flat 4.5k-char prompt with one
  paragraph per tool; strict goal "blocked" definition (3 consecutive rounds; "difficulty,
  uncertainty, or useful remaining work is not blocked"); denial rule "a policy denial, not a bug
  in the command; do not retry another way"; saw a wasted escalation retry
  ("no approval channel is available") in a headless run; thin grep, glob capped at 100.
- **hermes**: biggest tool set (40k chars), array-valued params everywhere (`queries`, `calls`,
  `tasks`), `write_file` refuses to overwrite an unread file (mechanical read-before-edit),
  "subagent summaries are SELF-REPORTS".
- **openclaw**: 25.7k-char personal-assistant prompt of which only ~10% is coding relevant
  (Tooling 31%, Skills 24%, control-plane/messaging ~16%); `[MISSING] Expected at:` placeholders;
  no grep/glob, no parallel-call or read-before-edit guidance. Best example of what *not* to ship
  in a coding prompt, but the STABLE/DYNAMIC marker discipline is good.
- **opencode**: older Claude-Code-style prompt; contradicts itself on grep (grep tool says use rg
  via bash, bash says avoid grep); `workdir`; orphan sentences; shouty emphasis.
- **openhuman**: best prefix hygiene (static 1k-token prompt, date in user turn, stable cache key)
  but no coding doctrine in the base prompt: no read/grep/glob tool, no cwd/env/git block ("Tools
  resolve in `pwd`", so call 1 ran `pwd`), everything coding-related is behind `use_skill coding`.

## Recommendations for OpenHuman (priority order)

1. **Cut the always-on tool prefix (~6.3k tok).** Move workflow (7k chars), juice (1.5k) and
   duplicate memory tools behind intent-based loading; target the ~3-4k-token range of
   opencode/openclaw. Don't defer tools the current task needs (hermes' mistake).
2. **Make `tool_call` args structured, not a JSON string**, and keep any deferred-name catalog
   short. Reconcile `tool_search`/`tool_call` with `use_skill` into one loading scheme.
3. **Ship dedicated `read`/`grep`/`glob` for coding turns** and a one-line "prefer these over
   shell" routing rule, with the per-tool usage notes (read-before-edit, don't re-read after
   edit) in the tool descriptions. Enforce read-before-edit mechanically like hermes.
4. **Inject a runtime-context block** (cwd, platform, shell, git status, date) as a user-turn
   message that "supersedes earlier snapshots" (deepseek-harness / codex shape), so the model
   needn't spend a call on `pwd` and the prefix stays cached.
5. **Fix prompt/tool drift:** `memory_search` named in the prompt but absent; rename
   `apply_patch` (or support the diff format); ban em-dashes in the prompt vs 8 tool
   descriptions using them. Add a CI check that every tool named in the prompt exists in the
   schema list (would have caught codex's, hermes' and openhuman's bugs).
6. **Shell tool:** add background/yield + poll, `cwd`, truncate-to-file with path, and prefix
   output with exit code + duration (codex). Keep the `category` approval-raising field.
7. **Schema hygiene:** drop `$schema` and zod int bounds, add `additionalProperties:false`
   everywhere, replace the 13-value `todo.status` alias enum with the canonical 3-4.
8. **Copy these phrasings:** claude-code "When you have enough information to act, act.";
   deepseek-harness "blocked" definition and denial rule; hermes "summaries are SELF-REPORTS"
   (openhuman already has the equivalent: "Worker summaries are claims").
9. **Add `<total_tokens>` style budget feedback** after tool results (claude-code) and
   token-count headers on tool output (codex); cheap and helps the model stop truncating.

Where it lands: base prompt sections `crates/openhuman-core/src/agent/prompts/` (SOUL, IDENTITY,
ROLE, STYLE `.md`; `DateTimeSection`/`WorkspaceSection` in `sections.rs`); tool-call parsing,
loop, deferred-tool mechanics and generic tools belong upstream in `vendor/tinyagents` /
`tinytools` per CLAUDE.md ownership rules.

## Caveats

- One cheap model, five tiny tasks, one run (smoke-2): tool-choice behaviour is anecdotal.
  claude-code's tool list in `-p` mode (20 tools, no Grep/Glob) is not the interactive one.
- Cache percentages are from DeepSeek automatic prefix caching via OpenRouter, so they say
  nothing about Anthropic `cache_control` effectiveness.
- Token figures are the proxy's `usage.prompt_tokens`; char counts are from the captured blobs.

## Follow-up capture: Claude Haiku 4.5 (run `prompts-haiku-1`)

Same micro suite, one repeat, `BENCH_MODEL=anthropic/claude-haiku-4.5`, provider pinned to
Anthropic via OpenRouter. Full table: [`prompts/_haiku-run/summary.md`](prompts/_haiku-run/summary.md).
Single run, five tiny tasks: indicative only.

**Prompt caching is the big difference once the model is Anthropic.** Anthropic does not cache
automatically; it needs `cache_control` breakpoints.

| harness | `cache_control` markers | cached / prompt tokens |
|---|---|---|
| claude-code | 3 | 334.9k / 372.4k (90%) |
| opencode | 3 | 159.4k / 176.9k (90%) |
| openhuman | 0 (has `prompt_cache_key`) | 0 / 112.7k |
| codex | 0 (has `prompt_cache_key`) | 0 / 193.9k |
| openclaw | 0 | 0 / 190.6k |
| hermes | 0 | 0 / 224.2k |
| deepseek-harness | 0 | 0 / 41.6k |

So the ~97% cache rates in the DeepSeek run do not transfer: five of seven harnesses, openhuman
included, pay full price for the whole static prefix on every call against Anthropic models.
openhuman's stable `prompt_cache_key` does nothing here. That is this run's observation, before
the fix: tinyinference now adds `cache_control` breakpoints for Anthropic-family model ids on every
OpenAI-compatible gateway (tinyhumansai/tinyinference#52), pulled in through tinyagents#273. Not yet
re-measured end to end; claude-code and opencode place 3 markers (system, last tool/system, last
user), the layout this change follows.

Other observations:
- Static prefix (system + tools, tokens): deepseek-harness 6.2k, openhuman 6.5k, opencode 6.6k,
  codex 7.7k, openclaw 7.6k, hermes 11.5k, claude-code 20.5k. openhuman's system prompt is
  ~0.9k tokens; 86% of its prefix is tool schemas (5.6k).
- claude-code spends 74.7k tokens per solved task, still the highest, even at 90% cache hit.
- deepseek-harness had 5 of 10 calls rejected (and 1/5 checks): it requests `max_tokens` of
  256000 against a 200k-context model ("you requested about 263516 tokens ... 256000 in the
  output"). A harness must clamp output caps to the routed model's context window.
- hermes: 29.6s p50 wall, 22.7s cold start, 6.45 GB peak RAM incl. page cache.
- openhuman passed 4/5 checks vs 5/5 for claude-code, codex, opencode, openclaw and hermes; I
  did not investigate which check failed, so treat it as open.
