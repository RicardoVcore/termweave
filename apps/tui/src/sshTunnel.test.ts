import { describe, expect, it } from "vitest";

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
      }),
    ).toEqual([
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-p",
      "2222",
      "-L",
      "127.0.0.1:41001:127.0.0.1:3773",
      "-i",
      "~/.ssh/id_ed25519",
      "termweave@vps.example",
    ]);
  });

  it("starts after local readiness and stops cleanly", async () => {
    const child = { killed: false, kill: noopKill } as never;
    let spawned: { command: string; args: string[] } | undefined;
    const tunnel = await startSshTunnel(
      { target: "vps", remotePort: 3773 },
      {
        reservePort: async () => 41002,
        spawnImpl: (command, args) => {
          spawned = { command, args };
          return child;
        },
        waitUntilReady: async () => undefined,
      },
    );

    expect(tunnel.localPort).toBe(41002);
    expect(spawned).toEqual({
      command: "ssh",
      args: [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-p",
        "22",
        "-L",
        "127.0.0.1:41002:127.0.0.1:3773",
        "vps",
      ],
    });
    tunnel.stop();
  });
});
