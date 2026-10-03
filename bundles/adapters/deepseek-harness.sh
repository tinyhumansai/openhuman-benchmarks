#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
export DSH_HOME="$HOME/dsh-home"
mkdir -p "$DSH_HOME"
export DSH_PROFILE="${DSH_PROFILE:-sdk}"
# The SDK's direct DeepSeek adapter speaks OpenAI chat completions to this base URL.
export DEEPSEEK_API_KEY="$DUMMY_API_KEY"
export DEEPSEEK_BASE_URL="$PROXY_URL/v1"
exec /opt/harness/venv/bin/python /opt/harness/dsh_run.py
