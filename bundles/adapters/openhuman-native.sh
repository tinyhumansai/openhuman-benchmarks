#!/usr/bin/env bash
# OpenHuman with provider-native structured tool calls. The product default
# (`python` dispatcher) has the model write calls as text; this variant sends
# tools through the API's `tools` field like the other harnesses do.
export OPENHUMAN_TOOL_DISPATCHER=native
exec "$(dirname "$0")/openhuman-base.sh"
