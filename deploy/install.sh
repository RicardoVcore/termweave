#!/usr/bin/env bash
# Termweave VPS server bootstrap. Automates the manual steps in VPS.md:
# build deps, a supported Node at /usr/bin/node, system-wide Bun, clone/build,
# service user + data dir + env, the systemd unit, then verify-server.sh.
#
# Debian/Ubuntu (apt) only - matches VPS.md.
# ponytail: apt + NodeSource only; other distros install Node/Bun themselves
#           and re-run with TERMWEAVE_SKIP_RUNTIME=1.
#
# Idempotent: safe to re-run (skips what already exists, pulls instead of clones).
# Run as a normal user with sudo, or as root.
#
# Configure via env (all optional):
#   TERMWEAVE_REPO        git URL           (default: the public GitHub repo)
#   TERMWEAVE_BRANCH      branch to deploy  (default: main)
#   TERMWEAVE_INSTALL_DIR install path      (default: /opt/termweave)
#   TERMWEAVE_USER        service account   (default: termweave)
#   TERMWEAVE_DATA_DIR    T3CODE_HOME       (default: /var/lib/termweave)
#   TERMWEAVE_HOST        bind address      (default: 127.0.0.1)
#   TERMWEAVE_PORT        bind port         (default: 3773)
#   TERMWEAVE_AUTH_TOKEN  app token         (default: generated for non-loopback binds)
#   TERMWEAVE_SKIP_RUNTIME=1  do not touch Node/Bun (bring your own)
set -euo pipefail

REPO="${TERMWEAVE_REPO:-https://github.com/RicardoVcore/termweave}"
BRANCH="${TERMWEAVE_BRANCH:-main}"
INSTALL_DIR="${TERMWEAVE_INSTALL_DIR:-/opt/termweave}"
SERVICE_USER="${TERMWEAVE_USER:-termweave}"
DATA_DIR="${TERMWEAVE_DATA_DIR:-/var/lib/termweave}"
HOST="${TERMWEAVE_HOST:-127.0.0.1}"
PORT="${TERMWEAVE_PORT:-3773}"
NODE_MAJOR=24 # NodeSource line; repo requires >=24.13.1 <25

log() { printf '\n== %s\n' "$1"; }

# Prefix for privileged commands: empty when already root, else `sudo`.
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
command -v "${SUDO:-true}" >/dev/null 2>&1 || {
  echo "Not root and sudo not found. Run as root or install sudo." >&2
  exit 1
}

is_loopback() { case "$1" in 127.* | ::1 | localhost) return 0 ;; *) return 1 ;; esac; }

node_ok() {
  command -v /usr/bin/node >/dev/null 2>&1 || return 1
  local v
  v="$(/usr/bin/node -p 'process.versions.node' 2>/dev/null || echo 0)"
  # >=24.13.1 and <25
  [ "$(printf '%s\n%s\n' 24.13.1 "$v" | sort -V | head -1)" = 24.13.1 ] &&
    [ "${v%%.*}" -lt 25 ]
}

log "build dependencies"
$SUDO apt-get update -y
$SUDO apt-get install -y git curl build-essential python3 openssl

if [ "${TERMWEAVE_SKIP_RUNTIME:-0}" != 1 ]; then
  if node_ok; then
    log "Node $(/usr/bin/node -p 'process.versions.node') already at /usr/bin/node"
  else
    log "installing Node ${NODE_MAJOR}.x at /usr/bin/node (NodeSource)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
    $SUDO apt-get install -y nodejs
    node_ok || {
      echo "Node at /usr/bin/node is still unsupported ($(/usr/bin/node -v 2>/dev/null))." >&2
      echo "Install Node >=24.13.1 <25 at /usr/bin/node and re-run." >&2
      exit 1
    }
  fi

  if command -v /usr/local/bin/bun >/dev/null 2>&1; then
    log "Bun already at /usr/local/bin/bun"
  else
    log "installing Bun system-wide at /usr/local/bin/bun"
    curl -fsSL https://bun.sh/install | bash
    $SUDO install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
  fi
fi
BUN="$(command -v bun || echo /usr/local/bin/bun)"

log "service account and directories"
id "$SERVICE_USER" >/dev/null 2>&1 ||
  $SUDO useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
$SUDO install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
$SUDO install -d -m 750 /etc/termweave

log "clone or update the repository at ${INSTALL_DIR}"
if [ -d "$INSTALL_DIR/.git" ]; then
  $SUDO git -C "$INSTALL_DIR" fetch origin
  $SUDO git -C "$INSTALL_DIR" checkout "$BRANCH"
  $SUDO git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  $SUDO git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi

log "install dependencies and build"
$SUDO chown -R "$(id -un)":"$(id -gn)" "$INSTALL_DIR" # build as the invoking user
(cd "$INSTALL_DIR" && "$BUN" install --frozen-lockfile && "$BUN" run build)

log "service environment (/etc/termweave/server.env)"
# Reconcile host/port every run and preserve an existing token (unless
# TERMWEAVE_AUTH_TOKEN overrides). Ensure a token whenever the bind is
# non-loopback. Always mode 600 - it holds the token.
EXISTING_TOKEN=""
if [ -f /etc/termweave/server.env ]; then
  EXISTING_TOKEN="$($SUDO grep -sE '^TERMWEAVE_AUTH_TOKEN=' /etc/termweave/server.env | head -1 | cut -d= -f2- || true)"
fi
TOKEN="${TERMWEAVE_AUTH_TOKEN:-$EXISTING_TOKEN}"
if [ -z "$TOKEN" ] && ! is_loopback "$HOST"; then
  TOKEN="$(openssl rand -hex 32)"
  log "generated auth token (stored in /etc/termweave/server.env)"
fi
$SUDO install -m 600 /dev/null /etc/termweave/server.env # create 600 before writing content
{
  echo "T3CODE_HOST=${HOST}"
  echo "T3CODE_PORT=${PORT}"
  [ -n "$TOKEN" ] && echo "TERMWEAVE_AUTH_TOKEN=${TOKEN}"
} | $SUDO tee /etc/termweave/server.env >/dev/null

log "hand the install to the service user and enable the unit"
$SUDO chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
# Render the unit with the configured user/paths (the template ships defaults).
$SUDO sed \
  -e "s|^User=.*|User=${SERVICE_USER}|" \
  -e "s|^Group=.*|Group=${SERVICE_USER}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
  -e "s|^Environment=T3CODE_HOME=.*|Environment=T3CODE_HOME=${DATA_DIR}|" \
  -e "s|^ExecStart=.*|ExecStart=/usr/bin/node ${INSTALL_DIR}/apps/server/dist/index.mjs|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=${DATA_DIR}|" \
  "$INSTALL_DIR/deploy/systemd/termweave-server.service" |
  $SUDO tee /etc/systemd/system/termweave-server.service >/dev/null
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now termweave-server

log "verify"
$SUDO env TERMWEAVE_USER="$SERVICE_USER" TERMWEAVE_INSTALL_DIR="$INSTALL_DIR" \
  T3CODE_HOME="$DATA_DIR" bash "$INSTALL_DIR/deploy/verify-server.sh" # exit status propagates

log "done - logs: ${SUDO:+sudo }journalctl -u termweave-server -f"
if ! is_loopback "$HOST"; then
  echo "Non-loopback bind (${HOST}): restrict the port at the firewall (see VPS.md)."
fi
