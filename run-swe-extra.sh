#!/usr/bin/env bash
# Add a harness variant to an existing SWE run, and/or re-run single tasks
# (e.g. after fixing a driver bug) under the same run id. Newest attempt wins in report.mjs.
#   ./run-swe-extra.sh swe-1 openhuman-native
#   ./run-swe-extra.sh swe-1 openhuman sympy__sympy-13031
set -uo pipefail
cd "$(dirname "$0")"
run_id="$1"; h="$2"; only="${3:-}"
export BENCH_UID="$(id -u)" BENCH_GID="$(id -g)" TASK_TIMEOUT_S="${TASK_TIMEOUT_S:-1200}"
args=(--harness "$h" --suite swe --tasks-dir tasks/generated/swe --run-id "$run_id")
[ -n "$only" ] && args+=(--only "$only")
node orchestrate.mjs "${args[@]}"
node swebench/grade.mjs --run-id "$run_id" --harness "$h" --workers 2
