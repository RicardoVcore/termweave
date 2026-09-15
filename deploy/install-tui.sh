#!/usr/bin/env bash
# Termweave local client (TUI) install. Builds the workspace and links the
# `termweave` command so it runs bare (local mode) or with `attach ssh|direct`.
#
# Run from a clone of the repo (any directory - it locates the repo from its
# own path). Uses the repo's Bun; needs build tools for the native node-pty
# module that local (all-in-one) mode relies on.
#
# ponytail: apt for build deps on Debian/Ubuntu; elsewhere install
#           gcc/g++/make/python3 yourself and re-run with TERMWEAVE_SKIP_DEPS=1.
#
# Configure via env (all optional):
#   TERMWEAVE_SKIP_DEPS=1   skip the apt build-deps step (bring your own)
#   TERMWEAVE_SKIP_LINK=1   build only, do not `bun link` the command
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n== %s\n' "$1"; }

command -v bun >/dev/null 2>&1 || {
  echo "Bun not found. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

# Node 21+ / Bun provide the runtime; warn (do not fail) if node is old, since
# local mode's bundled server runs under node.
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
  if [ "$(printf '%s\n%s\n' 24.13.1 "$NODE_V" | sort -V | head -1)" != 24.13.1 ]; then
    echo "Warning: node ${NODE_V} is below the recommended 24.13.1; local mode may misbehave." >&2
  fi
fi

if [ "${TERMWEAVE_SKIP_DEPS:-0}" != 1 ] && command -v apt-get >/dev/null 2>&1; then
  log "build dependencies for native node-pty (local mode)"
  sudo apt-get update -y
  sudo apt-get install -y build-essential python3
fi

log "install dependencies (builds native node-pty)"
if ! bun install --frozen-lockfile; then
  echo "bun install failed - if it was the node-pty native build, install" >&2
  echo "build tools (gcc g++ make python3) and re-run." >&2
  exit 1
fi

log "build"
bun run build

if [ "${TERMWEAVE_SKIP_LINK:-0}" != 1 ]; then
  log "link the \`termweave\` command"
  ( cd apps/tui && bun link )
  if command -v termweave >/dev/null 2>&1; then
    log "done - run: termweave   (or: termweave attach ssh user@host)"
  else
    log "linked, but \`termweave\` is not on PATH"
    echo "Add Bun's global bin to PATH, e.g.:  export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
else
  log "done (build only) - run from the repo: bun apps/tui/src/index.tsx"
fi
