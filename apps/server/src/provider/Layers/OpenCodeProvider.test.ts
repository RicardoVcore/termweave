import { describe, expect, it } from "vitest";

import type { AgentInfo, ModelInfo } from "@opencode/client";

import { flattenOpenCodeModels } from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";

interface ModelCapabilityOptionDescriptor {
  readonly id: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label?: string;
    readonly isDefault?: boolean;
  }>;
  readonly currentValue?: string;
}

function makeModelInfo(overrides: Partial<ModelInfo> & Pick<ModelInfo, "providerID" | "id">) {
  const { providerID, id, ...rest } = overrides;
  return {
    modelID: id,
    name: id,
    type: "chat",
    enabled: true,
    status: "active",
    capabilities: {},
    variants: [],
    time: { released: 0 },
    cost: [],
    limit: { context: 0, output: 0 },
    providerID,
    id,
    ...rest,
  } as ModelInfo;
}

function makeAgentInfo(overrides: Partial<AgentInfo> & Pick<AgentInfo, "id">) {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name: name ?? id.charAt(0).toUpperCase() + id.slice(1),
    mode: "primary",
    hidden: false,
    request: {},
    permissions: [],
    ...rest,
  } as AgentInfo;
}

function optionDescriptorsFor(
  model: ReturnType<typeof flattenOpenCodeModels>[number],
): ReadonlyArray<ModelCapabilityOptionDescriptor> {
  return (model.capabilities?.optionDescriptors ??
    []) as ReadonlyArray<ModelCapabilityOptionDescriptor>;
}

describe("flattenOpenCodeModels", () => {
  it("flattens 2.x /api/model entries into provider models with variant and agent options", () => {
    const inventory: OpenCodeInventory = {
      models: [
        makeModelInfo({
          providerID: "openrouter",
          id: "google/gemini-4-hydrogen",
          name: "Gemini 4 Hydrogen",
          variants: [{ id: "high" }, { id: "low" }],
        }),
      ],
      agents: [
        makeAgentInfo({ id: "plan" }),
        makeAgentInfo({ id: "build" }),
        makeAgentInfo({ id: "helper", mode: "subagent" }),
        makeAgentInfo({ id: "ghost", hidden: true }),
      ],
    };

    const models = flattenOpenCodeModels(inventory);

    expect(models).toHaveLength(1);
    const model = models[0];
    if (!model) {
      throw new Error("expected one flattened model");
    }
    expect(model.slug).toBe("openrouter/google/gemini-4-hydrogen");
    expect(model.name).toBe("Gemini 4 Hydrogen");
    expect(model.isCustom).toBe(false);

    const options = optionDescriptorsFor(model);
    const variantOption = options.find((descriptor) => descriptor.id === "variant");
    const agentOption = options.find((descriptor) => descriptor.id === "agent");
    expect(variantOption?.options.map((option) => option.id)).toEqual(["high", "low"]);
    // Only visible primary agents become options, keyed by the runtime agent
    // id (`build`), with `name` as the display label.
    expect(agentOption?.options.map((option) => option.id)).toEqual(["plan", "build"]);
    expect(agentOption?.options.find((option) => option.id === "build")?.isDefault).toBe(true);
    expect(agentOption?.options.find((option) => option.id === "build")?.label).toBe("Build");
  });

  it("skips non-chat and disabled models", () => {
    const inventory: OpenCodeInventory = {
      models: [
        makeModelInfo({ providerID: "openai", id: "gpt-6" }),
        makeModelInfo({ providerID: "openai", id: "gpt-6-image", type: "image" }),
        makeModelInfo({ providerID: "openai", id: "gpt-6-off", enabled: false }),
      ],
      agents: [],
    };

    expect(flattenOpenCodeModels(inventory).map((model) => model.slug)).toEqual(["openai/gpt-6"]);
  });
});
