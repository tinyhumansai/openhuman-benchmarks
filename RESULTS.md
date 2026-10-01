# Results (first run, 2026-10-01/02)

Model `deepseek/deepseek-v4-flash` via OpenRouter, reasoning `medium`, 4 vCPU / 8 GB per task container,
one harness at a time. SWE-bench Verified, 10 fixed instances (`swebench/instances-10.txt`), one attempt,
graded by the official evaluator. **Ten tasks is a smoke test: a one-task difference is noise.**

Harness versions: Claude Code 2.1.287, Codex 0.159.3, OpenCode 1.18.34, OpenClaw 2026.9.7,
Hermes (installer `main` at build time; see README caveats), OpenHuman built from this branch's base commit.
`openhuman` is the product default (`python` text tool dispatcher); `openhuman-native` sets
`OPENHUMAN_TOOL_DISPATCHER=native`. JEV was not enabled: it needs a TinyHumans credential this run did not have.

## What stands out

- **OpenHuman's low score is mostly turns that end early, not wrong patches.** In the default variant, 4 of the
  5 empty-patch tasks ended with the model's tool call returned as the final reply text
  (`<tool_call>read_file(...)</tool_call>`, a run of repeated `<tool_call>` tags, and a DeepSeek `<｜DSML｜tool_calls>`
  block) instead of being parsed and executed, so the turn stopped after one or two calls. Switching to native
  tool calls fixed those but the native variant still ended 4 tasks with a "Let me trace..." narration and no
  edit. Both are worth a look in the harness; neither is a capability measurement of the model.
- **OpenHuman is the lightest on CPU and RAM by a wide margin** (1.4 CPU-s and ~100 MB per task vs 5-16 CPU-s and
  0.5-1.7 GB for the others) and the cheapest per task, partly because it makes fewer calls.
- **Cache hit % is OpenHuman's weakest column** (63% default, 81% native vs 77-96% elsewhere), and its TTFT p95 is
  ~30 s vs ~2-3 s. Cold start to first model call is ~6 s, against 0.2-0.3 s for Claude Code and Codex.
- **Claude Code and Hermes resolved the most (8/10).** Hermes uses ~3.5 GB average RAM including page cache
  (its installed tree is copied at start), though only ~0.8 GB of process memory.
- **Codex was the slowest and the most expensive** per task (147 s wall p50, $0.028/task) and hit the one timeout.
- Static prompt size (system + tool schemas): OpenCode 503 tokens, OpenHuman 4.5k (5.9k native), Codex 7.7k,
  OpenClaw 7.6k, Claude Code 12.0k, Hermes 13.3k.

## Benchmark-side issues found and fixed during the run

- Micro tasks ran in a directory with no git repo, so patch capture was silently empty (micro-1 discarded; micro-2 is valid).
- OpenHuman's JSON-RPC client used `fetch`, whose 5-minute headers timeout killed one long turn (sympy-13031);
  switched to `node:http` and re-ran that task (the newest attempt wins in `report.mjs`).
- OpenClaw rejected `--thinking medium` for a custom model until the model declared its supported efforts.

## SWE-bench Verified, 10 instances (`swe-1`)

