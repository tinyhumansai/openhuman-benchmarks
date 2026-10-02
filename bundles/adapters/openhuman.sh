#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
# Loopback hop to the metering proxy (see forward.mjs).
proxy_host="${PROXY_URL#http://}"; proxy_host="${proxy_host%%:*}"
proxy_port="${PROXY_URL##*:}"
node /opt/harness/forward.mjs 18080 "$proxy_host" "$proxy_port" &
fwd=$!
for _ in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done

# Provider-native structured tool calls (JSON tool schemas in the API `tools` field), like
# the other harnesses. The product's older `python` text dispatcher leaked tool calls into
# the reply on this model, so it is not what this benchmark measures.
export OPENHUMAN_TOOL_DISPATCHER=native
export OPENHUMAN_WORKSPACE="$HOME/oh-workspace"
export OPENHUMAN_ACTION_DIR="$WORKDIR_ABS"
mkdir -p "$OPENHUMAN_WORKSPACE"
# The core needs *a* credential before it will run a turn even on a BYOK route;
# a dummy API key satisfies that without granting any backend access, and
# inference itself goes to the metering proxy through the per-call route.
export OPENHUMAN_BACKEND_API_KEY="${OPENHUMAN_BACKEND_API_KEY:-$DUMMY_API_KEY}"

# Headless core, the way a product host runs it; the turn goes over JSON-RPC.
export OH_PORT=7788 OH_TOKEN=bench-core-token OPENHUMAN_CORE_TOKEN=bench-core-token
export INFERENCE_URL="http://127.0.0.1:18080/v1"
/opt/harness/openhuman/openhuman-core run --headless-api --host 127.0.0.1 --port "$OH_PORT" \
  > "$HOME/core.log" 2>&1 &
core=$!
trap 'kill $core $fwd 2>/dev/null || true' EXIT
node /opt/harness/oh-turn.mjs
