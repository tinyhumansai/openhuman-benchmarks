#!/usr/bin/env bash
# The `sdk-minimal` profile: a persistent shell only, no filesystem tools. This is
# the profile DeepSeek's BENCHMARK.md prescribes, so it is reported next to the full one.
export DSH_PROFILE=sdk-minimal
exec "$(dirname "$0")/deepseek-harness-base.sh"
