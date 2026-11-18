#!/usr/bin/env bash
# One-time install of the pinned cursor-agent (the `cursor` reviewer ACP agent) into its read-only sandbox
# prefix. No network: it copies the pinned versioned directory of a local cursor-agent install
# (${CURSOR_AGENT_VERSIONS:-~/.local/share/cursor-agent/versions}/<version>, as laid down by Cursor's own
# installer) and never uses the live ~/.local/bin symlink. Re-run with another version to upgrade, then
# re-run the self-check.
#
# Usage: scripts/install-cursor-acp.sh [version] [prefix]
#   version  default: the version pinned in bin/sandbox/adapters/cursor.ts (CURSOR_AGENT_VERSION)
#   prefix   default: ${REVIEWER_ACP_PREFIX:-${XDG_DATA_HOME:-~/.local/share}/reviewer-sandbox/cursor}
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
pinned=$(sed -n 's/^export const CURSOR_AGENT_VERSION = "\(.*\)";$/\1/p' "$here/bin/sandbox/adapters/cursor.ts")
version=${1:-$pinned}
prefix=${2:-${REVIEWER_ACP_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/reviewer-sandbox/cursor}}
src="${CURSOR_AGENT_VERSIONS:-$HOME/.local/share/cursor-agent/versions}/$version"

[[ "$version" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{7}$ ]] || { echo "bad version '$version'" >&2; exit 2; }
[ "$version" = "$pinned" ] || echo "warning: installing $version, the adapter pins $pinned" >&2
if [ ! -x "$src/cursor-agent" ] || [ ! -x "$src/node" ] || [ ! -f "$src/index.js" ]; then
  echo "cursor-agent $version is not installed under $src." >&2
  echo "Install that exact version with Cursor's installer first, then re-run this script." >&2
  exit 1
fi
got=$("$src/cursor-agent" --version 2>/dev/null | tr -d '\r' | tail -n 1)
[ "$got" = "$version" ] || { echo "$src/cursor-agent reports '$got', expected $version" >&2; exit 1; }

tmp="$prefix.tmp-$$"
rm -rf "$tmp"
mkdir -p "$(dirname "$prefix")"
cp -a "$src" "$tmp"
printf '%s\n' "$version" > "$tmp/REVIEWER_SANDBOX_VERSION"
chmod -R a-w "$tmp"
if [ -e "$prefix" ]; then chmod -R u+w "$prefix" && rm -rf "$prefix"; fi
mv "$tmp" "$prefix"
echo "installed cursor-agent $version into $prefix"
