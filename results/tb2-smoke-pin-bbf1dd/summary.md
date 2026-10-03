# Harness benchmark: tb2-smoke-pin-bbf1dd

model `deepseek/deepseek-v4.1-flash`, reasoning `high`, each task's own CPU/RAM limits (Harbor), suite `terminal-bench-2`.

builds: openhuman `bbf1dd5809`.

**2 trials ran concurrently**: CPU, RAM and latency figures are not comparable with serial runs.

| metric | openhuman |
|---|---|
| resolved (task verifier, reward 1) | 2/2 resolved |
| verifier tests passed (tasks reporting) | 14/14 (2) |
| harness errors / timeouts (all tasks) | 0 / 0 |
| system prompt tokens | 917 |
| tool schema tokens (count) | 3,511 (19) |
| static prompt total (system + tools) | 4,428 |
| cost / solved task | $0.02 |
| tokens / solved task | 1.14M |
| total cost (all tasks) | $0.04 |
| cache hit % (solved tasks) | 96.7% |
| TTFT p50 (solved tasks) | 1.46 s |
| LLM call latency p50 (solved tasks) | 3.07 s |
| task wall p50 (solved tasks) | 42.6 s |
| cold start to first call p50 (solved tasks) | 792 ms |
| CPU time / solved task | 42.2 s |
| peak RAM, process memory (solved tasks) | 537 MB |
| peak RAM incl. page cache (all tasks) | 872 MB |
| avg RAM (all tasks) | 270 MB |
| side / sub-agent calls (failed) | 1 of 65 (0) |
| side / sub-agent share of tokens | 1.6% |
| LLM calls (errors) | 65 (0) |
| prompt / completion tokens | 2.24M / 34.5k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
