# Harness benchmark: swe-x86-1

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, 4 vCPU / 8g per task, suite `swe`.

| metric | openhuman | claude-code | codex | opencode | openclaw | hermes | deepseek-harness |
|---|---|---|---|---|---|---|---|
| resolved (SWE) / checks passed | **7/10 resolved** 🔴 | **10/10 resolved** 🟢 | **7/10 resolved** 🔴 | **10/10 resolved** 🟢 | **9/10 resolved** 🟡 | **10/10 resolved** 🟢 | **10/10 resolved** 🟢 |
| patch produced | 7/10 | 10/10 | 7/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| harness errors / timeouts (all tasks) | **0 / 0** 🟢 | **0 / 0** 🟢 | **3 / 0** 🔴 | **0 / 0** 🟢 | **0 / 0** 🟢 | **0 / 0** 🟢 | **0 / 0** 🟢 |
| system prompt tokens | **944** 🟡 | 1,277 | 4,049 | 2,022 | **5,656** 🔴 | 4,457 | **891** 🟢 |
| tool schema tokens (count) | 3,647 (20) | **10.7k (20)** 🔴 | **3,616 (9)** 🟡 | 4,707 (10) | **1,990 (11)** 🟢 | 8,789 (24) | 5,279 (25) |
| static prompt total (system + tools) | **4,591** 🟢 | 12.0k | 7,665 | 6,729 | 7,646 | **13.2k** 🔴 | **6,170** 🟡 |
| cost / solved task | **$0.0077** 🟡 | **$0.04** 🔴 | $0.02 | **$0.0077** 🟢 | $0.01 | $0.0082 | $0.01 |
| tokens / solved task | **166.6k** 🟢 | 427.5k | **369.7k** 🟡 | 390.2k | 442.4k | 481.7k | **744.3k** 🔴 |
| total cost (all tasks) | **$0.05** 🟢 | **$0.35** 🔴 | $0.12 | **$0.08** 🟡 | $0.10 | $0.08 | $0.13 |
| cache hit % (solved tasks) | 90.6% | **56.1%** 🔴 | 93.6% | 93.4% | **94.9%** 🟡 | 94.5% | **96.2%** 🟢 |
| TTFT p50 (solved tasks) | **1.18 s** 🟢 | **1.38 s** 🔴 | 1.36 s | **1.26 s** 🟡 | 1.28 s | 1.34 s | 1.33 s |
| LLM call latency p50 (solved tasks) | **1.65 s** 🟢 | 2.11 s | 2.01 s | **1.91 s** 🟡 | 2.09 s | 1.99 s | **2.37 s** 🔴 |
| task wall p50 (solved tasks) | **19.8 s** 🟢 | 37.8 s | 36.1 s | **28.4 s** 🟡 | **1m 02s** 🔴 | 58.5 s | 55.2 s |
| cold start to first call p50 (solved tasks) | 814 ms | **269 ms** 🟡 | **224 ms** 🟢 | 1.19 s | 5.54 s | **10.0 s** 🔴 | 855 ms |
| CPU time / solved task | **1.31 s** 🟢 | 4.68 s | 3.28 s | 17.2 s | **26.7 s** 🔴 | 16.1 s | **2.85 s** 🟡 |
| peak RAM, process memory (solved tasks) | **68 MB** 🟢 | 231 MB | **123 MB** 🟡 | 1.06 GB | **1.57 GB** 🔴 | 816 MB | 214 MB |
| peak RAM incl. page cache (all tasks) | **828 MB** 🟡 | 1.08 GB | **503 MB** 🟢 | 1.69 GB | 2.00 GB | **7.43 GB** 🔴 | 1.02 GB |
| avg RAM (all tasks) | **296 MB** 🟡 | 358 MB | **236 MB** 🟢 | 756 MB | 1.11 GB | **4.14 GB** 🔴 | 475 MB |
| side / sub-agent calls (failed) | 6 of 114 (0) | 7 of 175 (0) | 0 of 134 (0) | 10 of 177 (0) | 0 of 198 (0) | 10 of 195 (10) | 0 of 212 (0) |
| side / sub-agent share of tokens | 7.5% | 1.0% | 0.0% | 0.4% | 0.0% | 0.0% | 0.0% |
| LLM calls (errors) | 114 (0) | 175 (0) | 134 (3) | 177 (0) | 198 (0) | 195 (10) | 212 (0) |
| prompt / completion tokens | 1.11M / 58.9k | 4.22M / 52.2k | 2.55M / 37.9k | 3.85M / 46.8k | 3.89M / 92.9k | 4.77M / 48.1k | 7.33M / 110.0k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task is total spend, failed attempts included, divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
