#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
export PATH=/opt/harness/codex/bin:$PATH
export CODEX_HOME="$HOME/.codex"
mkdir -p "$CODEX_HOME"
# Codex only speaks the Responses wire now (wire_api = "chat" was removed), so
# this needs OpenRouter's /v1/responses to serve the pinned model.
cat > "$CODEX_HOME/config.toml" <<TOML
model = "$BENCH_MODEL"
model_provider = "proxy"
model_reasoning_effort = "$BENCH_REASONING"

[model_providers.proxy]
name = "proxy"
base_url = "$PROXY_URL/v1"
env_key = "DUMMY_API_KEY"
wire_api = "responses"
TOML
exec codex exec -C "$WORKDIR_ABS" --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check --ephemeral "$PROMPT"
