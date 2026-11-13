import { describe, expect, it } from "vitest";

import { type PiModel } from "../pi/piRpcProtocol.ts";
import { flattenPiModels, piThinkingCapabilities } from "./PiProvider.ts";

const SAMPLE_MODELS: ReadonlyArray<PiModel> = [
  {
    id: "z-ai-glm-5-3-flash",
    name: "GLM 5.3 Flash",
    provider: "venice-ai",
    reasoning: true,
    contextWindow: 200000,
    type: "chat",
  },
  {
    // Model ids can contain `/` (OpenRouter-style); the slug must keep them.
    id: "anthropic/claude-sonnet-4",
    provider: "openrouter",
    reasoning: false,
    type: "chat",
  },
  {
    id: "text-embedding-3",
    name: "Text Embedding 3",
    provider: "venice-ai",
    type: "embedding",
  },
  {
    id: "no-type-model",
    name: "No Type Model",
    provider: "venice-ai",
  },
];

describe("flattenPiModels", () => {
  it("maps Pi models to server provider models sorted by name", () => {
    const models = flattenPiModels(SAMPLE_MODELS);

    expect(models.map((model) => model.slug)).toEqual([
      "openrouter/anthropic/claude-sonnet-4",
      "venice-ai/z-ai-glm-5-3-flash",
      "venice-ai/no-type-model",
    ]);
    expect(models.map((model) => model.name)).toEqual([
      "anthropic/claude-sonnet-4",
      "GLM 5.3 Flash",
      "No Type Model",
    ]);
    for (const model of models) {
      expect(model.subProvider).toBe(model.slug.split("/")[0]);
      expect(model.isCustom).toBe(false);
    }
  });

  it("falls back to the model id when Pi reports no name", () => {
    const models = flattenPiModels([{ id: "bare-id", provider: "venice-ai" }]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("bare-id");
  });
});

describe("piThinkingCapabilities", () => {
  it("offers the thinking ladder with medium as default for reasoning models", () => {
    const capabilities = piThinkingCapabilities(SAMPLE_MODELS[0]!);
    const descriptor = capabilities.optionDescriptors?.find(
      (candidate) => candidate.id === "thinking",
    );
    if (!descriptor || descriptor.type !== "select") {
      throw new Error("Expected a thinking select descriptor");
    }

    expect(descriptor.label).toBe("Thinking");
    expect(descriptor.options.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(descriptor.options.find((option) => option.id === "medium")?.isDefault).toBe(true);
  });

  it("offers no descriptors for non-reasoning models", () => {
    expect(piThinkingCapabilities(SAMPLE_MODELS[1]!).optionDescriptors ?? []).toHaveLength(0);
    expect(piThinkingCapabilities({ id: "m", provider: "p" }).optionDescriptors ?? []).toHaveLength(
      0,
    );
  });
});
