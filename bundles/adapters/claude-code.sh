#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
export PATH=/opt/harness/claude-code/bin:$PATH
export ANTHROPIC_BASE_URL="$PROXY_URL"          # the SDK appends /v1/messages
export ANTHROPIC_AUTH_TOKEN="$DUMMY_API_KEY"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="$BENCH_MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="$BENCH_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$BENCH_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$BENCH_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$BENCH_MODEL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_AUTOUPDATER=1
export IS_SANDBOX=1   # permission bypass is refused as root unless the container says it is a sandbox
exec claude -p "$PROMPT" --dangerously-skip-permissions --output-format json
