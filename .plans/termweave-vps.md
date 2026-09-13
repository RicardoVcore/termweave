# Termweave VPS Direction

Termweave is a terminal-first coding-agent client. Supported deployment is a
local TUI connecting to a local or remote Termweave server. No browser,
Electron, mobile, hosted-pairing, or GPU surface is part of the product.

## Delivery order

1. Remove desktop, marketing, browser, and hosted-only code.
2. Keep server runtime API/WebSocket-only and keep TUI attachment working.
3. Harden remote authentication, reconnect, persistence, and shutdown behavior.
4. Document direct VPS installation and one systemd deployment.
5. Add server/TUI smoke verification for remote operation.
6. Implement thread ordering and reversible archiving.
7. Implement one-thread-at-a-time message queueing.

## Supported operation

- Local: TUI starts or attaches to a local server.
- Remote: TUI attaches to a VPS server using host, port, and auth token.
- VPS server: runs without a browser, Electron, or GPU.
- Providers: run on the machine hosting the server.
- Persistence: SQLite, provider state, attachments, logs, and worktrees live
  under the configured Termweave data directory.

## Remote security requirements

- Require authentication for non-loopback binds.
- Prefer Tailscale or a private network over public exposure.
- Never log or commit auth tokens.
- Reject unauthenticated and incorrectly authenticated WebSocket clients.
- Document token generation, rotation, revocation, firewall rules, and TLS
  reverse-proxy options.

## Reliability requirements

- Reconnect after temporary network loss without duplicating messages.
- Resume persisted provider sessions after server restart where supported.
- Persist partial state safely when providers or connections fail.
- Handle SIGTERM cleanly.
- Report provider and attachment failures without losing the thread.

## VPS operations

- Document supported Bun/Node versions and native build prerequisites.
- Provide one direct-install path for a standard Linux VPS.
- Provide one non-root systemd unit.
- Keep service environment and secrets outside committed files.
- Document logs, data paths, backups, updates, and rollback.

## Product backlog

- Scroll to bottom after send while preserving intentional reading position.
- Sort projects by latest thread update.
- Put new projects first.
- Show a bounded active-thread list.
- Archive and restore threads without deleting data.
- Queue messages in order with retry and cancellation.

## Verification

Every PR to `staging` and `main` runs:

```bash
bun fmt:check
bun lint
bun typecheck
bun run test
```

Remote smoke coverage must start a token-protected server, verify auth,
connect a TUI client, exercise one provider turn, stop with SIGTERM, restart,
and verify persisted state.

## Deferred indefinitely

- Upstream visual parity.
- Electron desktop distribution.
- Browser-first workflows.
- Mobile/iOS applications.
- Hosted SaaS and pairing services.
- Multiple deployment systems before systemd is proven.
