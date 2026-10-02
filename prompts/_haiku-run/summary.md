# Harness benchmark: prompts-haiku-1

model `anthropic/claude-haiku-4.5`, reasoning `high`, 4 vCPU / 8g per task, suite `micro`.

| metric | openhuman | claude-code | codex | opencode | openclaw | hermes | deepseek-harness |
|---|---|---|---|---|---|---|---|
| resolved (SWE) / checks passed | **4/5 checks** 🟡 | **5/5 checks** 🟢 | **5/5 checks** 🟢 | **5/5 checks** 🟢 | **5/5 checks** 🟢 | **5/5 checks** 🟢 | **1/5 checks** 🔴 |
| patch produced | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | 4/5 | 0/5 |
| harness errors / timeouts (all tasks) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| system prompt tokens | **925** 🟡 | 5,635 | 4,049 | 1,883 | **5,648** 🔴 | 2,726 | **890** 🟢 |
| tool schema tokens (count) | 5,572 (31) | **14.8k (20)** 🔴 | **3,616 (9)** 🟡 | 4,707 (10) | **1,990 (11)** 🟢 | 8,789 (24) | 5,279 (25) |
| static prompt total (system + tools) | **6,497** 🟡 | **20.5k** 🔴 | 7,665 | 6,590 | 7,638 | 11.5k | **6,169** 🟢 |
| cost / solved task | $0.03 | **$0.02** 🟡 | $0.04 | **$0.01** 🟢 | $0.04 | **$0.05** 🔴 | $0.05 |
| tokens / solved task | **28.6k** 🟢 | **74.7k** 🔴 | 39.1k | **36.8k** 🟡 | 38.8k | 46.0k | 43.2k |
| total cost (all tasks) | $0.12 | $0.08 | $0.20 | **$0.07** 🟡 | $0.21 | **$0.25** 🔴 | **$0.05** 🟢 |
| cache hit % (solved tasks) | **0.0%** 🔴 | **89.9%** 🟡 | **0.0%** 🔴 | **90.1%** 🟢 | **0.0%** 🔴 | **0.0%** 🔴 | **0.0%** 🔴 |
| TTFT p50 (solved tasks) | **1.64 s** 🔴 | 1.15 s | 1.23 s | 1.11 s | **1.04 s** 🟡 | 1.14 s | **941 ms** 🟢 |
| LLM call latency p50 (solved tasks) | **1.64 s** 🟡 | **1.59 s** 🟢 | 1.88 s | 2.23 s | **2.30 s** 🔴 | 2.11 s | 2.23 s |
| task wall p50 (solved tasks) | 9.50 s | **5.70 s** 🟡 | 6.68 s | 8.51 s | 17.5 s | **29.6 s** 🔴 | **4.24 s** 🟢 |
| cold start to first call p50 (solved tasks) | 2.75 s | **294 ms** 🟡 | **168 ms** 🟢 | 1.13 s | 8.35 s | **22.7 s** 🔴 | 1.55 s |
| CPU time / solved task | **899 ms** 🟡 | **602 ms** 🟢 | 1.31 s | 6.62 s | **10.3 s** 🔴 | 9.11 s | 1.45 s |
| peak RAM, process memory (solved tasks) | **74 MB** 🟢 | **122 MB** 🟡 | 251 MB | 724 MB | **1.18 GB** 🔴 | 301 MB | 185 MB |
| peak RAM incl. page cache (all tasks) | **375 MB** 🟡 | **309 MB** 🟢 | 473 MB | 968 MB | 1.72 GB | **6.45 GB** 🔴 | 450 MB |
| avg RAM (all tasks) | **210 MB** 🟢 | **226 MB** 🟡 | 357 MB | 720 MB | 925 MB | **3.52 GB** 🔴 | 334 MB |
| side / sub-agent calls (failed) | 0 of 13 (0) | 0 of 14 (0) | 0 of 17 (0) | 5 of 25 (0) | 0 of 19 (0) | 4 of 19 (0) | 0 of 10 (0) |
| side / sub-agent share of tokens | 0.0% | 0.0% | 0.0% | 4.0% | 0.0% | 2.5% | 0.0% |
| LLM calls (errors) | 13 (0) | 14 (0) | 17 (0) | 25 (0) | 19 (0) | 19 (0) | 10 (5) |
| prompt / completion tokens | 112.7k / 1,683 | 372.4k / 1,102 | 193.9k / 1,607 | 176.9k / 7,175 | 190.6k / 3,524 | 224.2k / 5,783 | 41.6k / 1,647 |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task is total spend, failed attempts included, divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across all calls.
