#!/usr/bin/env bash
# Bench the DeepSeek harness (full `sdk` profile and the `sdk-minimal` mini profile) on its own,
# sequentially, with the same container limits as every other harness. One task container and
# one proxy at a time, so the box carries a single harness plus a 512 MB proxy.
#
#   ./run-deepseek.sh [run-id]                      # micro suite, 1 repeat
#   SUITE=swe TASKS_DIR=tasks/generated/swe ./run-deepseek.sh swe-ds
#   BENCH_CPUS=2 BENCH_MEM=4g ./run-deepseek.sh     # lighter box (changes comparability: say so in the report)
set -euo pipefail
cd "$(dirname "$0")"
run_id="${1:-deepseek-$(date +%Y%m%d-%H%M)}"
export BENCH_UID="$(id -u)" BENCH_GID="$(id -g)"
for h in deepseek-harness-minimal deepseek-harness; do
  [ -d ".cache/harness/$h" ] || ./bundles/build.sh "$h"
  node orchestrate.mjs --harness "$h" --suite "${SUITE:-micro}" --run-id "$run_id" --repeat "${REPEAT:-1}" \
    ${TASKS_DIR:+--tasks-dir "$TASKS_DIR"}
done
node report.mjs --run-id "$run_id"
echo "inspect prompts and cache behaviour: node viewer/server.mjs  ->  http://127.0.0.1:8787/#/run/$run_id"
