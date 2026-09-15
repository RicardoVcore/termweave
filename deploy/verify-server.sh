#!/usr/bin/env bash
# Verify a Termweave systemd deployment on the VPS it runs on.
# Checks the mechanical prerequisites (the exact Node binary systemd uses and its
# version, native node-pty load, service user, data-dir ownership/writability,
# unit properties, service state, and that the service process is listening).
# SIGTERM-flush and restart-preserves-state are operator steps - see the
# "Verify the deployment" section of VPS.md.
#
# Usage: sudo bash deploy/verify-server.sh
# Exit code is non-zero if any check fails.
set -u

SERVICE="${TERMWEAVE_SERVICE:-termweave-server}"
SERVICE_USER="${TERMWEAVE_USER:-termweave}"
DATA_DIR="${T3CODE_HOME:-/var/lib/termweave}"
INSTALL_DIR="${TERMWEAVE_INSTALL_DIR:-/opt/termweave}"
# systemd's ExecStart runs this exact binary, so verify it - not whatever `node`
# happens to be first on the current PATH.
NODE_BIN="${TERMWEAVE_NODE_BIN:-/usr/bin/node}"
UNIT_FILE="/etc/systemd/system/${SERVICE}.service"
SERVER_ENTRY="${INSTALL_DIR}/apps/server/dist/index.mjs"
MIN_NODE_MAJOR=24 # repo engines: root node ^24.13.1, server >=24.10

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash deploy/verify-server.sh" >&2
  exit 2
fi

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
bad() {
  printf 'FAIL  %s\n' "$1"
  fail=1
}

# The Node binary systemd uses, and its version.
if [ -x "${NODE_BIN}" ]; then
  node_major="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major}" -ge "${MIN_NODE_MAJOR}" ] 2>/dev/null; then
    pass "Node ${node_major}.x at ${NODE_BIN}"
  else
    bad "Node at ${NODE_BIN} is ${node_major}.x, older than required ${MIN_NODE_MAJOR}.x"
  fi
else
  bad "${NODE_BIN} not found or not executable (systemd ExecStart uses it)"
fi

# Native node-pty must load under that same Node binary.
if [ -f "${SERVER_ENTRY}" ]; then
  pass "server build present at ${SERVER_ENTRY}"
  if [ -x "${NODE_BIN}" ] && (cd "${INSTALL_DIR}" && "${NODE_BIN}" -e 'require("node-pty")') 2>/dev/null; then
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
  if id "${SERVICE_USER}" >/dev/null 2>&1 && sudo -u "${SERVICE_USER}" test -w "${DATA_DIR}"; then
    pass "data dir writable by ${SERVICE_USER}"
  else
    bad "data dir ${DATA_DIR} not writable by ${SERVICE_USER}"
  fi
else
  bad "data dir ${DATA_DIR} does not exist"
fi

# Unit installed, with the properties the deployment requires.
if [ -f "${UNIT_FILE}" ]; then
  pass "unit installed at ${UNIT_FILE}"
else
  bad "unit missing at ${UNIT_FILE}"
fi

if command -v systemctl >/dev/null 2>&1; then
  check_prop() {
    # check_prop <property> <expected-substring>
    local actual
    actual="$(systemctl show -p "$1" --value "${SERVICE}" 2>/dev/null)"
    case "${actual}" in
    *"$2"*) pass "unit ${1}=${actual}" ;;
    *) bad "unit ${1}='${actual}', expected to contain '$2'" ;;
    esac
  }
  check_prop User "${SERVICE_USER}"
  check_prop Group "${SERVICE_USER}"
  check_prop WorkingDirectory "${INSTALL_DIR}"
  check_prop ExecStart "${SERVER_ENTRY}"

  if systemctl is-active --quiet "${SERVICE}"; then
    pass "service ${SERVICE} is active"
  else
    bad "service ${SERVICE} is not active (journalctl -u ${SERVICE} -n 50)"
  fi
else
  warn "systemctl not available; skipping unit-property and service-state checks"
fi

# The service process itself must be listening on the configured port - not just
# "someone" on that port.
port="$(grep -sE '^T3CODE_PORT=' /etc/termweave/server.env | cut -d= -f2 | tr -d '[:space:]')"
port="${port:-3773}"
case "${port}" in
'' | *[!0-9]*) bad "configured T3CODE_PORT '${port}' is not numeric" ;;
*)
  mainpid="$(systemctl show -p MainPID --value "${SERVICE}" 2>/dev/null || echo 0)"
  if command -v ss >/dev/null 2>&1 && [ "${mainpid}" -gt 0 ] 2>/dev/null; then
    if ss -ltnp 2>/dev/null | grep -F "pid=${mainpid}," | grep -q ":${port} "; then
      pass "service (pid ${mainpid}) listening on port ${port}"
    else
      bad "service pid ${mainpid} is not listening on port ${port}"
    fi
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":${port} " &&
      warn "port ${port} has a listener, but could not confirm it is ${SERVICE}" ||
      bad "nothing listening on port ${port}"
  else
    warn "ss not available; skipping listening-port check"
  fi
  ;;
esac

echo
if [ "${fail}" -eq 0 ]; then
  echo "All mechanical checks passed. Still verify SIGTERM flush and restart state manually (see VPS.md)."
else
  echo "One or more checks failed."
fi
exit "${fail}"
