# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- Use conventional commit messages that match the existing repo history, e.g. `fix(tui): reduce premature sidebar collapse`.

## Project Snapshot

T1Code is a terminal UI for using coding agents like Codex and Claude, and the main product surface lives in `apps/tui`.

When a user reports UI issues without naming a surface, assume they mean the TUI in `apps/tui` unless they explicitly say web app/browser/React UI.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/tui`: Primary terminal UI for local and remote Termweave servers.
- `apps/server`: Node.js WebSocket server. Wraps coding-agent runtimes over stdio and manages provider sessions.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by server and TUI. Uses explicit subpath exports (e.g. `@termweave/shared/git`) - no barrel index.

## Codex App Server (Important)

Termweave is terminal-first. The server starts coding-agent runtimes per provider session, then streams structured events to the TUI through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- TUI consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent`.

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
