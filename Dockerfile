FROM docker.io/cloudflare/sandbox:0.8.11

# Add Python 3 — just the runtime, no data science bloat.
# Experiment frameworks (torch, jax, tf) are pip-installed at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*
