#!/bin/sh
# Rebuild the prebuilt pi-bolt bundles when their sources have moved on.
#
#   rebuild.sh            rebuild only what is stale (what the shell hook runs)
#   rebuild.sh --check    report staleness and exit 1; rebuild nothing
#   rebuild.sh --force    rebuild every bundle unconditionally
#
# About 5 ms when there is nothing to do, so the ~/.zshrc hook can safely run it
# before every launch. Set PIBOLT_BUN if bun is not on PATH.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${PIBOLT_BUN:-}" ]; then
  bun=$PIBOLT_BUN
elif bun=$(command -v bun 2>/dev/null); then
  :
else
  echo "rebuild.sh: bun is required (install bun, or set PIBOLT_BUN to its path)" >&2
  exit 1
fi

exec "$bun" "$here/rebuild.mjs" "$@"
