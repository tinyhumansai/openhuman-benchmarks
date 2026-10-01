#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
# Loopback hop to the metering proxy (see forward.mjs).
proxy_host="${PROXY_URL#http://}"; proxy_host="${proxy_host%%:*}"
proxy_port="${PROXY_URL##*:}"
node /opt/harness/forward.mjs 18080 "$proxy_host" "$proxy_port" &
fwd=$!
trap 'kill $fwd 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done

export OPENHUMAN_WORKSPACE="$HOME/oh-workspace"
export OPENHUMAN_ACTION_DIR="$WORKDIR_ABS"
mkdir -p "$OPENHUMAN_WORKSPACE"
# Variant knob: `openhuman-jev` exports the TinyHumans credential that lets the
# JEV tool ranker run (see openhuman-jev.sh); plain `openhuman` falls back to BM25.
[ -n "${OH_EXTRA_ENV_SCRIPT:-}" ] && . "$OH_EXTRA_ENV_SCRIPT"

params="$(node -e '
  const fs = require("fs");
  process.stdout.write(JSON.stringify({
    message: fs.readFileSync(process.env.PROMPT_FILE, "utf8"),
    cwd: process.env.PWD,
    inference_url: "http://127.0.0.1:18080/v1",
    api_key: process.env.DUMMY_API_KEY,
    model_override: process.env.BENCH_MODEL,
  }));
')"
/opt/harness/openhuman/openhuman-core call \
  --method openhuman.inference_agent_chat --params "$params"
