import { describe, expect, it } from "vitest";

import { parseClaudeCatalogFile } from "./ClaudeModelCatalogCache.ts";

const catalog = (models: unknown, surface = "cc", fetchedAt = 1) =>
  JSON.stringify({ fetchedAt, catalog: { surface, config: { models } } });

describe("parseClaudeCatalogFile", () => {
  it("maps cc-surface models and drops hidden ones", () => {
    const parsed = parseClaudeCatalogFile(
      catalog([
        { id: "claude-opus-5", name: "Opus 5", thinking: { type: "effort" }, fast_mode: {} },
        { id: "claude-haiku-4-5", name: "Haiku 4.5", thinking: { type: "none" } },
        { id: "claude-internal", name: "Internal", hidden: true },
      ]),
    );

    expect(parsed?.fetchedAt).toBe(1);
    expect(parsed?.models).toEqual([
      { slug: "claude-opus-5", name: "Opus 5", thinkingType: "effort", fastMode: true },
      { slug: "claude-haiku-4-5", name: "Haiku 4.5", thinkingType: "none", fastMode: false },
    ]);
  });

  it("ignores non-cc surfaces and malformed payloads", () => {
    expect(parseClaudeCatalogFile(catalog([{ id: "x" }], "api"))).toBeNull();
    expect(parseClaudeCatalogFile("null")).toBeNull();
    expect(parseClaudeCatalogFile("{}")).toBeNull();
  });
});
