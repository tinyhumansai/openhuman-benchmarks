# Task image for the micro suite. Ubuntu 22.04 to match the official SWE-bench
# instance images, so a single harness bundle (built on 22.04) runs in both.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 curl make build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
