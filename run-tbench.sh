#!/usr/bin/env bash
# Terminal-Bench 2.0 / 4.0 through Harbor (the benchmark's own harness), OpenHuman only, then
# reported like every other suite. Harbor owns environments, resources, timeouts and verifiers;
# see tbench/run.mjs. Needs `uv tool install harbor`.
# Usage: ./run-tbench.sh 2|4 [run-id]     INSTANCES=tbench/instances-tb2-5.txt (default: the 5-task sample)
#        BUNDLE=<name> runs .cache/harness/<name> (built with BUNDLE_NAME=<name> ./bundles/build.sh openhuman)
#        N_CONCURRENT=<n> runs n trials at once (metered per trial; CPU/latency then not comparable)
set -uo pipefail
cd "$(dirname "$0")"
bench="${1:?usage: run-tbench.sh 2|4 [run-id]}"
run_id="${2:-tbench${bench}-$(date +%Y%m%d-%H%M)}"
export BENCH_UID="$(id -u)" BENCH_GID="$(id -g)"
node tbench/run.mjs --bench "$bench" --run-id "$run_id" --instances "${INSTANCES:-tbench/instances-tb${bench}-5.txt}" \
  ${BUNDLE:+--bundle "$BUNDLE"} ${N_CONCURRENT:+--n-concurrent "$N_CONCURRENT"} \
  || echo "[run-tbench] harbor run failed"
node report.mjs --run-id "$run_id"
