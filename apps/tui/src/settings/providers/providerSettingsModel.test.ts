import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@termweave/contracts";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "@termweave/client-core";
import { Schema } from "effect";
import {
  buildProviderInstanceRows,
  readProviderInstanceEnabledValue,
  sortProviderModelPreferenceOptions,
  type ModelMenuOption,
} from "./providerSettingsModel";

const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

function instance(input: {
  driver: "codex" | "claudeAgent";
  displayName?: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: "codex" as ProviderInstanceId,
    driver: decodeProviderDriverKind(input.driver),
    checkedAt: "2026-01-01T00:00:00.000Z",
    version: "1.0.0",
    installed: true,
    status: "ready",
    availability: "available",
    enabled: input.enabled ?? true,
    models: [],
    ...(input.displayName ? { displayName: input.displayName } : {}),
  } as unknown as ServerProvider;
}

function settingsWithInstances(
  instances: ReadonlyArray<{
    id: string;
    driver: "codex" | "claudeAgent";
    displayName?: string;
    enabled?: boolean;
  }>,
): typeof DEFAULT_SERVER_SETTINGS {
  const providerInstances: Record<string, unknown> = {};
  for (const entry of instances) {
    providerInstances[decodeProviderInstanceId(entry.id)] = {
      driver: decodeProviderDriverKind(entry.driver),
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
      config: {},
    };
  }
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances,
  } as typeof DEFAULT_SERVER_SETTINGS;
}

describe("buildProviderInstanceRows", () => {
  it("orders default instances before additional ones, providers in install order", () => {
    const rows = buildProviderInstanceRows({
      serverSettings: settingsWithInstances([
        { id: "codex_personal", driver: "codex" },
        { id: "claudeAgent", driver: "claudeAgent" },
        { id: "codex", driver: "codex" },
      ]),
      snapshots: [],
    });
    expect(rows.map((row) => String(row.id))).toEqual([
      "codex",
      "codex_personal",
      "claudeAgent",
      "cursor",
      "opencode",
      "pi",
    ]);
    expect(rows.map((row) => row.isDefault)).toEqual([true, false, true, true, true, true]);
  });

  it("marks disabled instances with a disabled status", () => {
    const rows = buildProviderInstanceRows({
      serverSettings: settingsWithInstances([{ id: "codex", driver: "codex", enabled: false }]),
      snapshots: [instance({ driver: "codex" })],
    });
    const codexRow = rows.find((row) => String(row.id) === "codex")!;
    expect(codexRow.enabled).toBe(false);
    expect(codexRow.statusText).toBe("disabled");
  });

  it("falls back to the instance title for defaults and the instance id for additional rows", () => {
    const rows = buildProviderInstanceRows({
      serverSettings: settingsWithInstances([
        { id: "codex", driver: "codex" },
        { id: "codex_work", driver: "codex", displayName: "Work Codex" },
        { id: "codex_personal", driver: "codex" },
      ]),
      snapshots: [],
    });
    const byId = new Map(rows.map((row) => [String(row.id), row] as const));
    expect(byId.get("codex")!.displayName).toBe("Codex");
    expect(byId.get("codex_work")!.displayName).toBe("Work Codex");
    expect(byId.get("codex_personal")!.displayName).toBe("codex_personal");
  });

  it("shows an update status when an update is available", () => {
    const snapshot = {
      ...instance({ driver: "codex" }),
      versionAdvisory: { status: "behind_latest", canUpdate: true },
    } as unknown as ServerProvider;
    const rows = buildProviderInstanceRows({
      serverSettings: settingsWithInstances([{ id: "codex", driver: "codex" }]),
      snapshots: [snapshot],
    });
    expect(rows[0]!.statusText).toBe("update");
  });

  it("falls back to the fallback enabled value when settings are absent", () => {
    expect(readProviderInstanceEnabledValue(null, decodeProviderInstanceId("codex"), true)).toBe(
      true,
    );
    expect(readProviderInstanceEnabledValue(null, decodeProviderInstanceId("codex"), false)).toBe(
      false,
    );
  });

  it("marks rows without a snapshot as not checked", () => {
    const rows = buildProviderInstanceRows({
      serverSettings: settingsWithInstances([{ id: "codex", driver: "codex" }]),
      snapshots: [],
    });
    expect(rows[0]!.statusText).toBe("not checked");
  });

  it("keeps the version status for snapshots without a version", () => {
    const snapshot = {
      ...instance({ driver: "codex" }),
      version: null,
    } as unknown as ServerProvider;
    const rows = buildProviderInstanceRows({
      serverSettings: settingsWithInstances([{ id: "codex", driver: "codex" }]),
      snapshots: [snapshot],
    });
    expect(rows[0]!.statusText).toBe("not installed");
  });
});

describe("sortProviderModelPreferenceOptions", () => {
  const option = (slug: string): ModelMenuOption => ({ slug, name: slug, isCustom: false });
  const options = [option("alpha"), option("beta"), option("gamma"), option("delta")];
  const codexId = decodeProviderInstanceId("codex");
  const claudeId = decodeProviderInstanceId("claudeAgent");

  function appSettingsWith(overrides: Partial<AppSettings>): AppSettings {
    return { ...DEFAULT_APP_SETTINGS, ...overrides } as AppSettings;
  }

  it("lists favorited models first", () => {
    const sorted = sortProviderModelPreferenceOptions(
      options,
      appSettingsWith({
        favorites: [{ provider: codexId, model: "gamma" }],
      }),
      codexId,
    );
    expect(sorted.map((entry) => entry.slug)).toEqual(["gamma", "alpha", "beta", "delta"]);
  });

  it("orders unfavorited models by modelOrder", () => {
    const sorted = sortProviderModelPreferenceOptions(
      options,
      appSettingsWith({
        providerModelPreferences: {
          [codexId]: { hiddenModels: [], modelOrder: ["delta", "beta"] },
        },
      }),
      codexId,
    );
    expect(sorted.map((entry) => entry.slug)).toEqual(["delta", "beta", "alpha", "gamma"]);
  });

  it("keeps original input order when no preferences exist", () => {
    const sorted = sortProviderModelPreferenceOptions(options, DEFAULT_APP_SETTINGS, codexId);
    expect(sorted.map((entry) => entry.slug)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("ignores favorites and order saved for a different instance", () => {
    const sorted = sortProviderModelPreferenceOptions(
      options,
      appSettingsWith({
        favorites: [{ provider: claudeId, model: "delta" }],
        providerModelPreferences: {
          [claudeId]: { hiddenModels: [], modelOrder: ["delta", "gamma", "beta", "alpha"] },
        },
      }),
      codexId,
    );
    expect(sorted.map((entry) => entry.slug)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });
});
