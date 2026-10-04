# Harness benchmark: dswe10-medium-68f2a24efb

model `deepseek/deepseek-v4.1-flash`, reasoning `medium`, 4 vCPU / 8g per task, suite `deepswe`.

builds: openhuman `5514ca6815`.

| metric | openhuman |
|---|---|
| resolved (SWE) / checks passed | 7/10 resolved |
| patch produced | 10/10 |
| harness errors / timeouts (all tasks) | 0 / 0 |
| system prompt tokens | 985 |
| tool schema tokens (count) | 3,560 (18) |
| static prompt total (system + tools) | 4,545 |
| cost / solved task | $0.14 |
| tokens / solved task | 11.68M |
| total cost (all tasks) | $0.98 |
| cache hit % (solved tasks) | 97.9% |
| TTFT p50 (solved tasks) | 1.55 s |
| LLM call latency p50 (solved tasks) | 2.81 s |
| task wall p50 (solved tasks) | 9m 57s |
| cold start to first call p50 (solved tasks) | 1.43 s |
| CPU time / solved task | 9m 27s |
| peak RAM, process memory (solved tasks) | 1.08 GB |
| peak RAM incl. page cache (all tasks) | 8.00 GB |
| avg RAM (all tasks) | 608 MB |
| side / sub-agent calls (failed) | 1 of 1,019 (0) |
| side / sub-agent share of tokens | 0.0% |
| LLM calls (errors) | 1,019 (0) |
| prompt / completion tokens | 80.94M / 819.4k |

Per-task KPIs are measured over each harness's own solved tasks (resolved by the grader, or the task check on the micro suite); cost / solved task and tokens / solved task are total spend and total tokens across all calls (failed attempts and unsolved tasks included) divided by tasks solved. Small samples: treat differences as indicative, not a ranking. CPU/RAM are cgroup-wide per container; process memory is the cgroup's anon bytes (2 Hz poll), the page-cache figure is the kernel high-water mark. Cache % = cached / prompt tokens across the calls of a harness's solved tasks.
