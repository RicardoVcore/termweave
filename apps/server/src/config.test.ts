import { describe, expect, it } from "vitest";

import { isLoopbackHost, requiresAuthForHost } from "./config.ts";

describe("server bind security", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "127.42.0.9",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
  ]) (
    "accepts %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
      expect(requiresAuthForHost(host)).toBe(false);
    },
  );

  it.each([undefined, "0.0.0.0", "::", "100.64.0.10", "example.internal"]) (
    "requires auth for %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
      expect(requiresAuthForHost(host)).toBe(true);
    },
  );
});
