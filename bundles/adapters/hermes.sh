#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
# The installer put Python, Node and hermes under /opt/harness/home (read-only
# mount); give it a writable copy. This copy is part of hermes's measured cold start.
cp -a /opt/harness/home/. "$HOME/"   # same absolute path the installer used
export PATH="$HOME/.local/bin:$PATH"
export HERMES_HOME="$HOME/.hermes"
mkdir -p "$HERMES_HOME"
cat > "$HERMES_HOME/config.yaml" <<YAML
model:
  provider: "custom"
  default: "$BENCH_MODEL"
  base_url: "$PROXY_URL/v1"
  api_key: "$DUMMY_API_KEY"
agent:
  reasoning_effort: "$BENCH_REASONING"
YAML
export HERMES_YOLO_MODE=1
exec hermes --in "$WORKDIR_ABS" -z "$PROMPT" --yolo -m "$BENCH_MODEL" --provider custom
