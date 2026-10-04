# Harness benchmark: tb4-sample5

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, each task's own CPU/RAM limits (Harbor), suite `terminal-bench-4`.

builds: openhuman `unrecorded`.

| metric | openhuman |
|---|---|
| resolved (task verifier, reward 1) | 0/5 resolved |
| verifier tests passed (tasks reporting) | 89/104 (5) |
| harness errors / timeouts (all tasks) | 1 / 0 |
| system prompt tokens | 917 |
| tool schema tokens (count) | 3,511 (19) |
| static prompt total (system + tools) | 4,428 |
| cost / solved task | - |
| tokens / solved task | – |
| total cost (all tasks) | $1.26 |
| cache hit % (solved tasks) | – |
| TTFT p50 (solved tasks) | – |
| LLM call latency p50 (solved tasks) | – |
| task wall p50 (solved tasks) | – |
| cold start to first call p50 (solved tasks) | – |
| CPU time / solved task | – |
| peak RAM, process memory (solved tasks) | – |
| peak RAM incl. page cache (all tasks) | 5.91 GB |
| avg RAM (all tasks) | 704 MB |
| side / sub-agent calls (failed) | 25 of 565 (0) |
| side / sub-agent share of tokens | 4.0% |
| LLM calls (errors) | 565 (0) |
| prompt / completion tokens | 70.05M / 1.06M |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
