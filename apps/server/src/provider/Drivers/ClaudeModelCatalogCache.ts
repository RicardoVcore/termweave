// Reads Claude Code's on-disk model catalog cache
// (`<home>/.claude/cache/model-catalog/*.json`), which the claude binary
// refreshes under the active account. We use it as the source of truth for the
// model picker so it tracks the real, current models instead of a stale
// hard-coded list. The cache only describes each model coarsely (a thinking
// type and an optional fast mode), so capabilities are synthesized by the
// caller, which keeps the richer built-in descriptors for models it knows.
import { Effect } from "effect";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MODEL_CATALOG_DIR = path.join(".claude", "cache", "model-catalog");
// claude ships several catalogs keyed by "surface"; the CLI uses "cc".
const CLAUDE_CODE_SURFACE = "cc";

export type ClaudeCatalogModel = {
  readonly slug: string;
  readonly name: string;
  readonly thinkingType: "effort" | "none";
  readonly fastMode: boolean;
};

type RawCatalogModel = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly hidden?: unknown;
  readonly thinking?: { readonly type?: unknown } | null;
  readonly fast_mode?: unknown;
};

/** Parse one catalog file. Returns its models plus the metadata needed to pick
 * the freshest "cc" file among several, or null when it isn't a usable "cc"
 * catalog. */
export function parseClaudeCatalogFile(
  raw: string,
): { readonly fetchedAt: number; readonly models: ReadonlyArray<ClaudeCatalogModel> } | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as {
    readonly fetchedAt?: unknown;
    readonly catalog?: {
      readonly surface?: unknown;
      readonly config?: { readonly models?: unknown };
    };
  };
  if (record.catalog?.surface !== CLAUDE_CODE_SURFACE) {
    return null;
  }
  const rawModels = Array.isArray(record.catalog.config?.models)
    ? (record.catalog.config.models as ReadonlyArray<RawCatalogModel>)
    : [];
  const seen = new Set<string>();
  const models: ClaudeCatalogModel[] = [];
  for (const model of rawModels) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const slug = typeof model.id === "string" ? model.id.trim() : "";
    if (!slug || seen.has(slug) || model.hidden === true) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : slug,
      thinkingType: model.thinking?.type === "effort" ? "effort" : "none",
      // `fast_mode` is a config object when supported, absent otherwise; a
      // literal `false` means off.
      fastMode:
        model.fast_mode !== undefined && model.fast_mode !== null && model.fast_mode !== false,
    });
  }
  return { fetchedAt: typeof record.fetchedAt === "number" ? record.fetchedAt : 0, models };
}

/**
 * Load the freshest Claude Code model catalog from the cache under `homeDir`.
 * Returns an empty array (never fails) when the cache is missing or unreadable
 * so callers fall through to their built-in list.
 */
export const loadClaudeModelCatalog = (
  homeDir: string,
): Effect.Effect<ReadonlyArray<ClaudeCatalogModel>> =>
  Effect.gen(function* () {
    const dir = path.join(homeDir, MODEL_CATALOG_DIR);
    const files = yield* Effect.tryPromise(() => readdir(dir));
    const parsed = yield* Effect.forEach(
      files.filter((file) => file.endsWith(".json")),
      (file) =>
        Effect.tryPromise(() => readFile(path.join(dir, file), "utf8")).pipe(
          Effect.map(parseClaudeCatalogFile),
          Effect.catch(() => Effect.succeed(null)),
        ),
      { concurrency: "unbounded" },
    );
    // Prefer the most recently fetched catalog when several are present.
    const freshest = parsed
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .toSorted((a, b) => b.fetchedAt - a.fetchedAt)[0];
    return freshest?.models ?? [];
  }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ClaudeCatalogModel>)));
