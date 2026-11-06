import { ProviderDriverKind, type ModelCapabilities } from "@termweave/contracts";
import { createModelCapabilities } from "@termweave/shared/model";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { parseGenericCliVersion, providerModelsFromSettings } from "./providerSnapshot.ts";

const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      decodeProviderDriverKind("opencode"),
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.2.5")).toBe("2.2.5");
  });

  it("parses a plain version", () => {
    expect(parseGenericCliVersion("1.14.19")).toBe("1.14.19");
  });

  it("returns null when no version is present", () => {
    expect(parseGenericCliVersion("no version")).toBeNull();
  });
});
