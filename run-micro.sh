#!/usr/bin/env bash
# Run the micro suite for every harness sequentially, then print the report.
set -euo pipefail
cd "$(dirname "$0")"
run_id="${1:-micro-$(date +%Y%m%d-%H%M)}"
export BENCH_UID="$(id -u)" BENCH_GID="$(id -g)"
for h in ${HARNESSES:-openhuman claude-code codex opencode openclaw hermes}; do
  node orchestrate.mjs --harness "$h" --suite micro --run-id "$run_id" --repeat "${REPEAT:-3}"
done
node report.mjs --run-id "$run_id"
