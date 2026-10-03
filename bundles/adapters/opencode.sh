#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
export PATH=/opt/harness/opencode/bin:$PATH
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
cat > "$HOME/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "proxy",
      "options": { "baseURL": "$PROXY_URL/v1", "apiKey": "$DUMMY_API_KEY" },
      "models": { "$BENCH_MODEL": { "name": "bench" } }
    }
  }
}
JSON
export OPENCODE_CONFIG="$HOME/opencode.json"
exec opencode run --dir "$WORKDIR_ABS" -m "proxy/$BENCH_MODEL" \
  --dangerously-skip-permissions "$PROMPT"
