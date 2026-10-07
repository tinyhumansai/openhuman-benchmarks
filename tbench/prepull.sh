#!/usr/bin/env bash
# Pull every task image an instance list needs before the run starts.
#
# Harbor gives an environment 600 s to come up (each task's `build_timeout_sec`), and that
# window includes pulling the image. Four Terminal-Bench 2.0 images are 5.8–8.4 GB
# compressed; on a ~5 MB/s link they need 20–30 minutes, so the trial errors with
# `EnvironmentStartTimeoutError` before the agent ever runs (mteb-retrieve, 2026-10-08) and
# the task counts as failed for a reason that has nothing to do with the agent. Pulling
# first keeps the timeout as the benchmark defines it and takes the network out of the
# measurement.
#
# Usage: tbench/prepull.sh 2|4 [instances-file]     (default: tbench/instances-tb<N>-5.txt)
# Images already present are skipped. Needs the dataset checkout the runner uses; pass
# TB_DATASET_DIR to point at a `harbor datasets download` directory.
set -uo pipefail
cd "$(dirname "$0")/.."
bench="${1:?usage: prepull.sh 2|4 [instances-file]}"
instances="${2:-tbench/instances-tb${bench}-5.txt}"
dataset="${TB_DATASET_DIR:-.cache/tb${bench}-dataset}"
if [ ! -d "$dataset" ]; then
  case "$bench" in
    2) name="terminal-bench@2.0" ;;
    4) name="terminal-bench/terminal-bench@4.0.0" ;;
    *) echo "bench must be 2 or 4" >&2; exit 2 ;;
  esac
  mkdir -p "$dataset" && harbor datasets download "$name" -o "$dataset" >/dev/null || { echo "dataset download failed" >&2; exit 1; }
fi
present="$(docker images --format '{{.Repository}}:{{.Tag}}')"
n=0; pulled=0; failed=0
for task in $(grep -v '^#' "$instances"); do
  toml="$(find "$dataset" -path "*/$task/task.toml" | head -1)"
  [ -n "$toml" ] || { echo "[prepull] no task.toml for $task" >&2; continue; }
  image="$(grep -o 'docker_image = "[^"]*"' "$toml" | cut -d'"' -f2)"
  [ -n "$image" ] || continue
  n=$((n + 1))
  if printf '%s\n' "$present" | grep -qx "$image"; then continue; fi
  echo "[prepull] $task: $image"
  if docker pull --platform linux/amd64 -q "$image" >/dev/null; then pulled=$((pulled + 1)); else failed=$((failed + 1)); echo "[prepull] FAILED $image" >&2; fi
done
echo "[prepull] $n images: $pulled pulled, $failed failed, $((n - pulled - failed)) already present"
[ "$failed" -eq 0 ]
