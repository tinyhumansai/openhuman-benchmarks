# Harness bundles for the benchmark. Each target produces /opt/harness with:
#   node/         Node.js (runner/entry.mjs runs under it in every task container)
#   adapter.sh    the harness's headless entry point (see adapters/)
#   <harness>/    the harness itself
# Built on Ubuntu 22.04 so the bundle runs inside the official SWE-bench
# instance images (also 22.04). `build.sh` extracts /opt/harness to .cache/.
FROM ubuntu:22.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils git python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
ARG NODE_MAJOR=24
RUN set -eux; mkdir -p /opt/harness/node; \
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    file="$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz/{print $2}')"; \
    curl -fsSL "$base/$file" | tar -xJ --strip-components=1 -C /opt/harness/node; \
    /opt/harness/node/bin/node --version
COPY adapters/_common.sh /opt/harness/_common.sh
ENV PATH=/opt/harness/node/bin:$PATH

FROM base AS claude-code
ARG CLAUDE_CODE_VERSION
RUN npm install -g --prefix /opt/harness/claude-code --no-audit --no-fund \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
COPY adapters/claude-code.sh /opt/harness/adapter.sh

FROM base AS codex
ARG CODEX_VERSION
RUN npm install -g --prefix /opt/harness/codex --no-audit --no-fund @openai/codex@${CODEX_VERSION}
COPY adapters/codex.sh /opt/harness/adapter.sh

FROM base AS opencode
ARG OPENCODE_VERSION
RUN npm install -g --prefix /opt/harness/opencode --no-audit --no-fund opencode-ai@${OPENCODE_VERSION}
COPY adapters/opencode.sh /opt/harness/adapter.sh

FROM base AS openclaw
ARG OPENCLAW_VERSION
RUN npm install -g --prefix /opt/harness/openclaw --no-audit --no-fund openclaw@${OPENCLAW_VERSION}
COPY adapters/openclaw.sh /opt/harness/adapter.sh

# Hermes ships its own installer, which stages Python and Node. Point HOME at
# the bundle so everything it installs lands under /opt/harness; the adapter
# copies that tree to a writable HOME at run time (counted in its cold start).
FROM base AS hermes
ARG HERMES_VERSION
ENV HOME=/opt/harness/home
RUN mkdir -p "$HOME" && curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash \
    && (/opt/harness/home/.local/bin/hermes --version || true)
COPY adapters/hermes.sh /opt/harness/adapter.sh
