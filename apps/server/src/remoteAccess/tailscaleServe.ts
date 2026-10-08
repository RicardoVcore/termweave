// Wraps the tailscale CLI to expose a loopback-bound server to the tailnet
// over HTTPS via Tailscale Serve.

import { Effect } from "effect";
import { runProcess } from "../processRunner";

/** Local address Tailscale Serve is pointed at; the server must listen on it. */
export const TAILSCALE_SERVE_LOCAL_HOST = "127.0.0.1";

export async function ensureTailscaleServe(input: {
  readonly localPort: number;
  readonly servePort: number;
}): Promise<void> {
  await runProcess(
    "tailscale",
    [
      "serve",
      "--bg",
      `--https=${input.servePort}`,
      `http://${TAILSCALE_SERVE_LOCAL_HOST}:${input.localPort}`,
    ],
    {
      timeoutMs: 15_000,
    },
  );
}

export async function disableTailscaleServe(servePort: number): Promise<void> {
  await runProcess("tailscale", ["serve", `--https=${servePort}`, "off"], {
    timeoutMs: 15_000,
  });
}

export function parseTailscaleMagicDnsName(rawStatusJson: string): string | null {
  try {
    const parsed = JSON.parse(rawStatusJson);
    const dnsName = parsed.Self?.DNSName;
    if (typeof dnsName !== "string") {
      return null;
    }
    const trimmed = dnsName.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  } catch {
    return null;
  }
}

export async function readTailscaleMagicDnsName(): Promise<string | null> {
  const result = await runProcess("tailscale", ["status", "--json"], {
    timeoutMs: 5_000,
  });
  return parseTailscaleMagicDnsName(result.stdout);
}

export function buildTailscaleServeBaseUrl(magicDnsName: string, servePort: number): string {
  if (servePort === 443) {
    return `https://${magicDnsName}/`;
  }
  return `https://${magicDnsName}:${servePort}/`;
}

/**
 * Exposes the loopback server through Tailscale Serve for the lifetime of the
 * scope and returns the tailnet base URL (null when the MagicDNS name is
 * unavailable). Fails when `tailscale serve` cannot be configured.
 */
export const acquireTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort: number;
}) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.tryPromise(() => ensureTailscaleServe(input)),
      () =>
        Effect.tryPromise(() => disableTailscaleServe(input.servePort)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to disable Tailscale Serve", { cause }),
          ),
        ),
    );
    const magicDnsName = yield* Effect.tryPromise(() => readTailscaleMagicDnsName()).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to read Tailscale MagicDNS name", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
    if (magicDnsName === null) {
      yield* Effect.logWarning("Tailscale Serve configured, but no MagicDNS name is available");
      return null;
    }
    const baseUrl = buildTailscaleServeBaseUrl(magicDnsName, input.servePort);
    yield* Effect.logInfo("Tailscale Serve configured", { baseUrl, localPort: input.localPort });
    return baseUrl;
  });
