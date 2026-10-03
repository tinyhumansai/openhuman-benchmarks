# Harness benchmark: anko-medium-2

model `deepseek/deepseek-v4.1-flash`, reasoning `medium`, 4 vCPU / 8g per task, suite `deepswe`.

| metric | openhuman |
|---|---|
| resolved (SWE) / checks passed | 1/1 resolved |
| patch produced | 1/1 |
| harness errors / timeouts (all tasks) | 0 / 0 |
| system prompt tokens | 917 |
| tool schema tokens (count) | 3,608 (19) |
| static prompt total (system + tools) | 4,525 |
| cost / solved task | $0.10 |
| tokens / solved task | 8.73M |
| total cost (all tasks) | $0.10 |
| cache hit % (solved tasks) | 98.3% |
| TTFT p50 (solved tasks) | 1.55 s |
| LLM call latency p50 (solved tasks) | 2.98 s |
| task wall p50 (solved tasks) | 9m 28s |
| cold start to first call p50 (solved tasks) | 2.17 s |
| CPU time / solved task | 1m 43s |
| peak RAM, process memory (solved tasks) | 427 MB |
| peak RAM incl. page cache (all tasks) | 803 MB |
| avg RAM (all tasks) | 246 MB |
| side / sub-agent calls (failed) | 5 of 114 (0) |
| side / sub-agent share of tokens | 3.8% |
| LLM calls (errors) | 114 (0) |
| prompt / completion tokens | 8.65M / 82.3k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
