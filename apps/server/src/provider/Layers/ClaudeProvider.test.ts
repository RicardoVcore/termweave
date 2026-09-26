import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ModelSelection, ProviderInstanceId } from "@termweave/contracts";
import { Effect, Schema } from "effect";

import {
  getClaudeModelCapabilities,
  makePendingClaudeProvider,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
  resolveClaudeHomeDir,
  resolveClaudeProviderModels,
} from "./ClaudeProvider";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

describe("ClaudeProvider", () => {
  it("resolves the CLI home from cross-platform environment variables", () => {
    const settings = decodeClaudeSettings({ homePath: "" });
    assert.equal(resolveClaudeHomeDir(settings, { HOME: "/Users/maria" }), "/Users/maria");
    assert.equal(
      resolveClaudeHomeDir(
        settings,
        { HOME: "/c/Users/Maria", USERPROFILE: "C:\\Users\\Maria" },
        "win32",
      ),
      "C:\\Users\\Maria",
    );
    assert.equal(
      resolveClaudeHomeDir(
        decodeClaudeSettings({ homePath: "~/.claude-work" }),
        { USERPROFILE: "C:\\Users\\Maria" },
        "win32",
      ),
      "C:\\Users\\Maria\\.claude-work",
    );
  });

  it("preserves the SDK identifier for a versioned alias that does not match a verified model", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "sonnet",
          displayName: "Sonnet 4.7",
          description: "Future Sonnet alias",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
    );

    assert.equal(models[0]?.slug, "sonnet");
    assert.equal(models[0]?.name, "Sonnet 4.7");
  });

  it("preserves a bare SDK alias when no version can be verified", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Bare alias",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
    );

    assert.equal(models[0]?.slug, "sonnet");
    assert.equal(models[0]?.name, "Sonnet");
  });

  it("preserves the SDK alias when a stale cached model disagrees with the SDK version", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "sonnet",
          displayName: "Sonnet 4.8",
          description: "SDK reports 4.8",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
      [
        {
          slug: "claude-sonnet-4-7",
          name: "Claude Sonnet 4.7",
          isCustom: false,
          capabilities: getClaudeModelCapabilities("claude-sonnet-4-7"),
        },
      ],
    );

    assert.equal(models[0]?.slug, "sonnet");
    assert.equal(models[0]?.name, "Sonnet 4.8");
  });

  it("maps the SDK alias when the cached model version matches the SDK displayName", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "sonnet",
          displayName: "Sonnet 4.8",
          description: "SDK reports 4.8",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
      [
        {
          slug: "claude-sonnet-4-8",
          name: "Claude Sonnet 4.8",
          isCustom: false,
          capabilities: getClaudeModelCapabilities("claude-sonnet-4-8"),
        },
      ],
    );

    assert.equal(models[0]?.slug, "claude-sonnet-4-8");
  });

  it("uses SDK models as current and retains built-ins as legacy", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Current Sonnet model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
    );

    assert.equal(models[0]?.slug, "sonnet");
    assert.equal(models[0]?.isLegacy, undefined);
    assert.equal(models[0]?.description, "Current Sonnet model");
    assert.equal(
      models.some((model) => model.slug === "claude-opus-4-8" && model.isLegacy),
      true,
    );
  });

  it("canonicalizes SDK aliases and prefers a named alias over default", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "default",
          displayName: "Default",
          description: "Default model alias",
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
        {
          value: "sonnet",
          displayName: "Sonnet 4.6",
          description: "Named model alias",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: true,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
    );

    assert.equal(models.filter((model) => model.slug === "claude-sonnet-4-6").length, 1);
    assert.equal(models[0]?.name, "Sonnet 4.6");
    assert.equal(models[0]?.description, "Named model alias");
    assert.equal(
      models[0]?.capabilities?.optionDescriptors?.some(
        (descriptor) => descriptor.id === "contextWindow",
      ),
      true,
    );
    assert.equal(
      models[0]?.capabilities?.optionDescriptors?.some(
        (descriptor) => descriptor.id === "fastMode",
      ),
      true,
    );
  });

  it("resolves a sole SDK default alias to the current canonical Sonnet model", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "default",
          displayName: "Default",
          description: "Recommended model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
    );

    assert.equal(models[0]?.slug, "claude-sonnet-4-6");
    assert.equal(
      models.some((model) => model.slug === "default"),
      false,
    );
  });

  it("uses live models as current and only enriches them with hidden cached models", () => {
    const models = resolveClaudeProviderModels(
      [
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-4-6[1m]",
          displayName: "Sonnet 4.6",
          description: "Live model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsAdaptiveThinking: true,
          supportsFastMode: true,
          supportsAutoMode: true,
        },
      ],
      "2.1.273",
      [
        {
          slug: "cached-current",
          name: "Cached current",
          isCustom: false,
          capabilities: getClaudeModelCapabilities("cached-current"),
        },
        {
          slug: "cached-hidden",
          name: "Cached hidden",
          isCustom: false,
          isLegacy: true,
          capabilities: getClaudeModelCapabilities("cached-hidden"),
        },
        {
          slug: "claude-sonnet-4-6",
          name: "Cached canonical duplicate",
          isCustom: false,
          isLegacy: true,
          capabilities: getClaudeModelCapabilities("claude-sonnet-4-6"),
        },
      ],
    );

    assert.equal(
      models.some((model) => model.slug === "cached-current"),
      false,
    );
    assert.equal(
      models.some((model) => model.slug === "cached-hidden" && model.isLegacy),
      true,
    );
    assert.equal(models.filter((model) => model.slug.startsWith("claude-sonnet-4-6")).length, 1);
  });

  it("resolves Claude option capabilities and effort values", () => {
    const opus48Caps = getClaudeModelCapabilities("claude-opus-4-8");
    const opus47Caps = getClaudeModelCapabilities("claude-opus-4-7");

    assert.equal(resolveClaudeEffort(opus48Caps, undefined), "high");
    assert.equal(resolveClaudeEffort(opus48Caps, "ultracode"), "ultracode");
    assert.equal(resolveClaudeEffort(opus47Caps, undefined), "xhigh");
    assert.equal(resolveClaudeEffort(opus47Caps, "low"), "low");
    assert.equal(resolveClaudeEffort(opus47Caps, "ultrathink"), "xhigh");
    assert.equal(
      resolveClaudeEffort(getClaudeModelCapabilities("claude-future-5"), "xhigh"),
      "xhigh",
    );
    assert.equal(normalizeClaudeCliEffort("xhigh", "claude-opus-4-8"), "xhigh");
    assert.equal(normalizeClaudeCliEffort("xhigh", "claude-future-5"), "xhigh");
    assert.equal(normalizeClaudeCliEffort("xhigh", "claude-opus-4-7"), "max");
    assert.equal(normalizeClaudeCliEffort("ultracode", "claude-opus-4-8"), "xhigh");
    assert.equal(normalizeClaudeCliEffort("max", "claude-opus-4-6"), "max");
    assert.equal(normalizeClaudeCliEffort("ultrathink", "claude-opus-4-8"), undefined);
  });

  it("adds 1m context suffix to Claude API model ids", () => {
    const selection = decodeModelSelection({
      instanceId: decodeProviderInstanceId("claudeAgent"),
      model: "claude-opus-4-7",
      options: [{ id: "contextWindow", value: "1m" }],
    });

    assert.equal(resolveClaudeApiModelId(selection), "claude-opus-4-7[1m]");
    assert.equal(
      resolveClaudeApiModelId(
        decodeModelSelection({
          instanceId: decodeProviderInstanceId("claudeAgent"),
          model: "claude-opus-4-7[1m]",
          options: [{ id: "contextWindow", value: "1m" }],
        }),
      ),
      "claude-opus-4-7[1m]",
    );
    assert.equal(
      resolveClaudeApiModelId(
        decodeModelSelection({
          instanceId: decodeProviderInstanceId("claudeAgent"),
          model: "claude-opus-4-7",
        }),
      ),
      "claude-opus-4-7",
    );
  });

  it.effect("builds pending disabled snapshots", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingClaudeProvider(
        decodeClaudeSettings({
          enabled: false,
          customModels: ["custom-claude"],
        }),
      );

      assert.equal(snapshot.displayName, "Claude");
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.auth.status, "unknown");
      assert.equal(snapshot.message, "Claude is disabled in Termweave settings.");
      assert.equal(
        snapshot.models.some((model) => model.slug === "custom-claude" && model.isCustom),
        true,
      );
    }),
  );

  it.effect("builds pending enabled snapshots", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingClaudeProvider(decodeClaudeSettings({}));

      assert.equal(snapshot.displayName, "Claude");
      assert.equal(snapshot.enabled, true);
      assert.equal(snapshot.status, "warning");
      assert.equal(
        snapshot.message,
        "Claude provider status has not been checked in this session yet.",
      );
    }),
  );
});
