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
export T3CODE_AUTH_TOKEN="$(openssl rand -hex 32)"
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
T3CODE_AUTH_TOKEN=replace-with-random-token
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

Updates: stop service, update source, run frozen install and build, then start
service. Roll back by checking out previous commit and rebuilding. Back up
`/var/lib/termweave` before updates; it contains SQLite state, provider data,
attachments, and logs.
