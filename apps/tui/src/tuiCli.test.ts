import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDirectAttachServerConnection,
  buildSshAttachServerConnection,
  describeDirectHost,
  directProfileFromTarget,
  directTargetFromProfile,
  parseDirectAttachCommand,
  parseSshAttachCommand,
  resolveLaunchProfile,
  sshTunnelInputFromProfile,
  startSshAttach,
} from "./tuiCli";
import { startSshTunnel } from "./sshTunnel";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function fakeTunnel(localPort: number, process = new FakeChildProcess()) {
  return { localPort, process: process as unknown as ChildProcess, stop: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TUI CLI", () => {
  it("starts SSH attach through the configured profile and tunnel", async () => {
    const tunnel = fakeTunnel(41001);
    const startTunnel = vi.fn(async () => tunnel);
    const profile = parseSshAttachCommand(["attach", "ssh", "termweave@production"])!;

    const attach = await startSshAttach(profile, {
      startTunnel,
    });

    expect(attach.profile).toMatchObject({
      transport: "ssh",
      host: "production",
      username: "termweave",
      sshAlias: "production",
      remotePort: 3773,
    });
    expect(startTunnel).toHaveBeenCalledWith({
      target: "termweave@production",
      remotePort: 3773,
    });
    expect(attach.localPort).toBe(tunnel.localPort);
    attach.stop();
  });

  it("reconnects an exited tunnel on the same local port", async () => {
    vi.useFakeTimers();
    const firstProcess = new FakeChildProcess();
    const firstTunnel = fakeTunnel(41002, firstProcess);
    const secondTunnel = fakeTunnel(41002);
    const startTunnel = vi
      .fn()
      .mockResolvedValueOnce(firstTunnel)
      .mockResolvedValueOnce(secondTunnel);
    const profile = parseSshAttachCommand(["attach", "ssh", "production"])!;

    const attach = await startSshAttach(profile, {
      startTunnel,
      reconnectDelayMs: 25,
    });

    firstProcess.exitCode = 255;
    firstProcess.emit("exit", 255, null);
    await vi.advanceTimersByTimeAsync(25);

    expect(startTunnel).toHaveBeenNthCalledWith(2, {
      target: "production",
      remotePort: 3773,
      localPort: 41002,
      signal: expect.any(AbortSignal),
    });
    attach.stop();
    expect(secondTunnel.stop).toHaveBeenCalledOnce();
  });

  it("cancels pending reconnect startup on stop", async () => {
    vi.useFakeTimers();
    const firstProcess = new FakeChildProcess();
    const stopPendingChild = vi.fn();
    const startTunnel = vi
      .fn()
      .mockResolvedValueOnce(fakeTunnel(41003, firstProcess))
      .mockImplementationOnce(
        (input: { readonly signal?: AbortSignal }) =>
          new Promise(() =>
            input.signal?.addEventListener("abort", stopPendingChild, { once: true }),
          ),
      );
    const profile = parseSshAttachCommand(["attach", "ssh", "production"])!;

    const attach = await startSshAttach(profile, {
      startTunnel,
      reconnectDelayMs: 25,
    });

    firstProcess.exitCode = 255;
    firstProcess.emit("exit", 255, null);
    await vi.advanceTimersByTimeAsync(25);
    attach.stop();

    expect(stopPendingChild).toHaveBeenCalledOnce();
  });

  it("cancels initial tunnel startup and stops its SSH child", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const profile = parseSshAttachCommand(["attach", "ssh", "production"])!;

    const startup = startSshAttach(profile, {
      signal: controller.signal,
      startTunnel: (input) =>
        startSshTunnel(input, {
          reservePort: async () => 41005,
          spawnImpl: () => {
            markSpawned?.();
            return child as unknown as ChildProcess;
          },
          confirmForward: () => new Promise<void>(() => {}),
        }),
    });

    await spawned;
    controller.abort(new Error("terminated during startup"));

    await expect(startup).rejects.toThrow("terminated during startup");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("detects an already-exited tunnel and cancels reconnect on stop", async () => {
    vi.useFakeTimers();
    const process = new FakeChildProcess();
    process.exitCode = 255;
    const tunnel = fakeTunnel(41003, process);
    const startTunnel = vi.fn(async () => tunnel);
    const profile = parseSshAttachCommand(["attach", "ssh", "production"])!;

    const attach = await startSshAttach(profile, {
      startTunnel,
      reconnectDelayMs: 25,
    });

    attach.stop();
    await vi.advanceTimersByTimeAsync(25);

    expect(startTunnel).toHaveBeenCalledOnce();
  });

  it("builds the shared App connection without persisting the SSH token", async () => {
    const token = "memory-only-token";
    const tunnel = fakeTunnel(41004);
    const startTunnel = vi.fn(async () => tunnel);
    const profile = parseSshAttachCommand(["attach", "ssh", "production"])!;

    const attach = await startSshAttach(profile, {
      startTunnel,
    });

    expect(buildSshAttachServerConnection(attach, token)).toEqual({
      host: "127.0.0.1",
      port: 41004,
      authToken: token,
      wsUrl: `ws://127.0.0.1:41004/?token=${token}`,
    });
    expect(JSON.stringify(attach.profile)).not.toContain(token);
    attach.stop();
  });

  it("preserves explicit profile SSH options", () => {
    expect(
      sshTunnelInputFromProfile({
        id: "production",
        label: "Production",
        transport: "ssh",
        host: "vps.example",
        sshAlias: "production",
        username: "termweave",
        port: 2222,
        remotePort: 4773,
        identityPath: "/keys/production",
      }),
    ).toEqual({
      target: "termweave@production",
      sshPort: 2222,
      remotePort: 4773,
      identityPath: "/keys/production",
    });
  });

  it("keeps local startup and rejects malformed attach commands", () => {
    expect(parseSshAttachCommand([])).toBeNull();
    expect(() => parseSshAttachCommand(["attach", "ssh", "@host"])).toThrow("Invalid SSH target");
    expect(() => parseSshAttachCommand(["attach", "ssh", "-oProxyCommand=evil@realhost"])).toThrow(
      "Invalid SSH target",
    );
    expect(() => parseSshAttachCommand(["attach", "ssh", "-V"])).toThrow("Invalid SSH target");
    // `attach direct ...` is not the SSH parser's concern; it returns null.
    expect(parseSshAttachCommand(["attach", "direct", "host"])).toBeNull();
  });

  describe("launch profile resolution", () => {
    const saved = {
      id: "prod",
      label: "Production",
      transport: "ssh" as const,
      host: "example.com",
      port: 22,
      remotePort: 3773,
    };
    const prefs = { connectionProfiles: [saved], defaultConnectionProfileId: "prod" };

    it("opens the default profile on a bare launch, and a local server without one", () => {
      expect(resolveLaunchProfile([], {})).toBeNull();
      expect(resolveLaunchProfile([], { connectionProfiles: [saved] })).toBeNull();
      expect(resolveLaunchProfile([], prefs)).toEqual(saved);
    });

    it("lets `local` skip the default profile", () => {
      expect(resolveLaunchProfile(["local"], prefs)).toBeNull();
    });

    it("resolves `attach <name>` against saved profiles", () => {
      expect(resolveLaunchProfile(["attach", "Production"], prefs)).toEqual(saved);
      expect(() => resolveLaunchProfile(["attach", "unknown"], prefs)).toThrow(
        'No saved connection named "unknown"',
      );
    });

    it("rejects unknown commands instead of silently starting a local server", () => {
      expect(() => resolveLaunchProfile(["attach", "diret", "host"], prefs)).toThrow("Usage");
      expect(() => resolveLaunchProfile(["attach"], prefs)).toThrow("Usage");
      expect(() => resolveLaunchProfile(["bogus"], prefs)).toThrow("Usage");
      expect(() => resolveLaunchProfile(["--help"], prefs)).toThrow("Usage");
    });

    it("records which env var holds the token for a direct attach", () => {
      const args = ["attach", "direct", "wss://box.ts.net:443"];
      expect(resolveLaunchProfile(args, {}, { T1CODE_AUTH_TOKEN: "token1" })).toMatchObject({
        transport: "direct",
        scheme: "wss",
        host: "box.ts.net",
        port: 443,
        tokenEnvVar: "T1CODE_AUTH_TOKEN",
      });
      expect(resolveLaunchProfile(args, {}, {})).toMatchObject({
        tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
      });
    });
  });

  describe("direct profile conversions", () => {
    it("round-trip: target -> profile -> target", () => {
      const target = parseDirectAttachCommand(["attach", "direct", "192.168.1.10:3773"])!;
      const profile = directProfileFromTarget(target, {});
      const reconstructed = directTargetFromProfile(profile);
      expect(reconstructed).toEqual(target);
    });
  });

  describe("direct attach", () => {
    it("parses host, port, scheme, and classifies the host", () => {
      expect(parseDirectAttachCommand([])).toBeNull();
      expect(parseDirectAttachCommand(["attach", "ssh", "user@host"])).toBeNull();

      expect(parseDirectAttachCommand(["attach", "direct", "100.101.102.103:4000"])).toMatchObject({
        scheme: "ws",
        host: "100.101.102.103",
        port: 4000,
        hostClass: "private", // Tailscale CGNAT range
        hostKind: "ip",
      });

      expect(parseDirectAttachCommand(["attach", "direct", "wss://vps.example.com"])).toMatchObject(
        {
          scheme: "wss",
          host: "vps.example.com",
          port: 443, // default WSS port
          hostClass: "public",
          hostKind: "name",
        },
      );

      expect(
        parseDirectAttachCommand(["attach", "direct", "wss://box.tail1234.ts.net:8443"]),
      ).toMatchObject({
        scheme: "wss",
        host: "box.tail1234.ts.net",
        port: 8443,
        hostClass: "public",
        hostKind: "name",
      });

      expect(parseDirectAttachCommand(["attach", "direct", "ws://192.168.1.50"])).toMatchObject({
        scheme: "ws",
        host: "192.168.1.50",
        port: 3773,
        hostClass: "private",
        hostKind: "ip",
      });

      expect(parseDirectAttachCommand(["attach", "direct", "[fd7a:1::2]:5000"])).toMatchObject({
        host: "fd7a:1::2",
        port: 5000,
        hostClass: "private", // fc00::/7 ULA (Tailscale)
      });

      expect(parseDirectAttachCommand(["attach", "direct", "127.0.0.1"])).toMatchObject({
        hostClass: "loopback",
      });
      expect(parseDirectAttachCommand(["attach", "direct", "8.8.8.8"])).toMatchObject({
        hostClass: "public",
        hostKind: "ip",
      });

      // Non-decimal / empty octets are not IPv4 literals: treated as public names,
      // never misclassified into a private/loopback range.
      for (const host of ["10e0.0.0.1", "0x0a.0.0.1", "10..0.1"]) {
        expect(parseDirectAttachCommand(["attach", "direct", `${host}:3773`])).toMatchObject({
          host,
          hostClass: "public",
          hostKind: "name",
        });
      }
    });

    it("classifies host ranges", () => {
      const cases: Array<[string, "loopback" | "private" | "public"]> = [
        ["127.0.0.1", "loopback"],
        ["10.1.2.3", "private"],
        ["172.16.0.1", "private"],
        ["172.31.255.255", "private"],
        ["172.15.0.1", "public"], // just outside 172.16/12
        ["172.32.0.1", "public"],
        ["192.168.1.1", "private"],
        ["169.254.1.1", "private"],
        ["100.64.0.1", "private"], // Tailscale CGNAT
        ["100.128.0.1", "public"], // just outside 100.64/10
        ["8.8.8.8", "public"],
        ["::1", "loopback"],
        ["fe80::1", "private"],
        ["fc00::1", "private"],
        ["fd7a:115c:a1e0::1", "private"], // Tailscale ULA
        ["2606:4700::1111", "public"],
      ];
      for (const [host, hostClass] of cases) {
        expect(describeDirectHost(host).hostClass, host).toBe(hostClass);
      }
    });

    it("rejects malformed direct targets", () => {
      expect(() => parseDirectAttachCommand(["attach", "direct"])).toThrow("attach direct");
      expect(() => parseDirectAttachCommand(["attach", "direct", "-x"])).toThrow("Invalid direct");
      for (const port of ["0", "99999", "1e3", "0x1000", "3773.0", "abc"]) {
        expect(() => parseDirectAttachCommand(["attach", "direct", `host:${port}`])).toThrow(
          "Invalid direct port",
        );
      }
      // Injection / smuggling attempts must not slip through as a different authority.
      for (const target of [
        "[::1]evil", // trailing garbage after bracketed host
        "127.0.0.1@8.8.8.8", // userinfo hiding a public host
        "ws://127.0.0.1@8.8.8.8",
        "host/path",
        "host?token=x",
        "host#frag",
        "host\\evil",
        "[fd-not-an-ip:thing]", // malformed IPv6 literal
      ]) {
        expect(() => parseDirectAttachCommand(["attach", "direct", target])).toThrow(
          "Invalid direct",
        );
      }
    });

    it("requires a token for every non-loopback bind, but not for loopback", () => {
      const loopback = parseDirectAttachCommand(["attach", "direct", "127.0.0.1:3773"])!;
      expect(buildDirectAttachServerConnection(loopback, null).wsUrl).toBe("ws://127.0.0.1:3773/");

      const priv = parseDirectAttachCommand(["attach", "direct", "192.168.1.10:3773"])!;
      expect(() => buildDirectAttachServerConnection(priv, null)).toThrow(
        "requires an application token",
      );
      expect(buildDirectAttachServerConnection(priv, "s3cret").wsUrl).toBe(
        "ws://192.168.1.10:3773/?token=s3cret",
      );
    });

    it("rejects plain ws:// to a public IP, but only warns for an unknown hostname", () => {
      const publicIp = parseDirectAttachCommand(["attach", "direct", "203.0.113.5:3773"])!;
      expect(() => buildDirectAttachServerConnection(publicIp, "tok")).toThrow(
        "Refusing plain ws://",
      );

      const publicName = parseDirectAttachCommand(["attach", "direct", "vps.example.com:3773"])!;
      const warnings: string[] = [];
      const conn = buildDirectAttachServerConnection(publicName, "tok", {
        warn: (message) => warnings.push(message),
      });
      expect(conn.wsUrl).toBe("ws://vps.example.com:3773/?token=tok");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("unencrypted");

      // wss:// to the same public host is accepted without a warning.
      const secure = parseDirectAttachCommand(["attach", "direct", "wss://203.0.113.5:3773"])!;
      const secureWarnings: string[] = [];
      const secureConn = buildDirectAttachServerConnection(secure, "tok", {
        warn: (message) => secureWarnings.push(message),
      });
      expect(secureConn.wsUrl).toBe("wss://203.0.113.5:3773/?token=tok");
      expect(secureWarnings).toHaveLength(0);
    });
  });
});
