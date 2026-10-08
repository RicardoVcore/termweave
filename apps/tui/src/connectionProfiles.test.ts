import { describe, expect, it } from "vitest";

import {
  decodeConnectionProfile,
  describeConnectionProfile,
  findConnectionProfile,
  normalizeConnectionProfiles,
  removeConnectionProfile,
  upsertConnectionProfile,
  type ConnectionProfile,
} from "./connectionProfiles";

describe("connection profiles", () => {
  it("keeps explicit transport and SSH metadata", () => {
    expect(
      decodeConnectionProfile({
        id: "vps",
        label: "Production VPS",
        transport: "ssh",
        host: "vps.example",
        port: 22,
        username: "termweave",
        sshAlias: "production",
        identityPath: "~/.ssh/id_ed25519",
        remotePort: 3773,
      }),
    ).toEqual({
      id: "vps",
      label: "Production VPS",
      transport: "ssh",
      host: "vps.example",
      port: 22,
      username: "termweave",
      sshAlias: "production",
      identityPath: "~/.ssh/id_ed25519",
      remotePort: 3773,
    });
  });

  it("keeps only safe direct profiles with token references", () => {
    expect(
      normalizeConnectionProfiles([
        {
          id: "direct",
          label: "Tailnet",
          transport: "direct",
          host: "100.64.0.10",
          port: 3773,
          scheme: "wss",
          tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
          authToken: "must-not-persist",
        },
        { id: "invalid", label: "Missing transport", host: "localhost", port: 3773 },
      ]),
    ).toEqual([
      {
        id: "direct",
        label: "Tailnet",
        transport: "direct",
        host: "100.64.0.10",
        port: 3773,
        scheme: "wss",
        tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
      },
    ]);
  });

  it("defaults the direct scheme to ws and drops the removed local transport", () => {
    const direct = {
      id: "tailnet",
      label: "Tailnet",
      transport: "direct",
      host: "box.ts.net",
      port: 443,
      tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
    };
    expect(decodeConnectionProfile(direct)).toMatchObject({ scheme: "ws" });
    expect(decodeConnectionProfile({ ...direct, scheme: "wss" })).toMatchObject({ scheme: "wss" });
    expect(decodeConnectionProfile({ ...direct, transport: "local" })).toBeUndefined();
  });

  describe("saved profile list", () => {
    const ssh: ConnectionProfile = {
      id: "cli:ssh:dev@vps",
      label: "dev@vps",
      transport: "ssh",
      host: "vps",
      port: 22,
      remotePort: 3773,
      username: "dev",
      sshAlias: "vps",
    };
    const direct: ConnectionProfile = {
      id: "cli:direct:wss://box.ts.net:443",
      label: "box.ts.net",
      transport: "direct",
      scheme: "wss",
      host: "box.ts.net",
      port: 443,
      tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
    };

    it("finds a profile by label or id", () => {
      expect(findConnectionProfile([ssh, direct], " box.ts.net ")).toBe(direct);
      expect(findConnectionProfile([ssh, direct], "cli:ssh:dev@vps")).toBe(ssh);
      expect(findConnectionProfile([ssh], "missing")).toBeUndefined();
    });

    it("upserts in place and appends new profiles", () => {
      const renamed = { ...ssh, label: "work" };
      expect(upsertConnectionProfile([ssh, direct], renamed)).toEqual([renamed, direct]);
      expect(upsertConnectionProfile([ssh], direct)).toEqual([ssh, direct]);
    });

    it("removes a profile by id", () => {
      expect(removeConnectionProfile([ssh, direct], ssh.id)).toEqual([direct]);
    });

    it("describes profiles on one line", () => {
      expect(describeConnectionProfile(ssh)).toBe("ssh dev@vps");
      expect(describeConnectionProfile(direct)).toBe("direct wss://box.ts.net:443");
      expect(describeConnectionProfile({ ...direct, scheme: "ws", host: "fd7a:1::2" })).toBe(
        "direct ws://[fd7a:1::2]:443",
      );
    });
  });
});
