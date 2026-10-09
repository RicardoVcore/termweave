import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  loadCodexModelsFromCache,
  parseCodexModelsCache,
  resolveCodexHomePath,
} from "./CodexModelsCache.ts";

describe("parseCodexModelsCache", () => {
  it("resolves default homes using platform-specific environment precedence", () => {
    expect(
      resolveCodexHomePath(
        undefined,
        { HOME: "/c/Users/Maria", USERPROFILE: "C:\\Users\\Maria" },
        "win32",
      ),
    ).toBe("C:\\Users\\Maria\\.codex");
    expect(
      resolveCodexHomePath(undefined, { HOME: "/Users/maria", USERPROFILE: "ignored" }, "darwin"),
    ).toBe("/Users/maria/.codex");
    expect(
      resolveCodexHomePath("~/.codex-work", { USERPROFILE: "C:\\Users\\Maria" }, "win32"),
    ).toBe("C:\\Users\\Maria\\.codex-work");
  });

  it("maps listed models and preserves hidden ones as legacy", () => {
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

    expect(models.map((m) => m.slug)).toEqual(["gpt-5.6-sol", "gpt-reserve"]);
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
    expect(models[1]?.isLegacy).toBe(true);
  });

  it("returns empty on malformed payloads", () => {
    expect(parseCodexModelsCache("null")).toEqual([]);
    expect(parseCodexModelsCache("{}")).toEqual([]);
  });

  it("skips malformed entries without discarding valid ones", () => {
    const raw = JSON.stringify({
      models: [null, 42, "nope", { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" }],
    });
    expect(parseCodexModelsCache(raw).map((m) => m.slug)).toEqual(["gpt-5.6-sol"]);
  });

  it("respects CODEX_HOME when no settings override is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-home-"));
    try {
      const codexHome = path.join(root, "custom-codex-home");
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        path.join(codexHome, "models_cache.json"),
        JSON.stringify({ models: [{ slug: "gpt-from-custom-home" }] }),
        "utf8",
      );

      const models = await Effect.runPromise(
        loadCodexModelsFromCache(undefined, { CODEX_HOME: codexHome }),
      );
      expect(models.map((model) => model.slug)).toEqual(["gpt-from-custom-home"]);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
