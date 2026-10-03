# Harness benchmark: anko-juice-fix

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, 4 vCPU / 8g per task, suite `deepswe`.

| metric | openhuman |
|---|---|
| resolved (SWE) / checks passed | 1/1 resolved |
| patch produced | 1/1 |
| harness errors / timeouts (all tasks) | 0 / 0 |
| system prompt tokens | 917 |
| tool schema tokens (count) | 3,608 (19) |
| static prompt total (system + tools) | 4,525 |
| cost / solved task | $0.17 |
| tokens / solved task | 14.55M |
| total cost (all tasks) | $0.17 |
| cache hit % (solved tasks) | 98.7% |
| TTFT p50 (solved tasks) | 1.77 s |
| LLM call latency p50 (solved tasks) | 3.90 s |
| task wall p50 (solved tasks) | 16m 02s |
| cold start to first call p50 (solved tasks) | 1.32 s |
| CPU time / solved task | 1m 49s |
| peak RAM, process memory (solved tasks) | 451 MB |
| peak RAM incl. page cache (all tasks) | 761 MB |
| avg RAM (all tasks) | 283 MB |
| side / sub-agent calls (failed) | 1 of 118 (0) |
| side / sub-agent share of tokens | 0.8% |
| LLM calls (errors) | 118 (0) |
| prompt / completion tokens | 14.38M / 166.2k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
