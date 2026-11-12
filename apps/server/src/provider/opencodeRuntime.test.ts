import { describe, expect, it } from "vitest";

import { parseOpenCodeModelSlug, parseServerUrlFromOutput } from "./opencodeRuntime.ts";

describe("parseServerUrlFromOutput", () => {
  it("parses the OpenCode 2.x ready line", () => {
    expect(parseServerUrlFromOutput("server listening on http://127.0.0.1:4096\n")).toBe(
      "http://127.0.0.1:4096",
    );
  });

  it("parses the ready line when preceded by other startup output", () => {
    const output = [
      "|  opencode v2.2.7",
      "ready=123ms",
      "server listening on http://127.0.0.1:52341",
    ].join("\n");
    expect(parseServerUrlFromOutput(output)).toBe("http://127.0.0.1:52341");
  });

  it("returns null for the 1.x ready line and unrelated output", () => {
    expect(parseServerUrlFromOutput("opencode server listening on http://127.0.0.1:4096\n")).toBe(
      null,
    );
    expect(parseServerUrlFromOutput("some other output\n")).toBe(null);
    expect(parseServerUrlFromOutput("")).toBe(null);
  });
});

describe("parseOpenCodeModelSlug", () => {
  it("splits on the first slash so model ids containing slashes survive", () => {
    expect(parseOpenCodeModelSlug("openrouter/google/gemini-4-hydrogen")).toEqual({
      providerID: "openrouter",
      modelID: "google/gemini-4-hydrogen",
    });
  });

  it("rejects slugs without a provider segment", () => {
    expect(parseOpenCodeModelSlug("just-a-model")).toBe(null);
    expect(parseOpenCodeModelSlug("/leading")).toBe(null);
    expect(parseOpenCodeModelSlug("trailing/")).toBe(null);
    expect(parseOpenCodeModelSlug(undefined)).toBe(null);
  });
});
