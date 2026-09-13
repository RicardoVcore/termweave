import { describe, expect, it } from "vitest";

import { buildCoreAdvertisedEndpoints, resolveAdvertisedHost } from "./AdvertisedEndpoints";

describe("AdvertisedEndpoints", () => {
  it("advertises wildcard listeners through loopback", () => {
    expect(resolveAdvertisedHost(undefined)).toEqual({
      host: "127.0.0.1",
      reachability: "loopback",
    });
    expect(resolveAdvertisedHost("0.0.0.0")).toEqual({
      host: "127.0.0.1",
      reachability: "loopback",
    });
  });

  it("builds the core local backend endpoint", () => {
    expect(buildCoreAdvertisedEndpoints({ host: "127.0.0.1", port: 3773 })).toEqual([
      {
        id: "local-backend",
        label: "Local backend",
        provider: {
          id: "termweave-core",
          label: "Termweave",
          kind: "core",
          isAddon: false,
        },
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        reachability: "loopback",
        source: "server",
        status: "available",
        isDefault: true,
        description:
          "Current Termweave backend endpoint for local browsers and attachable TUI sessions.",
      },
    ]);
  });
});
