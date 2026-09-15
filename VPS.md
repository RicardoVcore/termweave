# VPS deployment

Termweave has two processes:

- `termweave-server` runs on VPS and starts coding-agent providers.
- local `termweave` TUI connects over WebSocket.

No browser or Electron process runs on VPS.

## Direct install

Requirements: Linux, Node.js 24.13+, Bun 1.3.9+, Git, and native build tools for
`node-pty` (`gcc`, `g++`, `make`, and Python). Node.js must be at `/usr/bin/node`
for the systemd unit below (or set `TERMWEAVE_NODE_BIN` when running the
verification script).

```bash
sudo apt install git build-essential python3
sudo mkdir -p /opt/termweave
sudo chown "$USER" /opt/termweave
git clone https://github.com/RicardoVcore/termweave /opt/termweave
cd /opt/termweave
bun install --frozen-lockfile
bun run build
```

Generate token and run server. Keep token outside shell history where possible:

```bash
export TERMWEAVE_AUTH_TOKEN="$(openssl rand -hex 32)"
export T3CODE_HOME="$HOME/.local/share/termweave"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773
```

Configure local TUI with VPS host, port `3773`, and token. Prefer a Tailscale
address or firewall-restricted interface over `0.0.0.0`.

## systemd

Create service account and directories:

```bash
sudo useradd --system --home /var/lib/termweave --shell /usr/sbin/nologin termweave
sudo install -d -o termweave -g termweave /var/lib/termweave
sudo install -d -m 750 /etc/termweave
sudo install -m 644 deploy/systemd/termweave-server.service /etc/systemd/system/termweave-server.service
```

Create `/etc/termweave/server.env` with mode `600`:

```text
T3CODE_HOST=100.64.0.10
T3CODE_PORT=3773
TERMWEAVE_AUTH_TOKEN=replace-with-random-token
```

Install Node.js at `/usr/bin/node`, build as above, then enable service:

```bash
sudo chown -R termweave:termweave /opt/termweave
sudo chmod 600 /etc/termweave/server.env
sudo systemctl daemon-reload
sudo systemctl enable --now termweave-server
sudo systemctl status termweave-server
sudo journalctl -u termweave-server -f
```

## Firewall

The auth token gates WebSocket access but does not encrypt transport, so do not
leave the port open to the public internet. Prefer binding to a Tailnet or LAN
address (`T3CODE_HOST`), and restrict the port at the firewall to the networks
you actually connect from.

Default remote path is SSH (`termweave attach ssh`), which needs no extra
inbound rule beyond port 22 - the server stays on loopback. Only open the
Termweave port for direct/Tailnet attach.

`ufw` (Debian/Ubuntu). **Allow your real SSH port before enabling the firewall,
or you can lock yourself out** - if `sshd` listens on a non-default port, use
that instead of `22`, and keep a second console/session open until you have
confirmed you can still reach the box:

```bash
# Replace 22 with your real sshd port if you changed it (check: sudo ss -ltnp | grep sshd)
sudo ufw allow 22/tcp
sudo ufw allow from 100.64.0.0/10 to any port 3773 proto tcp
sudo ufw default deny incoming
sudo ufw status verbose   # confirm your SSH port is listed BEFORE enabling
sudo ufw enable
```

Swap `100.64.0.0/10` for your LAN/VPN CIDR (for example `192.168.1.0/24`) if you
attach over that instead.

`nftables` equivalent. Loaded with `nft -f` so it is atomic and idempotent (the
`table {}` / `delete table` preamble makes a rerun replace the table cleanly
instead of duplicating rules). `tcp dport 22` matches SSH over both IPv4 and
IPv6 in the `inet` family; `icmpv6` is allowed so IPv6 neighbour discovery keeps
working on a dual-stack VPS:

```bash
sudo nft -f - <<'EOF'
table inet termweave { }
delete table inet termweave
table inet termweave {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    meta l4proto ipv6-icmp accept
    tcp dport 22 accept
    ip  saddr 100.64.0.0/10        tcp dport 3773 accept
    ip6 saddr fd7a:115c:a1e0::/48  tcp dport 3773 accept
  }
}
EOF
```

Swap the `saddr` CIDRs for your own tailnet/LAN ranges. Persist across reboot
(the redirect, not a `tee` pipe, so an `nft` failure is not masked) and enable
the service:

```bash
sudo sh -c 'nft list ruleset > /etc/nftables.conf'
sudo systemctl enable nftables
```

