# Harness benchmark: anko-medium-1

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
| tokens / solved task | 9.09M |
| total cost (all tasks) | $0.10 |
| cache hit % (solved tasks) | 98.1% |
| TTFT p50 (solved tasks) | 1.61 s |
| LLM call latency p50 (solved tasks) | 3.34 s |
| task wall p50 (solved tasks) | 9m 54s |
| cold start to first call p50 (solved tasks) | 2.94 s |
| CPU time / solved task | 2m 00s |
| peak RAM, process memory (solved tasks) | 451 MB |
| peak RAM incl. page cache (all tasks) | 753 MB |
| avg RAM (all tasks) | 252 MB |
| side / sub-agent calls (failed) | 3 of 116 (0) |
| side / sub-agent share of tokens | 3.1% |
| LLM calls (errors) | 116 (0) |
| prompt / completion tokens | 9.01M / 84.0k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
