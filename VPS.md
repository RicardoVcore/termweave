# VPS deployment

Termweave has two processes:

- `termweave-server` runs on VPS and starts coding-agent providers.
- local `termweave` TUI connects over WebSocket.

No browser or Electron process runs on VPS.

## Direct install

Requirements: Linux, Node.js 22+, Bun 1.3.9+, Git, and native build tools for
`node-pty` (`gcc`, `g++`, `make`, and Python).

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

`ufw` (Debian/Ubuntu), allowing only the Tailscale CGNAT range:

```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow from 100.64.0.0/10 to any port 3773 proto tcp
sudo ufw enable
sudo ufw status verbose
```

Swap `100.64.0.0/10` for your LAN/VPN CIDR (for example `192.168.1.0/24`) if you
attach over that instead. `nftables` equivalent:

```bash
sudo nft add rule inet filter input tcp dport 3773 ip saddr 100.64.0.0/10 accept
sudo nft add rule inet filter input tcp dport 3773 drop
```

## Operations

Data paths (all under `T3CODE_HOME`, `/var/lib/termweave` for the systemd unit):
SQLite state, provider data, attachments, and logs.

Logs:

```bash
sudo journalctl -u termweave-server -f          # follow
sudo journalctl -u termweave-server --since today
```

Backup (stop first for a consistent SQLite snapshot):

```bash
sudo systemctl stop termweave-server
sudo tar czf "/var/backups/termweave-$(date +%F).tar.gz" -C /var/lib termweave
sudo systemctl start termweave-server
```

Update:

```bash
sudo systemctl stop termweave-server
sudo -u termweave git -C /opt/termweave fetch origin
sudo -u termweave git -C /opt/termweave checkout <new-commit-or-tag>
sudo -u termweave bash -c 'cd /opt/termweave && bun install --frozen-lockfile && bun run build'
sudo systemctl start termweave-server
sudo bash /opt/termweave/deploy/verify-server.sh
```

Roll back: check out the previous commit and rebuild, same steps:

```bash
sudo systemctl stop termweave-server
sudo -u termweave git -C /opt/termweave checkout <previous-commit>
sudo -u termweave bash -c 'cd /opt/termweave && bun install --frozen-lockfile && bun run build'
sudo systemctl start termweave-server
```

Back up `/var/lib/termweave` before every update so a rollback can restore state
if a migration is involved.

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
