import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDirectAttachServerConnection,
  buildSshAttachServerConnection,
  parseDirectAttachCommand,
  parseSshAttachCommand,
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

    const attach = await startSshAttach(["attach", "ssh", "termweave@production"], {
      startTunnel,
    });

    expect(attach?.profile).toMatchObject({
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
    expect(attach?.localPort).toBe(tunnel.localPort);
    attach?.stop();
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
    const attach = await startSshAttach(["attach", "ssh", "production"], {
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
    attach?.stop();
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
    const attach = await startSshAttach(["attach", "ssh", "production"], {
      startTunnel,
      reconnectDelayMs: 25,
    });

    firstProcess.exitCode = 255;
    firstProcess.emit("exit", 255, null);
    await vi.advanceTimersByTimeAsync(25);
    attach?.stop();

    expect(stopPendingChild).toHaveBeenCalledOnce();
  });

  it("cancels initial tunnel startup and stops its SSH child", async () => {
    const controller = new AbortController();
    const child = new FakeChildProcess();
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const startup = startSshAttach(["attach", "ssh", "production"], {
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
    const attach = await startSshAttach(["attach", "ssh", "production"], {
      startTunnel,
      reconnectDelayMs: 25,
    });

    attach?.stop();
    await vi.advanceTimersByTimeAsync(25);

    expect(startTunnel).toHaveBeenCalledOnce();
  });

  it("builds the shared App connection without persisting the SSH token", async () => {
    const token = "memory-only-token";
    const attach = await startSshAttach(["attach", "ssh", "production"], {
      startTunnel: async () => fakeTunnel(41004),
    });

    expect(buildSshAttachServerConnection(attach!, token)).toEqual({
      host: "127.0.0.1",
      port: 41004,
      authToken: token,
      wsUrl: `ws://127.0.0.1:41004/?token=${token}`,
    });
    expect(JSON.stringify(attach?.profile)).not.toContain(token);
    attach?.stop();
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
          port: 3773, // default remote port
          hostClass: "public",
          hostKind: "name",
        },
      );

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
    });

    it("rejects malformed direct targets", () => {
      expect(() => parseDirectAttachCommand(["attach", "direct"])).toThrow("attach direct");
      expect(() => parseDirectAttachCommand(["attach", "direct", "-x"])).toThrow("Invalid direct");
      expect(() => parseDirectAttachCommand(["attach", "direct", "host:0"])).toThrow(
        "Invalid direct port",
      );
      expect(() => parseDirectAttachCommand(["attach", "direct", "host:99999"])).toThrow(
        "Invalid direct port",
      );
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
