import { describe, expect, it } from "vitest";

import { buildTailscaleServeBaseUrl, parseTailscaleMagicDnsName } from "./tailscaleServe";

describe("tailscaleServe", () => {
  describe("parseTailscaleMagicDnsName", () => {
    it("strips trailing dot from DNS name", () => {
      expect(parseTailscaleMagicDnsName('{"Self":{"DNSName":"box.tail1234.ts.net."}}')).toBe(
        "box.tail1234.ts.net",
      );
    });

    it("returns DNS name without trailing dot as-is", () => {
      expect(parseTailscaleMagicDnsName('{"Self":{"DNSName":"box.tail1234.ts.net"}}')).toBe(
        "box.tail1234.ts.net",
      );
    });

    it("returns null for empty object", () => {
      expect(parseTailscaleMagicDnsName("{}")).toBeNull();
    });

    it("returns null for empty DNSName", () => {
      expect(parseTailscaleMagicDnsName('{"Self":{"DNSName":""}}')).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseTailscaleMagicDnsName("invalid json")).toBeNull();
    });

    it("returns null when DNSName is not a string", () => {
      expect(parseTailscaleMagicDnsName('{"Self":{"DNSName":123}}')).toBeNull();
    });
  });

  describe("buildTailscaleServeBaseUrl", () => {
    it("returns URL without port for port 443", () => {
      expect(buildTailscaleServeBaseUrl("box.tail1234.ts.net", 443)).toBe(
        "https://box.tail1234.ts.net/",
      );
    });

    it("returns URL with port for non-443 port", () => {
      expect(buildTailscaleServeBaseUrl("box.tail1234.ts.net", 8443)).toBe(
        "https://box.tail1234.ts.net:8443/",
      );
    });
  });
});
