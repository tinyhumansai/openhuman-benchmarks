#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
# Loopback hop to the metering proxy (see forward.mjs): its unix socket when PROXY_SOCKET is
# set (Harbor), else PROXY_URL on the bench network.
if [ -n "${PROXY_SOCKET:-}" ]; then
  node /opt/harness/forward.mjs 18080 "$PROXY_SOCKET" &
else
  proxy_host="${PROXY_URL#http://}"; proxy_host="${proxy_host%%:*}"
  proxy_port="${PROXY_URL##*:}"
  node /opt/harness/forward.mjs 18080 "$proxy_host" "$proxy_port" &
fi
fwd=$!
for _ in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done

# Provider-native structured tool calls (JSON tool schemas in the API `tools` field), like
# the other harnesses. The product's older `python` text dispatcher leaked tool calls into
# the reply on this model, so it is not what this benchmark measures.
export OPENHUMAN_TOOL_DISPATCHER=native
# No Composio account in the bench: skip the hosted integrations fetch (a 401 on the
# dummy key) that otherwise sits on the first turn's critical path.
export OPENHUMAN_COMPOSIO_MODE=disabled
export OPENHUMAN_WORKSPACE="$HOME/oh-workspace"
export OPENHUMAN_ACTION_DIR="$WORKDIR_ABS"
mkdir -p "$OPENHUMAN_WORKSPACE"
# The core needs *a* credential before it will run a turn even on a BYOK route;
# a dummy API key satisfies that without granting any backend access, and
# inference itself goes to the metering proxy through the per-call route.
export OPENHUMAN_BACKEND_API_KEY="${OPENHUMAN_BACKEND_API_KEY:-$DUMMY_API_KEY}"

# The module loader admits a module directory only if it and every ancestor is
# owned by the current user or root (tinybus `check_directory`). The bundle is
# bind-mounted owned by the host user who built it, while task images run as
# root, so every loadable module (tinyruntime, tinysearch, ...) was refused with
# "module directory is owned by another user". Stage a root-owned copy instead.
bundled=/opt/harness/openhuman/bundled-modules
if [ -d "$bundled" ] && [ "$(id -u)" != "$(stat -c %u "$bundled")" ]; then
  staged=/opt/oh-bundled-modules
  rm -rf "$staged"
  cp -r "$bundled" "$staged"
  chmod -R go-w "$staged"
  export OPENHUMAN_BUNDLED_MODULES="$staged"
  echo "[openhuman] staged bundled modules owned by uid $(id -u): $staged" >&2
fi
# The shell tool puts a resolved Python first on PATH for `python`/`pip` commands.
# By default that is a downloaded standalone CPython, which lacks the task repo's
# installed dependencies. Use the task image's own interpreter, as every other
# harness does.
export OPENHUMAN_RUNTIME_PYTHON_PREFER_SYSTEM=1
export OPENHUMAN_RUNTIME_PYTHON_MINIMUM_VERSION=3.0.0

# Headless core, the way a product host runs it; the turn goes over JSON-RPC.
export OH_PORT=7788 OH_TOKEN=bench-core-token OPENHUMAN_CORE_TOKEN=bench-core-token
# BENCH_PROXY_PREFIX (/__tag/<run>/<harness>/<task>) tags each call for the proxy, so trials can
# run side by side; without it the proxy's global tag applies.
export INFERENCE_URL="http://127.0.0.1:18080${BENCH_PROXY_PREFIX:-}/v1"
/opt/harness/openhuman/openhuman-core run --headless-api --host 127.0.0.1 --port "$OH_PORT" \
  > "$HOME/core.log" 2>&1 &
core=$!
trap 'kill $core $fwd 2>/dev/null || true' EXIT
node /opt/harness/oh-turn.mjs
