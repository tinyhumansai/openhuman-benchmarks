#!/usr/bin/env bash
# OpenHuman with JEV tool ranking on. The ranker calls the TinyHumans backend's
# OpenRouter/SystemOne proxy with a TinyHumans credential; that traffic does not
# pass through the metering proxy, so JEV's own cost is reported separately.
: "${TINYHUMANS_API_KEY:?openhuman-jev needs TINYHUMANS_API_KEY}"
export OPENHUMAN_BACKEND_API_KEY="$TINYHUMANS_API_KEY"
exec "$(dirname "$0")/openhuman-base.sh"
