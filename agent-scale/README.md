# `scripts/bench/` — agent-scale benchmarks

Drive a **real `openhuman-core` server process** at concurrency against a
mocked LLM, sample its CPU and memory from the outside, and report a leak
verdict.

## How this differs from `scripts/profile/`

Both measure resources; they answer different questions, and the difference is
the reason this directory exists rather than another scenario in the old one.

|                | `scripts/profile/`                      | `scripts/bench/` (here)                       |
| -------------- | --------------------------------------- | --------------------------------------------- |
| Core runs as   | a library, embedded in the bench binary | a normally-built `openhuman-core serve` process |
| Driven through | direct `Agent` calls                    | JSON-RPC over HTTP `/rpc`                      |
| LLM mocked by  | a native `ChatModel` override           | an HTTP endpoint the core dials               |
| Needs          | `--features rss-bench`                  | nothing — the shipped feature set             |
| Measures       | domain and harness cost in isolation    | what the OS charges the shipped binary        |
| Best for       | attributing cost to a subsystem         | leak hunting, capacity, tail latency          |

`scripts/profile/` cannot see transport, serde, connection handling or the
scheduler, because in that tier none of them run. This one includes all of it
but attributes less precisely. Use `profile/` to find out *what* costs; use
`bench/` to find out whether the thing you ship *grows*.

## Requirements

- Linux (the sampler reads `/proc`).
- Node 20+.
- A release core binary:

```bash
cargo build --release --bin openhuman-core \
  --no-default-features --features "$(bash scripts/ci/product-features.sh)"
```

Release matters. A debug binary's allocation behaviour and CPU cost are not the
product's, so a leak verdict taken from one says little.

## Run it

```bash
scripts/bench/run-agent-scale.sh                      # defaults: 8 concurrent, 300 turns
scripts/bench/run-agent-scale.sh --concurrency 32 --turns 2000
scripts/bench/run-agent-scale.sh --duration-ms 900000 --tool-depth 3   # 15-minute soak
```

Exit status is the verdict: non-zero when a leak or drift check fails.
Artifacts land in `target/bench/<timestamp>/`:

| File             | Contents                                        |
| ---------------- | ----------------------------------------------- |
| `report.json`    | verdicts and the numbers behind them            |
| `samples.jsonl`  | the raw resource series                         |
| `driver.json`    | throughput, latency percentiles, error buckets  |
| `turns.jsonl`    | per-turn latency and outcome                    |
| `mock-stats.json`| what the mock actually served                   |
| `core.log`       | core stderr                                     |

## How it works without touching the core

Two facts carry the whole design, and a change to either breaks this tier:

1. **`BACKEND_URL` redirects inference.** The core derives both its inference
   base and its backend base from that one value, so pointing it at the mock
   captures chat completions, embeddings and Langfuse telemetry together.
2. **A session token shaped `<a>.<b>.local` skips backend validation.** Storing
   one persists a profile without the `GET /auth/me` round-trip a remote JWT
   would trigger, so the benchmark needs no login and the mock needs no auth
   routes. The driver seeds it before the load starts.

The mock also must not listen on 11434, 8000, 8080, 1234 or 8888 — the core
classifies those as local-AI endpoints and routes around them. `mock-llm.mjs`
refuses to start on one rather than failing mysteriously later.

## Reading a verdict

Memory gets three outcomes, and the middle one is the point:

- **pass** — no growth trend, or growth within the per-turn budget.
- **plateau** — grew past the budget overall, but stopped climbing by the final
  third of the window. The shape of a cache filling to its working set. Worth
  re-running longer to confirm the plateau holds.
- **fail** — grew past the budget *and was still growing at the end*.

That distinction is why the analyzer fits the tail of the series separately
rather than comparing an early average to a late one. Early-vs-late cannot tell
"grew then stopped" from "never grew", and treating a saturating cache as a
leak trains people to ignore the check.

**Threads and open file descriptors are held to a stricter standard.** Neither
has a legitimate reason to climb without bound under steady load, so they are
straight thresholds rather than trend tests, and they fail independently of
memory. In practice they are the least ambiguous leak signal available.

**CPU drift** compares CPU consumed per unit wall time between the start and
end of the window. Under constant offered load a rising figure means each turn
is costing more than the last — the CPU analogue of a memory leak, typically an
unbounded structure being rescanned every turn.

### Thread mode decides what you can conclude

```bash
--thread-mode fresh        # default: a new thread per turn
--thread-mode per-worker   # one long conversation per worker
--thread-mode shared       # all workers on one thread
```

Only `fresh` supports a leak verdict. In the other two, conversation history
accumulates *by design*, so RSS growth is expected and a leak is
indistinguishable from correct behaviour — the analyzer reports the growth rate
and explicitly declines to judge it. Use them for contention and tail latency,
not for leak hunting.

## Tuning the mock

```bash
--tool-depth N     tool calls per turn before the final answer (exercises the
                   agent loop, not just a single completion)
--latency-ms N     mean inference latency; realistic values keep many turns
--jitter-ms N      in flight and change the concurrency profile entirely
--reply-chars N    reply size — varies serde and allocation pressure
--fail-rate F      fraction of completions answered 500, to exercise retries
```

`--tool-depth 0` measures the RPC and inference path alone. Anything above zero
puts the agent's tool loop under test, which is where per-turn state actually
accumulates — so a leak hunt should use at least 1.

## Tests

```bash
node --test scripts/bench/analyze.test.mjs
```

The analyzer's failure mode is silence: wrong math reports "pass" on a leaking
run and nobody notices. The tests drive it with synthetic series whose correct
verdict is known by construction — a steady leak, a plateau, a flat line,
thread and FD growth, CPU drift — so a regression in the leak math fails loudly.
