#!/usr/bin/env bash
# DeepSWE (datacurve/deep-swe, 113 tasks), every harness sequentially, graded by each task's own
# verifier, then reported. Needs deepswe/prepare.mjs to have produced tasks/generated/deepswe.
# Usage: ./run-deepswe.sh [run-id]
set -uo pipefail
cd "$(dirname "$0")"
run_id="${1:-deepswe-$(date +%Y%m%d-%H%M)}"
export BENCH_UID="$(id -u)" BENCH_GID="$(id -g)" TASK_TIMEOUT_S="${TASK_TIMEOUT_S:-3600}"
for h in ${HARNESSES:-openhuman claude-code codex opencode openclaw hermes deepseek-harness}; do
  node orchestrate.mjs --harness "$h" --suite deepswe --tasks-dir "${TASKS_DIR:-tasks/generated/deepswe}" --run-id "$run_id" \
    ${ONLY:+--only "$ONLY"} || echo "[run-deepswe] $h run failed"
  node deepswe/grade.mjs --run-id "$run_id" --harness "$h" --workers "${GRADE_WORKERS:-2}" --tasks-dir "${TASKS_DIR:-tasks/generated/deepswe}" \
    || echo "[run-deepswe] $h grading failed"
done
node report.mjs --run-id "$run_id"
