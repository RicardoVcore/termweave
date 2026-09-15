#!/usr/bin/env bash
# Verify a Termweave systemd deployment on the VPS it runs on.
# Checks the mechanical prerequisites (Node path/version, native node-pty,
# service user, data-dir ownership, unit install, service state, listening
# port). SIGTERM-flush and restart-preserves-state are operator steps - see the
# "Verify the deployment" section of VPS.md.
#
# Usage: sudo bash deploy/verify-server.sh
# Exit code is non-zero if any check fails.
set -u

SERVICE="${TERMWEAVE_SERVICE:-termweave-server}"
SERVICE_USER="${TERMWEAVE_USER:-termweave}"
DATA_DIR="${T3CODE_HOME:-/var/lib/termweave}"
INSTALL_DIR="${TERMWEAVE_INSTALL_DIR:-/opt/termweave}"
UNIT_FILE="/etc/systemd/system/${SERVICE}.service"
SERVER_ENTRY="${INSTALL_DIR}/apps/server/dist/index.mjs"
MIN_NODE_MAJOR=22

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}

# Node present, on PATH, and new enough. The unit runs /usr/bin/node directly.
if node_bin="$(command -v node)"; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major}" -ge "${MIN_NODE_MAJOR}" ]; then
    pass "Node ${node_major}.x at ${node_bin}"
  else
    bad "Node ${node_major}.x is older than required ${MIN_NODE_MAJOR}.x"
  fi
  [ -x /usr/bin/node ] || warn "unit ExecStart uses /usr/bin/node, but node is at ${node_bin}"
else
  bad "node not found on PATH"
fi

# Native node-pty must actually load (this is the piece that needs a build).
if [ -f "${SERVER_ENTRY}" ]; then
  pass "server build present at ${SERVER_ENTRY}"
  if (cd "${INSTALL_DIR}" && node -e 'require("node-pty")') 2>/dev/null; then
    pass "node-pty native module loads"
  else
    bad "node-pty failed to load (rebuild with build tools: gcc g++ make python3)"
  fi
else
  bad "server build missing at ${SERVER_ENTRY} (run: bun run build)"
fi

# Service account and data directory ownership/writability.
if id "${SERVICE_USER}" >/dev/null 2>&1; then
  pass "service user ${SERVICE_USER} exists"
else
  bad "service user ${SERVICE_USER} does not exist"
fi

if [ -d "${DATA_DIR}" ]; then
  owner="$(stat -c '%U' "${DATA_DIR}" 2>/dev/null || echo '?')"
  if [ "${owner}" = "${SERVICE_USER}" ]; then
    pass "data dir ${DATA_DIR} owned by ${SERVICE_USER}"
  else
    bad "data dir ${DATA_DIR} owned by ${owner}, expected ${SERVICE_USER}"
  fi
  if sudo -u "${SERVICE_USER}" test -w "${DATA_DIR}" 2>/dev/null; then
    pass "data dir writable by ${SERVICE_USER}"
  else
    bad "data dir ${DATA_DIR} not writable by ${SERVICE_USER}"
  fi
else
  bad "data dir ${DATA_DIR} does not exist"
fi

# Unit installed and service running.
[ -f "${UNIT_FILE}" ] && pass "unit installed at ${UNIT_FILE}" || bad "unit missing at ${UNIT_FILE}"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "${SERVICE}"; then
    pass "service ${SERVICE} is active"
  else
    bad "service ${SERVICE} is not active (journalctl -u ${SERVICE} -n 50)"
  fi
else
  warn "systemctl not available; skipping service-state check"
fi

# Listening port, read from the service environment when available.
port="$(grep -sE '^T3CODE_PORT=' /etc/termweave/server.env | cut -d= -f2 | tr -d '[:space:]')"
port="${port:-3773}"
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":${port}\b"; then
    pass "something is listening on port ${port}"
  else
    bad "nothing listening on port ${port}"
  fi
else
  warn "ss not available; skipping listening-port check"
fi

echo
if [ "${fail}" -eq 0 ]; then
  echo "All mechanical checks passed. Still verify SIGTERM flush and restart state manually (see VPS.md)."
else
  echo "One or more checks failed."
fi
exit "${fail}"
