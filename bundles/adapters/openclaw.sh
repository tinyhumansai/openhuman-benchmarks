#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
export PATH=/opt/harness/openclaw/bin:$PATH
cat > "$HOME/openclaw.json5" <<JSON
{
  agents: { defaults: { model: { primary: "proxy/$BENCH_MODEL" } } },
  update: { checkOnStart: false },
  models: {
    mode: "merge",
    providers: {
      proxy: {
        baseUrl: "$PROXY_URL/v1",
        apiKey: "$DUMMY_API_KEY",
        api: "openai-completions",
        models: [{ id: "$BENCH_MODEL", name: "bench" }]
      }
    }
  }
}
JSON
exec openclaw agent exec --cwd "$WORKDIR_ABS" --config "$HOME/openclaw.json5" \
  --thinking "$BENCH_REASONING" --timeout "${TASK_TIMEOUT_S:-1800}" --json "$PROMPT"