| metric | openhuman | claude-code | codex | opencode | openclaw | hermes | openhuman-native |
|---|---|---|---|---|---|---|---|
| resolved (SWE) / checks passed | 3/10 resolved | 8/10 resolved | 7/10 resolved | 5/10 resolved | 7/10 resolved | 8/10 resolved | 5/10 resolved |
| patch produced | 5/10 | 9/10 | 9/10 | 9/10 | 8/10 | 10/10 | 6/10 |
| harness errors / timeouts | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| system prompt tokens | 4491 | 1277 | 4049 | 503 | 5654 | 4456 | 925 |
| tool schema tokens (count) | 0 (0) | 10714 (20) | 3616 (9) | 0 (0) | 1990 (11) | 8802 (24) | 4998 (27) |
| static prompt total (system + tools) | 4491 | 11991 | 7665 | 503 | 7644 | 13258 | 5923 |
| cost / task | $0.0032 | $0.0108 | $0.0277 | $0.0033 | $0.0183 | $0.0136 | $0.0134 |
| cost / resolved | $0.0106 | $0.0134 | $0.0395 | $0.0065 | $0.0262 | $0.0170 | $0.0268 |
| total cost | $0.0319 | $0.1076 | $0.2767 | $0.0327 | $0.1834 | $0.1358 | $0.1339 |
| cache hit % | 62.8 | 95.5 | 94.7 | 76.7 | 89.7 | 95.7 | 80.6 |
| TTFT p50 / p95 (ms) | 2575 / 31455 | 1184 / 2325 | 1410 / 2431 | 1225 / 2702 | 1086 / 2083 | 1248 / 2558 | 2183 / 28684 |
| LLM call latency p50 (ms) | 2575 | 2525 | 4851 | 3156 | 2890 | 2926 | 2278 |
| task wall p50 (s) | 58.2 | 35.2 | 146.9 | 52.5 | 60.3 | 56.7 | 85.8 |
| cold start to first call p50 (ms) | 5939 | 302 | 218 | 1193 | 5526 | 7949 | 5820 |
| CPU-seconds / task | 1.4 | 5.5 | 5.0 | 11.9 | 16.1 | 13.7 | 1.9 |
| avg CPU cores | 0.03 | 0.09 | 0.04 | 0.30 | 0.28 | 0.18 | 0.03 |
| peak RAM, process memory (MB) | 102 | 584 | 532 | 779 | 1660 | 793 | 137 |
| peak RAM incl. page cache (MB) | 902 | 700 | 761 | 1129 | 2012 | 4286 | 473 |
| avg RAM (MB) | 329 | 216 | 247 | 725 | 1050 | 3518 | 243 |
| LLM calls (errors) | 88 (0) | 237 (0) | 212 (0) | 116 (0) | 144 (0) | 253 (0) | 122 (0) |
| prompt / completion tokens | 621629 / 75516 | 6089058 / 62622 | 3347211 / 204368 | 1233114 / 31723 | 1848551 / 137933 | 7918070 / 83173 | 1125598 / 106358 |


## Micro suite, 5 tasks x 3 repeats (`micro-2`)

| metric | openhuman | claude-code | codex | opencode | openclaw | hermes |
|---|---|---|---|---|---|---|
| resolved (SWE) / checks passed | 14/15 checks | 13/15 checks | 14/15 checks | 15/15 checks | 15/15 checks | 14/15 checks |
| patch produced | 12/15 | 10/15 | 12/15 | 12/15 | 12/15 | 12/15 |
| harness errors / timeouts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| system prompt tokens | 4491 | 1275 | 4049 | 503 | 5646 | 3729 |
| tool schema tokens (count) | 0 (0) | 10714 (20) | 3616 (9) | 0 (0) | 1990 (11) | 8802 (24) |
| static prompt total (system + tools) | 4491 | 11989 | 7665 | 503 | 7636 | 12531 |
| cost / task | $0.0004 | $0.0007 | $0.0006 | $0.0012 | $0.0006 | $0.0006 |
| cost / resolved | - | - | - | - | - | - |
| total cost | $0.0054 | $0.0101 | $0.0088 | $0.0175 | $0.0085 | $0.0093 |
| cache hit % | 76.0 | 80.3 | 96.3 | 81.3 | 94.0 | 82.3 |
| TTFT p50 / p95 (ms) | 2003 / 8239 | 1212 / 2253 | 875 / 1511 | 1364 / 3754 | 1059 / 1845 | 1780 / 12173 |
| LLM call latency p50 (ms) | 2003 | 1478 | 1464 | 2512 | 1707 | 3277 |
| task wall p50 (s) | 36.2 | 6.9 | 6.9 | 11.5 | 13.6 | 19.6 |
| cold start to first call p50 (ms) | 7250 | 162 | 105 | 1445 | 5450 | 8272 |
| CPU-seconds / task | 0.9 | 0.5 | 0.8 | 6.5 | 11.8 | 7.0 |
| avg CPU cores | 0.03 | 0.07 | 0.11 | 0.68 | 0.92 | 0.38 |
| peak RAM, process memory (MB) | 73 | 124 | 59 | 717 | 1458 | 307 |
| peak RAM incl. page cache (MB) | 294 | 146 | 175 | 888 | 1778 | 3586 |
| avg RAM (MB) | 100 | 93 | 74 | 542 | 826 | 3041 |
| LLM calls (errors) | 59 (0) | 56 (0) | 55 (0) | 62 (0) | 52 (0) | 59 (0) |
| prompt / completion tokens | 302668 / 5619 | 878138 / 4820 | 524147 / 4996 | 382627 / 9749 | 469451 / 5016 | 644368 / 11294 |

