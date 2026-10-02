# Results (first run, 2026-10-01/02)

Model `deepseek/deepseek-v4-flash` via OpenRouter, reasoning `medium`, 4 vCPU / 8 GB per task container,
one harness at a time. SWE-bench Verified, 10 fixed instances (`swebench/instances-10.txt`), one attempt,
graded by the official evaluator. **Ten tasks is a smoke test: a one-task difference is noise.**

Harness versions: Claude Code 2.1.287, Codex 0.159.3, OpenCode 1.18.34, OpenClaw 2026.9.7,
Hermes (installer `main` at build time; see README caveats), OpenHuman built from this branch's base commit.

**OpenHuman here is the native tool-call dispatcher** (`OPENHUMAN_TOOL_DISPATCHER=native`, JSON tool
schemas in the API `tools` field). The product's older `python` text dispatcher scored 3/10 on the same
tasks; that data is archived as `openhuman-python` and left out of the tables and charts. JEV was not
enabled in this run. DeepSeek Harness (`deepseek-harness`, `deepseek-harness-minimal`) is wired in but
its runs were not completed for this first report, so it is not in the tables below.

Per-task KPIs (cache, TTFT, latency, wall time, cold start, CPU, RAM) are measured over each harness's
own **solved** tasks. Cost per solved task is total spend, failed attempts included, divided by tasks
solved. Solved sets differ per harness, so these are not over identical tasks.

## What stands out

- **OpenHuman (native) resolved 5/10, tying OpenCode and trailing Claude Code and Hermes (8/10).** Half its
  misses are turns that end early: on 4 tasks the agent wrote up its findings ("Based on my investigation...")
  and stopped without editing, including two tasks every other harness solved.
- **The python dispatcher leaked tool calls into the reply** (3/10): all 5 of its empty-patch tasks ended with
  the model's tool call returned as final text instead of being executed. A sibling investigation traced this
  to the dispatcher's protocol example naming a `read_file` tool the agent does not have, so the model copies
  it, the parser rejects the unknown tool, and the generic retry hint never names the tool. The fix, making
  native JSON tool schemas the default, is in progress outside this PR.
- **OpenHuman is the lightest on CPU and RAM by a wide margin** (about 2 CPU-s and 137 MB per solved task vs
  5-15 CPU-s and 0.5-1.5 GB) and among the cheapest per solved task with OpenCode and Claude Code.
- **Cache hit is OpenHuman's weak spot** (80% vs 92-96% for Claude Code, Codex, OpenClaw and Hermes), and its
  cold start to the first model call is about 5.6 s against 0.2-0.3 s for Claude Code and Codex. The
  python dispatcher run showed the cached prefix stalling while the prompt kept growing, which suggests earlier
  history being rewritten between calls; confirming that needs request bodies, not just token counts.
- **Codex was the slowest and most expensive per solved task** (147 s wall p50, 3.9 cents) and hit the one timeout.
- Static prompt size (system + tool schemas): OpenCode 503 tokens, OpenHuman 5.9k, Codex 7.7k, OpenClaw 7.6k,
  Claude Code 12.0k, Hermes 13.3k.

## Benchmark-side issues found and fixed during the run

- Micro tasks ran in a directory with no git repo, so patch capture was silently empty (micro-1 discarded; micro-2 is valid).
- OpenHuman's JSON-RPC client used `fetch`, whose 5-minute headers timeout killed one long turn; switched to `node:http`.
- OpenClaw rejected `--thinking medium` for a custom model until the model declared its supported efforts.
- Benchmark runs from two worktrees overlapped on one metering proxy and one host. Runs now wait for a
  quiet host, and each checkout gets its own compose project and proxy port.

## SWE-bench Verified, 10 instances (`swe-1`)

| metric | claude-code | codex | opencode | openclaw | hermes | openhuman |
|---|---|---|---|---|---|---|
| resolved (SWE) / checks passed | 8/10 resolved | 7/10 resolved | 5/10 resolved | 7/10 resolved | 8/10 resolved | 5/10 resolved |
| patch produced | 9/10 | 9/10 | 9/10 | 8/10 | 10/10 | 6/10 |
| harness errors / timeouts (all tasks) | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| system prompt tokens | 1277 | 4049 | 503 | 5654 | 4456 | 925 |
| tool schema tokens (count) | 10714 (20) | 3616 (9) | 0 (0) | 1990 (11) | 8802 (24) | 4998 (27) |
| static prompt total (system + tools) | 11991 | 7665 | 503 | 7644 | 13258 | 5923 |
| cost / solved task | $0.0134 | $0.0395 | $0.0065 | $0.0262 | $0.0170 | $0.0268 |
| tokens / solved task | 768960 | 507368 | 252967 | 283783 | 1000155 | 246391 |
| total cost (all tasks) | $0.1076 | $0.2767 | $0.0327 | $0.1834 | $0.1358 | $0.1339 |
| cache hit % (solved tasks) | 94.6 | 95.0 | 76.2 | 91.8 | 96.0 | 80.5 |
| TTFT p50 (ms, solved tasks) | 1116 | 1371 | 1168 | 992 | 1248 | 1990 |
| LLM call latency p50 (ms, solved tasks) | 2212 | 4255 | 3156 | 2435 | 2854 | 2072 |
| task wall p50 (s, solved tasks) | 35.2 | 146.9 | 52.5 | 54.3 | 56.7 | 83.8 |
| cold start to first call p50 (ms, solved tasks) | 299 | 218 | 1206 | 5534 | 7949 | 5626 |
| CPU-seconds / solved task | 5.0 | 5.6 | 11.6 | 14.6 | 14.5 | 2.2 |
| peak RAM, process memory (MB, solved tasks) | 584 | 532 | 779 | 1485 | 793 | 137 |
| peak RAM incl. page cache (MB, all tasks) | 700 | 761 | 1129 | 2012 | 4286 | 473 |
| avg RAM (MB, all tasks) | 216 | 247 | 725 | 1050 | 3518 | 243 |
| LLM calls (errors) | 237 (0) | 212 (0) | 116 (0) | 144 (0) | 253 (0) | 122 (0) |
| prompt / completion tokens | 6089058 / 62622 | 3347211 / 204368 | 1233114 / 31723 | 1848551 / 137933 | 7918070 / 83173 | 1125598 / 106358 |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task is total spend, failed attempts included, divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across all calls.
