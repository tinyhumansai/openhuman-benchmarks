#!/usr/bin/env bash
# SWE-bench Verified subset, every harness sequentially, graded by the official
# evaluator, then reported. Usage: ./run-swe.sh [run-id]
set -uo pipefail
cd "$(dirname "$0")"
run_id="${1:-swe-$(date +%Y%m%d-%H%M)}"
export BENCH_UID="$(id -u)" BENCH_GID="$(id -g)" TASK_TIMEOUT_S="${TASK_TIMEOUT_S:-1200}"
for h in ${HARNESSES:-openhuman claude-code codex opencode openclaw hermes}; do
  node orchestrate.mjs --harness "$h" --suite swe --tasks-dir tasks/generated/swe --run-id "$run_id" \
    || echo "[run-swe] $h run failed"
  node swebench/grade.mjs --run-id "$run_id" --harness "$h" --workers 2 \
    || echo "[run-swe] $h grading failed"
done
node report.mjs --run-id "$run_id"
