// Discovers Termweave backends on the user's tailnet.
// Lists online peers from `tailscale status --json`, then probes each peer's
// Tailscale Serve endpoint for the environment descriptor.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ENVIRONMENT_DESCRIPTOR_PATH } from "@termweave/contracts";

import type { ConnectionProfile } from "./connectionProfiles";

const execFileAsync = promisify(execFile);

const STATUS_TIMEOUT_MS = 5_000;
const STATUS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 3_000;

export interface TailnetBackend {
  /** MagicDNS name without the trailing dot, e.g. box.tail1234.ts.net */
  readonly dnsName: string;
  /** Label the backend reports in its environment descriptor. */
  readonly label: string;
}

interface TailscalePeer {
  readonly DNSName?: unknown;
  readonly Online?: unknown;
}

interface TailscaleStatus {
  readonly Peer?: unknown;
}

/** Online peers' MagicDNS names from `tailscale status --json` output. */
export function parseTailscalePeerDnsNames(rawStatusJson: string): readonly string[] {
  let status: TailscaleStatus;
  try {
    status = JSON.parse(rawStatusJson) as TailscaleStatus;
  } catch {
    return [];
  }
  if (
    typeof status !== "object" ||
    status === null ||
    typeof status.Peer !== "object" ||
    status.Peer === null
  ) {
    return [];
  }

  const dnsNames = new Set<string>();
  for (const peer of Object.values(status.Peer) as TailscalePeer[]) {
    if (typeof peer !== "object" || peer === null || peer.Online !== true) continue;
    if (typeof peer.DNSName !== "string") continue;
    const dnsName = peer.DNSName.replace(/\.$/, "");
    if (dnsName.length > 0) dnsNames.add(dnsName);
  }
  return [...dnsNames].toSorted();
}

/** Probes one host for a Termweave backend over tailnet HTTPS. Resolves null for anything that is not one. */
export async function probeTailnetBackend(
  dnsName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TailnetBackend | null> {
  let response: Response;
  try {
    // ponytail: only the default Tailscale Serve port (443) is probed; add a port
    // list if backends on other serve ports must be discovered.
    response = await fetchImpl(`https://${dnsName}${ENVIRONMENT_DESCRIPTOR_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const descriptor: unknown = await response.json().catch(() => null);
  if (typeof descriptor !== "object" || descriptor === null) return null;
  const record = descriptor as Record<string, unknown>;
  const { environmentId, label } = record;
  if (typeof environmentId !== "string" || environmentId.length === 0) return null;
  if (typeof label !== "string" || label.length === 0) return null;
  return { dnsName, label };
}

async function readTailscaleStatusJson(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER_BYTES,
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Tailscale CLI not found. Install Tailscale to scan the tailnet.", {
        cause: error,
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`tailscale status failed: ${detail}`, { cause: error });
  }
}

/**
 * Lists online tailnet peers and returns the ones running a Termweave backend.
 * Rejects when the tailnet cannot be listed, so "no Tailscale" is not reported
 * as "no backends".
 */
export async function discoverTailnetBackends(
  dependencies: {
    readonly readStatusJson?: () => Promise<string>;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<readonly TailnetBackend[]> {
  const statusJson = await (dependencies.readStatusJson ?? readTailscaleStatusJson)();
  const backends = await Promise.all(
    parseTailscalePeerDnsNames(statusJson).map((dnsName) =>
      probeTailnetBackend(dnsName, dependencies.fetchImpl),
    ),
  );
  return backends.filter((backend) => backend !== null);
}

/** Saved-connection form of a discovered backend: direct wss on the default Tailscale Serve port. */
export function profileFromTailnetBackend(backend: TailnetBackend): ConnectionProfile {
  return {
    id: `tailnet:${backend.dnsName}`,
    label: backend.dnsName.split(".")[0] ?? backend.dnsName,
    transport: "direct",
    scheme: "wss",
    host: backend.dnsName,
    port: 443,
    tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
  };
}
