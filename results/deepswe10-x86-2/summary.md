# Harness benchmark: deepswe10-x86-2

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, 4 vCPU / 8g per task, suite `deepswe`.

| metric | openhuman | claude-code | codex | opencode | openclaw | hermes | deepseek-harness |
|---|---|---|---|---|---|---|---|
| resolved (SWE) / checks passed | **0/10 resolved** 🔴 | **8/10 resolved** 🟡 | 3/10 resolved | 6/10 resolved | 1/10 resolved | **9/10 resolved** 🟢 | 6/10 resolved |
| patch produced | 5/10 | 10/10 | 5/10 | 10/10 | 3/10 | 10/10 | 10/10 |
| harness errors / timeouts (all tasks) | **0 / 0** 🟢 | **0 / 0** 🟢 | **5 / 0** 🔴 | **0 / 0** 🟢 | **3 / 0** 🟡 | **0 / 0** 🟢 | **0 / 0** 🟢 |
| system prompt tokens | **944** 🟡 | 1,276 | 4,049 | 2,020 | **5,653** 🔴 | 4,460 | **890** 🟢 |
| tool schema tokens (count) | 3,647 (20) | **10.7k (20)** 🔴 | **3,616 (9)** 🟡 | 4,707 (10) | **1,990 (11)** 🟢 | 8,789 (24) | 5,279 (25) |
| static prompt total (system + tools) | **4,591** 🟢 | 12.0k | 7,665 | 6,727 | 7,643 | **13.2k** 🔴 | **6,169** 🟡 |
| cost / solved task | - | **$1.39** 🔴 | $0.28 | **$0.15** 🟡 | $0.42 | **$0.08** 🟢 | $0.29 |
| tokens / solved task | – | **10.64M** 🟡 | 23.27M | 20.47M | 14.32M | **10.01M** 🟢 | **35.35M** 🔴 |
| total cost (all tasks) | **$0.22** 🟢 | **$11.15** 🔴 | $0.83 | $0.88 | **$0.42** 🟡 | $0.72 | $1.73 |
| cache hit % (solved tasks) | – | **20.5%** 🔴 | **99.2%** 🟢 | 98.5% | 96.6% | 98.3% | **98.9%** 🟡 |
| TTFT p50 (solved tasks) | – | **2.17 s** 🔴 | 1.82 s | **1.60 s** 🟡 | **1.38 s** 🟢 | 1.71 s | 1.82 s |
| LLM call latency p50 (solved tasks) | – | 3.43 s | 3.22 s | **2.36 s** 🟢 | **2.41 s** 🟡 | 2.73 s | **3.60 s** 🔴 |
| task wall p50 (solved tasks) | – | 9m 03s | 10m 54s | **2m 13s** 🟢 | **3m 55s** 🟡 | 6m 52s | **11m 42s** 🔴 |
| cold start to first call p50 (solved tasks) | – | **178 ms** 🟡 | **122 ms** 🟢 | 1.09 s | 5.35 s | **8.30 s** 🔴 | 710 ms |
| CPU time / solved task | – | 1m 25s | 1m 43s | 1m 41s | **34.4 s** 🟡 | **1m 55s** 🔴 | **12.8 s** 🟢 |
| peak RAM, process memory (solved tasks) | – | **4.08 GB** 🔴 | **337 MB** 🟡 | 1.61 GB | 1.12 GB | 2.04 GB | **312 MB** 🟢 |
| peak RAM incl. page cache (all tasks) | **350 MB** 🟢 | 4.32 GB | 1.31 GB | 2.13 GB | 2.21 GB | **7.37 GB** 🔴 | **542 MB** 🟡 |
| avg RAM (all tasks) | **184 MB** 🟢 | 378 MB | **303 MB** 🟡 | 845 MB | 1.15 GB | **4.13 GB** 🔴 | 347 MB |
| side / sub-agent calls (failed) | 51 of 150 (0) | 124 of 1,041 (0) | 2 of 830 (0) | 10 of 1,108 (0) | 8 of 347 (0) | 10 of 782 (10) | 0 of 1,182 (0) |
| side / sub-agent share of tokens | 39.5% | 8.5% | 0.2% | 0.0% | 2.9% | 0.0% | 0.0% |
| LLM calls (errors) | 150 (0) | 1,041 (0) | 830 (5) | 1,108 (0) | 347 (0) | 782 (10) | 1,182 (0) |
| prompt / completion tokens | 2.41M / 202.0k | 84.39M / 687.3k | 69.32M / 491.1k | 122.22M / 607.4k | 13.93M / 393.4k | 89.64M / 454.9k | 210.84M / 1.29M |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
