FROM docker.io/cloudflare/sandbox:0.8.11

# Runtimes available to sub-agents:
#   - python3 (Python)
#   - node    (JavaScript)
#   - bash    (always present in base image)
#
# Using nodejs from Debian repos — enough for stdlib-only JS. If we need
# newer Node (ESM features, fetch, etc.), switch to NodeSource tarball.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      nodejs \
 && rm -rf /var/lib/apt/lists/*
