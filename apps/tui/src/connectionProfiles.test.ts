import { describe, expect, it } from "vitest";

import { decodeConnectionProfile, normalizeConnectionProfiles } from "./connectionProfiles";

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
        tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
      },
    ]);
  });
});
