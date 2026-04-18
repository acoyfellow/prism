FROM docker.io/cloudflare/sandbox:0.8.11

# Runtimes available to sub-agents (all invoked as `<cmd> <file>`):
#
# Pre-installed by the base image:
#   - bash   (always)
#   - node   (JavaScript)
#   - bun    (TypeScript/JavaScript, no transpile step)
#   - perl
#   - awk, sed (via coreutils)
#
# Added here:
#   - python3        (Python)
#   - ruby           (Ruby)
#   - golang-go      (Go — `go run file.go` works for single-file programs)
#   - php-cli        (PHP CLI)
#   - lua5.4         (Lua)
#
# Intentionally NOT here (see src/index.ts for reasoning):
#   Java, Scala, Kotlin, R, Rust, Swift, .NET, Julia, Crystal, Zig, Nim,
#   Haskell, OCaml, Erlang, Elixir — either too big, not in apt, or the
#   LLM writes them poorly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      ruby \
      golang-go \
      php-cli \
      lua5.4 \
 && rm -rf /var/lib/apt/lists/*
