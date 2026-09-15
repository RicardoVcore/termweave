import { describe, expect, it } from "vitest";

import { parseCodexModelsCache } from "./CodexModelsCache.ts";

describe("parseCodexModelsCache", () => {
  it("maps listed models and drops hidden ones", () => {
    const raw = JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          default_reasoning_level: "low",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "high" },
            { effort: "ultra" }, // unknown effort, must be dropped
          ],
          additional_speed_tiers: ["fast"],
        },
        { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
      ],
    });

    const models = parseCodexModelsCache(raw);

    expect(models.map((m) => m.slug)).toEqual(["gpt-5.6-sol"]);
    const model = models[0]!;
    expect(model.name).toBe("GPT-5.6-Sol");
    expect(model.isCustom).toBe(false);
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const reasoning = descriptors.find((o) => o.id === "reasoningEffort");
    expect(reasoning?.type).toBe("select");
    // unknown "ultra" filtered out, only low/high remain
    expect(reasoning && "options" in reasoning ? reasoning.options.map((o) => o.id) : []).toEqual([
      "low",
      "high",
    ]);
    expect(descriptors.some((o) => o.id === "fastMode")).toBe(true);
  });

  it("returns empty on malformed payloads", () => {
    expect(parseCodexModelsCache("null")).toEqual([]);
    expect(parseCodexModelsCache("{}")).toEqual([]);
  });
});