The `policy drop` filters *all* input, so keep the SSH, loopback, and icmpv6
rules; adapt if you already manage another table.

## Operations

All data lives under `T3CODE_HOME` (`/var/lib/termweave` for the systemd unit):

- `userdata/state.sqlite` - event-sourced SQLite state (threads, provider runs).
- `userdata/attachments/` - stored attachments.
- `userdata/secrets/`, `userdata/settings.json`, `userdata/keybindings.json`.
- `userdata/logs/` - `server.log`, `server.trace.ndjson`, `provider/`, `terminals/`.
- `caches/` - provider status cache (safe to discard).
- `worktrees/` - provider working trees.

Logs:

```bash
sudo journalctl -u termweave-server -f          # follow
sudo journalctl -u termweave-server --since today
```

Backup. Stop first for a consistent SQLite snapshot; abort if the stop fails
(so a live DB is never archived), restart afterwards whatever `tar` did, and
report both `tar` and restart failures:

```bash
sudo install -d -m 700 /var/backups/termweave
sudo systemctl stop termweave-server || { echo "stop failed, not backing up a live DB"; exit 1; }
sudo tar czf "/var/backups/termweave/state-$(date +%Y%m%d-%H%M%S).tar.gz" -C /var/lib termweave; rc=$?
sudo systemctl start termweave-server || echo "WARNING: service did not restart"
[ "$rc" -eq 0 ] && echo "backup ok" || echo "BACKUP FAILED (rc=$rc)"
```

Update. Each step must succeed before the next, so the service only restarts on
a good build; if the build fails the service stays stopped - fix it or roll back
before starting:

```bash
sudo systemctl stop termweave-server &&
  sudo -u termweave bash -euc '
    cd /opt/termweave &&
    git fetch origin &&
    git checkout <new-commit-or-tag> &&
    bun install --frozen-lockfile &&
    bun run build
  ' && sudo systemctl start termweave-server && sudo bash /opt/termweave/deploy/verify-server.sh
```

Roll back to the previous commit and rebuild, same fail-fast chaining:

```bash
sudo systemctl stop termweave-server &&
  sudo -u termweave bash -euc '
    cd /opt/termweave &&
    git checkout <previous-commit> &&
    bun install --frozen-lockfile &&
    bun run build
  ' && sudo systemctl start termweave-server
```

Restore state from a backup **only** when a schema/data migration left the old
code incompatible with the current state (a plain code rollback does not need
it). This overwrites `/var/lib/termweave` - destructive:

```bash
sudo systemctl stop termweave-server
sudo tar xzf /var/backups/termweave/state-<stamp>.tar.gz -C /var/lib &&
  sudo chown -R termweave:termweave /var/lib/termweave &&
  sudo systemctl start termweave-server
```

If the extraction fails the service is left stopped (not restarted onto broken
state); re-extract from a good backup before starting.

Always back up before an update so this restore is available if a migration is
involved.

## Verify the deployment

After install or update, run the mechanical health check on the VPS:

```bash
sudo bash /opt/termweave/deploy/verify-server.sh
```

It checks the Node path and version, that the native `node-pty` module loads,
the service user, data-directory ownership and writability, the installed unit,
the service state, and the listening port. Exit code is non-zero if any check
fails.

Two properties need a manual check because they depend on live state:

- **SIGTERM flushes state.** Open a thread from the TUI, then
  `sudo systemctl stop termweave-server`. The stop should return promptly (the
  server runs finalizers on SIGTERM); the journal should show a clean shutdown,
  not a `SIGKILL` timeout.
- **Restart preserves state.** Start the service again and reconnect the TUI.
  The thread and its history should still be present - they are event-sourced in
  the SQLite state under `/var/lib/termweave`.

## Token rotation and revocation

Token protects WebSocket access. It does not encrypt transport. A private LAN
limits who can reach the port but does not provide encryption. Use SSH
port-forwarding, Tailscale, or TLS when transport confidentiality is required.

To rotate a systemd deployment:

1. Stop the service: `sudo systemctl stop termweave-server`.
2. Replace `TERMWEAVE_AUTH_TOKEN` in `/etc/termweave/server.env` with a new
   random value: `openssl rand -hex 32`.
3. Update local TUI connection settings with new token.
4. Start service: `sudo systemctl start termweave-server`.

Restart closes existing WebSocket connections. Old token stops working after
restart. For direct runs, stop process, replace environment token, then start
again.
