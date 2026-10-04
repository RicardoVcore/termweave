# Remote Access Setup

Use this when local Termweave TUI connects to Termweave server running on local machine or VPS.

## Install the local client

`deploy/install-tui.sh` builds the workspace (including the native `node-pty`
that local all-in-one mode needs) and links the `termweave` command:

```bash
git clone https://github.com/RicardoVcore/termweave
bash termweave/deploy/install-tui.sh
```

Then run `termweave` for a local session, or `termweave attach ssh user@host` /
`termweave attach direct host[:port]` to reach a remote server. Needs Bun; on
Debian/Ubuntu the script installs the `node-pty` build tools (set
`TERMWEAVE_SKIP_DEPS=1` to skip, `TERMWEAVE_SKIP_LINK=1` to build without
linking). See the top of the script for options.

## CLI ↔ Env option map

The Termweave CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                        | Env var                          | Notes                                                                                |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `--port <number>`               | `T3CODE_PORT`                    | HTTP/WebSocket port.                                                                 |
| `--host <address>`              | `T3CODE_HOST`                    | Bind interface/address.                                                              |
| `--home-dir <path>`             | `T3CODE_HOME`                    | Base directory.                                                                      |
| `--auth-token <token>`          | `TERMWEAVE_AUTH_TOKEN`           | WebSocket auth token. `T3CODE_AUTH_TOKEN` remains a legacy alias.                    |
| `--tailscale-serve`             | `TERMWEAVE_TAILSCALE_SERVE`      | Expose the loopback server to the tailnet over HTTPS. Requires an auth token.        |
| `--tailscale-serve-port <port>` | `TERMWEAVE_TAILSCALE_SERVE_PORT` | Tailscale Serve HTTPS port (default 443). Setting it also enables Serve.             |
| `--bootstrap-fd <fd>`           | `T3CODE_BOOTSTRAP_FD`            | Read a one-shot bootstrap envelope from an inherited file descriptor during startup. |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
  - When you control the process launcher, prefer sending the auth token in a JSON envelope via `--bootstrap-fd <fd>`.
    With `--bootstrap-fd <fd>`, the launcher starts the server first, then sends a one-shot JSON envelope over the inherited file descriptor. This allows the auth token to be delivered without putting it in process environment or command line arguments.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## 1) Build + run server for remote access

Build server on VPS, then connect from local TUI.

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN"
```

Configure local TUI with server host, port, and token. TUI uses WebSocket; no browser required.

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- Ensure your OS firewall allows inbound TCP on the selected port.

## 2) Tailnet / Tailscale access

If you use Tailscale, Tailscale Serve is the recommended path. Start the server with Serve enabled:

```bash
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --tailscale-serve --auth-token "$TOKEN"
```

Then attach from the client with:

```bash
TERMWEAVE_AUTH_TOKEN="$TOKEN" termweave attach direct wss://<machine>.<tailnet>.ts.net
```

Replace `<machine>.<tailnet>.ts.net` with the server's MagicDNS name. The endpoint
is also listed in the TUI Connections view.

Notes:

- The server stays on loopback; do not pass `--host`. Tailscale Serve terminates
  HTTPS on the tailnet and proxies to `127.0.0.1`.
- The auth token is mandatory in this mode. Without it every device on the
  tailnet could drive the agent, so startup fails.
- MagicDNS and HTTPS certificates must be enabled for the tailnet (admin console,
  DNS page).
- The server user must be root or the Tailscale operator:
  `sudo tailscale set --operator=<user>`.
- Serve on port 443 replaces any existing Tailscale Serve config on that port.
  Use `--tailscale-serve-port 8443` to keep it.
- Startup fails when `tailscale serve` cannot be configured. Serve is turned off
  again on shutdown.

Alternatively, bind directly to your Tailnet address if you prefer not to use Serve:

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN"
```

Point local TUI at `ws://<tailnet-ip>:3773`.

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.

## 3) SSH-managed attach (default remote path)

Keep the server bound to loopback on the VPS and let OpenSSH carry the transport:

```bash
termweave attach ssh user@host
```

Termweave allocates a local port, opens `ssh -N -L <local>:127.0.0.1:<remote> user@host`,
waits for the tunnel, then connects the TUI to `127.0.0.1:<local>`. It reuses
`~/.ssh/config`, SSH aliases, and your SSH agent.

Authentication is entirely OpenSSH's:

- Host-key, password, and passphrase prompts appear on your terminal. Termweave
  never reads, buffers, logs, or stores them - the password lives only in
  OpenSSH's memory.
- No `SSH_ASKPASS` helper is ever spawned (`SSH_ASKPASS_REQUIRE=never`). A
  no-terminal / headless attach therefore cannot answer a password prompt - use
  key or agent authentication for that case.

### Manual SSH fallback

If you prefer to manage the tunnel yourself (or `attach ssh` is unavailable),
open it manually and point the TUI at the local end:

```bash
ssh -N -L 3773:127.0.0.1:3773 user@host
# then, in another shell / the TUI, connect to ws://127.0.0.1:3773
```

Use any free local port on the left side. The server stays loopback-only on the
VPS; SSH provides the encryption and VPS authentication, so the Termweave
application token is optional on this path.

## 4) Direct WebSocket attach

For a server reachable on a private network you already trust - a Tailnet IP, a
LAN/VPN address - connect the TUI straight to it:

```bash
termweave attach direct <host[:port]>
# examples
termweave attach direct 100.101.102.103        # Tailscale IP, default port 3773
termweave attach direct 192.168.1.50:3773      # LAN
termweave attach direct wss://vps.example.com  # public host, TLS terminated in front
```

The target may be a bare `host[:port]` (assumes `ws://`) or a full
`ws://` / `wss://` URL. Default port is `3773`, or `443` for a `wss://` target
without a port. IPv6 literals use brackets: `[fd7a:1::2]:3773`.

Security rules enforced by the client:

- **Application token required for every non-loopback bind.** Set
  `TERMWEAVE_AUTH_TOKEN` (legacy `T3CODE_AUTH_TOKEN`/`T1CODE_AUTH_TOKEN` still
  accepted). Loopback (`127.0.0.1`, `::1`, `localhost`) may connect without one.
- **Plain `ws://` to a public IP is refused.** Use `wss://` (put TLS - a reverse
  proxy such as Caddy/nginx - in front of the server), or reach the host over
  Tailscale / a private network, or use `termweave attach ssh`.
- A `ws://` connection to an unresolved public _hostname_ is allowed with a
  loud warning, since it may be a Tailscale MagicDNS or LAN name whose network
  encrypts the traffic. Prefer `wss://` when the network does not.

Private/Tailscale ranges recognized as non-public: `10/8`, `172.16/12`,
`192.168/16`, `169.254/16`, `100.64/10` (CGNAT, includes Tailscale), IPv6
`fc00::/7` (ULA, includes Tailscale `fd7a:…`) and `fe80::/10`.

### Tailscale

Tailscale is optional infrastructure. Install and configure it yourself
(<https://tailscale.com/download>); Termweave never installs Tailscale and only
touches its configuration when you opt in with `--tailscale-serve`. When your
machine and the server share a tailnet, use Tailscale Serve (section 2) as the
recommended path, or bind the server to its Tailnet IP and point the TUI at that
address:

```bash
termweave attach direct "$(tailscale ip -4)":3773
```
