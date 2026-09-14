# Remote Access Setup

Use this when local Termweave TUI connects to Termweave server running on local machine or VPS.

## CLI ↔ Env option map

The Termweave CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag               | Env var                | Notes                                                                                |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `--port <number>`      | `T3CODE_PORT`          | HTTP/WebSocket port.                                                                 |
| `--host <address>`     | `T3CODE_HOST`          | Bind interface/address.                                                              |
| `--home-dir <path>`    | `T3CODE_HOME`          | Base directory.                                                                      |
| `--auth-token <token>` | `TERMWEAVE_AUTH_TOKEN` | WebSocket auth token. `T3CODE_AUTH_TOKEN` remains a legacy alias.                    |
| `--bootstrap-fd <fd>`  | `T3CODE_BOOTSTRAP_FD`  | Read a one-shot bootstrap envelope from an inherited file descriptor during startup. |

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

If you use Tailscale, you can bind directly to your Tailnet address.

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
