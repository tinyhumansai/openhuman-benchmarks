FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund gpt-tokenizer@3 && apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY wire.mjs pricing.mjs capture.mjs headers.mjs proxy.mjs ./
CMD ["node", "proxy.mjs"]
