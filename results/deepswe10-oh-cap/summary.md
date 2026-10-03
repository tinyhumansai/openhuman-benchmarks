# Harness benchmark: deepswe10-oh-cap

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, 4 vCPU / 8g per task, suite `deepswe`.

| metric | openhuman |
|---|---|
| resolved (SWE) / checks passed | 2/10 resolved |
| patch produced | 7/10 |
| harness errors / timeouts (all tasks) | 2 / 2 |
| system prompt tokens | 917 |
| tool schema tokens (count) | 3,511 (19) |
| static prompt total (system + tools) | 393 |
| cost / solved task | $5.41 |
| tokens / solved task | 50.17M |
| total cost (all tasks) | $10.82 |
| cache hit % (solved tasks) | 46.7% |
| TTFT p50 (solved tasks) | 1.47 s |
| LLM call latency p50 (solved tasks) | 2.75 s |
| task wall p50 (solved tasks) | 4m 53s |
| cold start to first call p50 (solved tasks) | 493 ms |
| CPU time / solved task | 1m 14s |
| peak RAM, process memory (solved tasks) | 1.19 GB |
| peak RAM incl. page cache (all tasks) | 3.79 GB |
| avg RAM (all tasks) | 507 MB |
| side / sub-agent calls (failed) | 927 of 1,616 (0) |
| side / sub-agent share of tokens | 40.9% |
| LLM calls (errors) | 1,616 (0) |
| prompt / completion tokens | 96.27M / 4.06M |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
