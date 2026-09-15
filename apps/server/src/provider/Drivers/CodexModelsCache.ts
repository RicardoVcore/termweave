// Reads Codex's own model catalog cache (`<CODEX_HOME>/models_cache.json`),
// which the codex binary refreshes under the active auth. We use it as the
// source of truth for the model picker when the app-server `model/list` RPC
// returns nothing (older codex builds, ChatGPT-account gating), so the picker
// tracks the real models instead of a stale hard-coded list.
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ModelCapabilities, ServerProviderModel } from "@termweave/contracts";
import { createModelCapabilities } from "@termweave/shared/model";

import { expandHomePath } from "../../pathExpansion.ts";

const MODELS_CACHE_FILENAME = "models_cache.json";

// codex writes efforts we don't model (max/ultra); keep only the ones the UI
// knows how to label and dispatch.
const REASONING_EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

type RawReasoningLevel = { readonly effort?: unknown };
type RawModel = {
  readonly slug?: unknown;
  readonly display_name?: unknown;
  readonly visibility?: unknown;
  readonly default_reasoning_level?: unknown;
  readonly supported_reasoning_levels?: unknown;
  readonly additional_speed_tiers?: unknown;
};

const toDisplayName = (slug: string, displayName: unknown): string => {
  const base = typeof displayName === "string" && displayName.length > 0 ? displayName : slug;
  return base.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, c: string) => "-" + c.toUpperCase());
};

function mapCapabilities(model: RawModel): ModelCapabilities {
  const levels = Array.isArray(model.supported_reasoning_levels)
    ? (model.supported_reasoning_levels as ReadonlyArray<RawReasoningLevel>)
    : [];
  const defaultEffort =
    typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : undefined;
  const reasoningOptions = levels
    .map((level) => (typeof level?.effort === "string" ? level.effort : null))
    .filter((effort): effort is string => effort !== null && effort in REASONING_EFFORT_LABELS)
    .map((effort) =>
      effort === defaultEffort
        ? { id: effort, label: REASONING_EFFORT_LABELS[effort], isDefault: true }
        : { id: effort, label: REASONING_EFFORT_LABELS[effort] },
    );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const speedTiers = Array.isArray(model.additional_speed_tiers)
    ? (model.additional_speed_tiers as ReadonlyArray<unknown>)
    : [];
  const supportsFastMode = speedTiers.includes("fast");

  return createModelCapabilities({
    optionDescriptors: [
      ...(reasoningOptions.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              options: reasoningOptions,
              ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
            },
          ]
        : []),
      ...(supportsFastMode
        ? [{ id: "fastMode", label: "Fast Mode", type: "boolean" as const }]
        : []),
    ],
  });
}

/** Parse a models_cache.json payload into picker models. Hidden entries dropped. */
export function parseCodexModelsCache(raw: string): ReadonlyArray<ServerProviderModel> {
  const parsed: unknown = JSON.parse(raw);
  const models =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: ReadonlyArray<RawModel> }).models
      : [];
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const slug = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!slug || seen.has(slug) || model.visibility === "hide") {
      continue;
    }
    seen.add(slug);
    result.push({
      slug,
      name: toDisplayName(slug, model.display_name),
      isCustom: false,
      capabilities: mapCapabilities(model),
    });
  }
  return result;
}

/**
 * Load the model catalog from the codex home cache. Returns an empty array
 * (never fails) when the file is missing or unreadable so callers can fall
 * through to whatever they had.
 */
export const loadCodexModelsFromCache = (
  homePath: string | undefined,
): Effect.Effect<ReadonlyArray<ServerProviderModel>> =>
  Effect.gen(function* () {
    const home = homePath ? expandHomePath(homePath) : path.join(homedir(), ".codex");
    const cachePath = path.join(home, MODELS_CACHE_FILENAME);
    const raw = yield* Effect.tryPromise(() => readFile(cachePath, "utf8"));
    return parseCodexModelsCache(raw);
  }).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ServerProviderModel>)));
