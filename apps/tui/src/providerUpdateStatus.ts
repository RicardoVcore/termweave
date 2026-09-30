/**
 * Presentation helpers for provider install/update status in the TUI.
 */

import type { ServerProvider } from "@termweave/contracts";

export function isProviderUpdateActive(provider: ServerProvider | null | undefined): boolean {
  const status = provider?.updateState?.status;
  return status === "queued" || status === "running";
}

export function canRunProviderUpdate(provider: ServerProvider | null | undefined): boolean {
  return (
    provider?.versionAdvisory?.canUpdate === true &&
    provider.versionAdvisory.status === "behind_latest" &&
    !isProviderUpdateActive(provider)
  );
}

export function providerUpdateButtonLabel(provider: ServerProvider | null | undefined): string {
  const status = provider?.updateState?.status;
  if (status === "queued") return "Queued";
  if (status === "running") return "Updating...";
  return "Update";
}

export function formatProviderVersionStatus(
  provider: ServerProvider | null | undefined,
): string | null {
  if (!provider) return null;
  const updateState = provider.updateState;
  if (updateState) {
    if (updateState.status === "running") return updateState.message ?? "Updating provider.";
    if (updateState.status === "queued") return updateState.message ?? "Update queued.";
    if (updateState.status === "succeeded") return updateState.message ?? "Provider updated.";
    if (updateState.status === "failed") return updateState.message ?? "Provider update failed.";
    if (updateState.status === "unchanged")
      return updateState.message ?? "Provider still outdated.";
  }

  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest") {
    const current = advisory.currentVersion ?? provider.version ?? "installed";
    const latest = advisory.latestVersion ?? "latest";
    return `Update available ${current} -> ${latest}`;
  }
  if (advisory?.status === "current") {
    return provider.version ? `Current ${provider.version}` : "Current";
  }
  if (provider.version) return `Version ${provider.version}`;
  return provider.installed ? "Installed" : "Not installed";
}
