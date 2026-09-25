/**
 * Summary and status helpers for source-control discovery items shown in the
 * TUI settings panel.
 */

import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDiscoveryItem,
} from "@termweave/contracts";
import type { TuiColor } from "./theme";

export function authStatusLabel(auth: SourceControlProviderAuth): string {
  switch (auth.status) {
    case "authenticated":
      return "Authenticated";
    case "unauthenticated":
      return "Sign-in needed";
    case "unknown":
      return "Unknown auth";
  }
}

export function sourceControlStatusColor(input: {
  readonly status: "available" | "missing";
  readonly implemented?: boolean;
  readonly auth?: SourceControlProviderAuth;
}): TuiColor {
  if (input.implemented === false) return "subtle";
  if (input.status !== "available") return "warning";
  if (input.auth && input.auth.status !== "authenticated") return "warning";
  return "success";
}

export function vcsSummary(item: VcsDiscoveryItem): string {
  if (!item.implemented) return `Support for ${item.label} is coming soon.`;
  if (item.status !== "available") return `Not available on this server: ${item.installHint}`;
  return "Available";
}

export function sourceControlProviderSummary(item: SourceControlProviderDiscoveryItem): string {
  if (item.status !== "available") return `Not available on this server: ${item.installHint}`;
  if (item.auth.status === "authenticated") {
    return item.auth.account
      ? `${item.auth.account}${item.auth.host ? ` on ${item.auth.host}` : ""}`
      : "Authenticated";
  }
  return item.auth.detail ?? item.detail ?? item.installHint;
}
