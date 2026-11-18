#!/usr/bin/env bash
# Runs a compozy command against an ISOLATED CompozyOS home (never the operator's ~/.compozy).
# Usage: scripts/it-env.sh <compozy args...>
# Home: $IT_HOME (default /tmp/ghar-it/home); HTTP port $IT_PORT (default 2391, never 2123).
set -euo pipefail
IT_HOME="${IT_HOME:-/tmp/ghar-it/home}"
IT_PORT="${IT_PORT:-2391}"
if [ "$IT_PORT" = "2123" ]; then echo "refusing the operator daemon port 2123" >&2; exit 2; fi
case "$IT_HOME" in "$HOME/.compozy"*) echo "refusing the operator home" >&2; exit 2;; esac
mkdir -p "$IT_HOME"
if [ ! -f "$IT_HOME/config.toml" ]; then
  cat > "$IT_HOME/config.toml" <<EOF
[http]
host = "127.0.0.1"
port = $IT_PORT

[daemon]
socket = "$IT_HOME/daemon.sock"
EOF
fi
# The mutating tools (submit_review, upsert_promotion) must pass source policy in the isolated home.
if ! grep -q '^\[tools\.policy\]' "$IT_HOME/config.toml"; then
  cat >> "$IT_HOME/config.toml" <<EOF

[tools.policy]
trusted_sources = ["extension:github-app-review"]
EOF
fi
# Drop every COMPOZY_* variable inherited from the operator session, then point at the isolated home.
unset $(env | grep -o '^COMPOZY_[A-Z_]*' || true)
export COMPOZY_HOME="$IT_HOME"
exec compozy "$@"
