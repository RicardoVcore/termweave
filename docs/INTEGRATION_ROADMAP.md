# Integration Roadmap

Statuses below reflect what ships today. This document is the delivery plan for
the "Soon" and "Coming Soon" labels shown in the TUI provider settings and
source-control discovery panels.

## Principles

1. Ship complete workflows or remove the label. A visible "Coming Soon" without
   a near-term implementation path is worse than no entry: it advertises
   capability that does not exist.
2. One integration at a time. Each must cover setup, capability reporting,
   errors, and recovery before the next starts.
3. Terminal-first. Prefer CLI-backed flows (like the existing `gh`/`glab`
   probes) over hosted API accounts; the API surface is a fallback, not the
   product.

## Providers (model/runtime)

| Provider       | Status   | Path                                                                                                                                                                                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | Shipped  | -                                                                                                                                                                                                                                           |
| Claude         | Shipped  | -                                                                                                                                                                                                                                           |
| OpenCode       | Shipped  | -                                                                                                                                                                                                                                           |
| Gemini         | Next     | Reuse the Codex app-server pattern: stdio runtime wrapper in `apps/server/src/codexAppServerManager.ts` equivalent, session lifecycle, model catalog via `gemini` CLI. Deliver only if the CLI exposes a stable app-server/stdio interface. |
| GitHub Copilot | Deferred | Blocked on a stable non-interactive driver. Revisit when Copilot CLI exposes an automatable session surface.                                                                                                                                |
| ACP Registry   | Deferred | No committed implementation path.                                                                                                                                                                                                           |
| Pi Agent       | Deferred | No committed implementation path.                                                                                                                                                                                                           |

Removal rule: if a provider stays "Deferred" for two consecutive roadmap
reviews without an owner or a stable driver, drop it from
`COMING_SOON_INSTALL_PROVIDER_OPTIONS` in `apps/tui/src/providerSettings.ts`
instead of keeping the label visible.

## Version control

| VCS          | Status  | Path                                                                                                                                                                                                                 |
| ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git          | Shipped | -                                                                                                                                                                                                                    |
| Jujutsu (jj) | Next    | Discovery already detects `jj` (`apps/server/src/sourceControl/SourceControlDiscovery.ts`). Deliver status/branch/checkout/worktree operations behind the existing git quick-action surface, gated on `jj` presence. |

Jujutsu is the only committed VCS addition. No other VCS drivers are planned.

## Source-control providers (hosting)

| Provider            | Status  | Path                                                                                       |
| ------------------- | ------- | ------------------------------------------------------------------------------------------ |
| GitHub (`gh`)       | Shipped | -                                                                                          |
| GitLab (`glab`)     | Shipped | -                                                                                          |
| Azure DevOps (`az`) | Shipped | -                                                                                          |
| Bitbucket (API)     | Shipped | Auth status only today; full repository operations (PRs, branches) are the next increment. |

## Next steps, in order

1. Gemini provider runtime (largest user demand for a second model family).
2. Bitbucket repository operations on top of the existing API auth.
3. Jujutsu VCS operations.
4. Review deferred entries; drop any without a path forward.
