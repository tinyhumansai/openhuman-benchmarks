# Harness benchmark: ds-basic-1

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, 4 vCPU / 8g per task, suite `micro`.

| metric | deepseek-harness | deepseek-harness-minimal |
|---|---|---|
| resolved (SWE) / checks passed | 5/5 checks | 5/5 checks |
| patch produced | 4/5 | 4/5 |
| harness errors / timeouts (all tasks) | 0 / 0 | 0 / 0 |
| system prompt tokens | **890** 🔴 | **8** 🟢 |
| tool schema tokens (count) | **5,279 (25)** 🔴 | **196 (1)** 🟢 |
| static prompt total (system + tools) | **6,169** 🔴 | **204** 🟢 |
| cost / solved task | **$0.0013** 🔴 | **$0.0006** 🟢 |
| tokens / solved task | **32.8k** 🔴 | **2,678** 🟢 |
| total cost (all tasks) | **$0.0066** 🔴 | **$0.0030** 🟢 |
| cache hit % (solved tasks) | **97.2%** 🟢 | **70.7%** 🔴 |
| TTFT p50 (solved tasks) | **1.12 s** 🔴 | **912 ms** 🟢 |
| LLM call latency p50 (solved tasks) | **1.69 s** 🔴 | **1.40 s** 🟢 |
| task wall p50 (solved tasks) | **10.4 s** 🔴 | **5.70 s** 🟢 |
| cold start to first call p50 (solved tasks) | **699 ms** 🔴 | **361 ms** 🟢 |
| CPU time / solved task | **1.11 s** 🔴 | **738 ms** 🟢 |
| peak RAM, process memory (solved tasks) | **210 MB** 🔴 | **117 MB** 🟢 |
| peak RAM incl. page cache (all tasks) | **296 MB** 🔴 | **213 MB** 🟢 |
| avg RAM (all tasks) | **245 MB** 🔴 | **155 MB** 🟢 |
| side / sub-agent calls (failed) | 0 of 21 (0) | 0 of 15 (0) |
| side / sub-agent share of tokens | 0.0% | 0.0% |
| LLM calls (errors) | 21 (0) | 15 (0) |
| prompt / completion tokens | 160.6k / 3,545 | 11.8k / 1,614 |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task is total spend, failed attempts included, divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across all calls.
