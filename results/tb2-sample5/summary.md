# Harness benchmark: tb2-sample5

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, each task's own CPU/RAM limits (Harbor), suite `terminal-bench-2`.

builds: openhuman `unrecorded`.

| metric | openhuman |
|---|---|
| resolved (task verifier, reward 1) | 2/5 resolved |
| verifier tests passed (tasks reporting) | 16/33 (5) |
| harness errors / timeouts (all tasks) | 0 / 0 |
| system prompt tokens | 917 |
| tool schema tokens (count) | 3,511 (19) |
| static prompt total (system + tools) | 4,428 |
| cost / solved task | $0.06 |
| tokens / solved task | 2.88M |
| total cost (all tasks) | $0.12 |
| cache hit % (solved tasks) | 96.8% |
| TTFT p50 (solved tasks) | 1.35 s |
| LLM call latency p50 (solved tasks) | 2.53 s |
| task wall p50 (solved tasks) | 1m 07s |
| cold start to first call p50 (solved tasks) | 1.19 s |
| CPU time / solved task | 42.9 s |
| peak RAM, process memory (solved tasks) | 552 MB |
| peak RAM incl. page cache (all tasks) | 1.95 GB |
| avg RAM (all tasks) | 583 MB |
| side / sub-agent calls (failed) | 4 of 134 (0) |
| side / sub-agent share of tokens | 1.7% |
| LLM calls (errors) | 134 (0) |
| prompt / completion tokens | 5.63M / 131.7k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
