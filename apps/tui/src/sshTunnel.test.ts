import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { buildSshTunnelArgs, startSshTunnel } from "./sshTunnel";

const noopKill = () => undefined;

describe("SSH tunnel", () => {
  it("builds argv without shell interpolation", () => {
    expect(
      buildSshTunnelArgs({
        target: "termweave@vps.example",
        sshPort: 2222,
        localPort: 41001,
        remotePort: 3773,
        identityPath: "~/.ssh/id_ed25519",
        controlPath: "/tmp/termweave-control",
      }),
    ).toEqual([
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ForkAfterAuthentication=no",
      "-o",
      "ControlPersist=no",
      "-M",
      "-S",
      "/tmp/termweave-control",
      "-L",
      "127.0.0.1:41001:127.0.0.1:3773",
      "-p",
      "2222",
      "-i",
      "~/.ssh/id_ed25519",
      "termweave@vps.example",
    ]);
  });

  it("starts after local readiness and stops cleanly", async () => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: noopKill,
    });
    let spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const tunnel = await startSshTunnel(
      { target: "vps", remotePort: 3773 },
      {
        reservePort: async () => 41002,
        spawnImpl: (command, args, options) => {
          spawned = { command, args, env: options.env };
          return child as never;
        },
        confirmForward: async () => undefined,
        waitUntilReady: async () => undefined,
      },
    );

    expect(tunnel.localPort).toBe(41002);
    // Prompts stay on the terminal; no askpass helper is ever spawned.
    expect(spawned?.env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect(spawned).toMatchObject({
      command: "ssh",
      args: [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ForkAfterAuthentication=no",
        "-o",
        "ControlPersist=no",
        "-M",
        "-S",
        expect.any(String),
        "-L",
        "127.0.0.1:41002:127.0.0.1:3773",
        "vps",
      ],
    });
    tunnel.stop();
  });

  it("rejects when SSH cannot start", async () => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: noopKill,
    });

    await expect(
      startSshTunnel(
        { target: "vps", remotePort: 3773 },
        {
          reservePort: async () => 41003,
          spawnImpl: () => {
            queueMicrotask(() => child.emit("error", new Error("ssh unavailable")));
            return child as never;
          },
          confirmForward: async () => undefined,
        },
      ),
    ).rejects.toThrow("ssh unavailable");
  });

  it("rejects when SSH exits by signal before readiness", async () => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: noopKill,
    });

    await expect(
      startSshTunnel(
        { target: "vps", remotePort: 3773 },
        {
          reservePort: async () => 41004,
          spawnImpl: () => {
            queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
            return child as never;
          },
          confirmForward: async () => undefined,
        },
      ),
    ).rejects.toThrow("SSH tunnel exited before becoming ready (SIGTERM).");
  });
});
