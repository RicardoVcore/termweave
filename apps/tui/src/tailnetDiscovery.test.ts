import { describe, expect, it, vi } from "vitest";

import {
  discoverTailnetBackends,
  parseTailscalePeerDnsNames,
  probeTailnetBackend,
  profileFromTailnetBackend,
} from "./tailnetDiscovery";

function statusJson(peers: Record<string, { DNSName: string; Online: boolean }>): string {
  return JSON.stringify({ Peer: peers });
}

function fetchRespondingWith(descriptor: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => descriptor,
  })) as unknown as typeof fetch;
}

const descriptor = {
  environmentId: "env-1",
  label: "Workstation",
  platform: { os: "linux", arch: "arm64" },
  serverVersion: "0.1.0",
  capabilities: { repositoryIdentity: false },
};

describe("parseTailscalePeerDnsNames", () => {
  it("keeps online peers, drops offline ones, and strips the trailing dot", () => {
    expect(
      parseTailscalePeerDnsNames(
        statusJson({
          a: { DNSName: "box.tail1234.ts.net.", Online: true },
          b: { DNSName: "offline.tail1234.ts.net.", Online: false },
        }),
      ),
    ).toEqual(["box.tail1234.ts.net"]);
  });

  it("sorts and de-duplicates peers", () => {
    expect(
      parseTailscalePeerDnsNames(
        statusJson({
          b: { DNSName: "zeta.ts.net.", Online: true },
          a: { DNSName: "alpha.ts.net.", Online: true },
          dup: { DNSName: "zeta.ts.net.", Online: true },
        }),
      ),
    ).toEqual(["alpha.ts.net", "zeta.ts.net"]);
  });

  it("returns an empty list for invalid JSON", () => {
    expect(parseTailscalePeerDnsNames("not json")).toEqual([]);
  });

  it("returns an empty list when Peer is missing", () => {
    expect(parseTailscalePeerDnsNames(JSON.stringify({ Version: "1.80" }))).toEqual([]);
  });
});

describe("probeTailnetBackend", () => {
  it("returns a backend for a valid descriptor", async () => {
    await expect(
      probeTailnetBackend("box.ts.net", fetchRespondingWith(descriptor)),
    ).resolves.toEqual({
      dnsName: "box.ts.net",
      label: "Workstation",
    });
  });

  it("returns null for a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      json: async () => descriptor,
    })) as unknown as typeof fetch;
    await expect(probeTailnetBackend("box.ts.net", fetchImpl)).resolves.toBeNull();
  });

  it("returns null when environmentId is missing", async () => {
    const fetchImpl = fetchRespondingWith({ ...descriptor, environmentId: undefined });
    await expect(probeTailnetBackend("box.ts.net", fetchImpl)).resolves.toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(probeTailnetBackend("box.ts.net", fetchImpl)).resolves.toBeNull();
  });
});

describe("discoverTailnetBackends", () => {
  it("probes every online peer and keeps only valid backends", async () => {
    const fetchImpl = vi.fn((input: unknown) =>
      String(input).includes("alpha.ts.net")
        ? Promise.resolve({ ok: true, json: async () => descriptor })
        : Promise.resolve({ ok: false, json: async () => ({}) }),
    ) as unknown as typeof fetch;
    const readStatusJson = () =>
      Promise.resolve(
        statusJson({
          a: { DNSName: "alpha.ts.net.", Online: true },
          b: { DNSName: "beta.ts.net.", Online: true },
        }),
      );

    await expect(discoverTailnetBackends({ readStatusJson, fetchImpl })).resolves.toEqual([
      { dnsName: "alpha.ts.net", label: "Workstation" },
    ]);
  });

  it("rejects when the tailnet cannot be listed", async () => {
    await expect(
      discoverTailnetBackends({
        readStatusJson: () => Promise.reject(new Error("Tailscale CLI not found.")),
      }),
    ).rejects.toThrow("Tailscale CLI not found.");
  });
});

describe("profileFromTailnetBackend", () => {
  it("builds a direct wss profile with the first DNS label", () => {
    expect(
      profileFromTailnetBackend({ dnsName: "box.tail1234.ts.net", label: "Workstation" }),
    ).toEqual({
      id: "tailnet:box.tail1234.ts.net",
      label: "box",
      transport: "direct",
      scheme: "wss",
      host: "box.tail1234.ts.net",
      port: 443,
      tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
    });
  });
});
