// Provider settings domain helpers: reading and normalizing provider instance
// config values and model-preference ordering, shared by ui.tsx and the
// useProviderSettings hook.
import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProvider,
  type ServerSettings,
} from "@termweave/contracts";
import type { AppSettings } from "@termweave/client-core";
import { modelSlugLabel } from "../../modelMenuNavigation";
import { normalizeProviderAccentColor } from "../../providerInstances";
import {
  INSTALL_PROVIDER_SETTINGS,
  defaultProviderInstanceIdForSettingsKey,
  type InstallProviderFieldKey,
  type InstallProviderSettings,
  type ProviderSettingsKey,
} from "../../providerSettings";

export type ProviderEnvironmentDraft = {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
};
export type ProviderEnvironmentDraftMap = Readonly<Record<string, ProviderEnvironmentDraft>>;
export type ProviderInstanceWritePatch = {
  readonly accentColor?: ProviderInstanceConfig["accentColor"] | undefined;
  readonly displayName?: ProviderInstanceConfig["displayName"] | undefined;
  readonly environment?: ProviderInstanceConfig["environment"] | undefined;
  readonly enabled?: ProviderInstanceConfig["enabled"] | undefined;
};

export const EMPTY_PROVIDER_ENVIRONMENT_DRAFT: ProviderEnvironmentDraft = {
  name: "",
  value: "",
  sensitive: true,
};
export const PROVIDER_ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const MODEL_PREFERENCE_ROWS_COLLAPSED_COUNT = 8;
export const CUSTOM_MODEL_ROWS_COLLAPSED_COUNT = 5;

export const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver("codex" as ProviderDriverKind);

export type InstallProviderKey = ProviderSettingsKey;

export type ModelMenuInstanceEntry = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly provider: ProviderKind;
  readonly displayName: string;
  readonly accentColor?: string;
  readonly isDefault: boolean;
};
export type ModelMenuOption = {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly isDefault?: boolean;
  readonly isLegacy?: boolean;
  readonly isCustom: boolean;
};

export function modelMenuDisplayName(
  option: ModelMenuOption,
  options?: { preferShortName?: boolean },
) {
  if (options?.preferShortName && option.shortName) return option.shortName;
  // Custom Claude entries without a server name are saved slugs the current
  // catalog no longer lists; derive a readable label from the slug.
  if (option.isCustom && option.name === option.slug && /^claude-/i.test(option.slug)) {
    return modelSlugLabel(option.slug);
  }
  return option.name;
}

export function modelMenuDisplayLabel(option: ModelMenuOption): string {
  const name = modelMenuDisplayName(option, { preferShortName: true });
  return option.subProvider ? `${option.subProvider} · ${name}` : name;
}

export function readProviderInstallSettingValue(
  settings: ServerSettings,
  provider: InstallProviderKey,
  field: InstallProviderFieldKey,
): string {
  const instanceConfig =
    settings.providerInstances[defaultProviderInstanceIdForSettingsKey(provider)]?.config;
  if (
    instanceConfig &&
    typeof instanceConfig === "object" &&
    !globalThis.Array.isArray(instanceConfig) &&
    field in instanceConfig
  ) {
    return String((instanceConfig as Record<string, unknown>)[field] ?? "");
  }
  const providerSettings = settings.providers[provider];
  return field in providerSettings
    ? String(providerSettings[field as keyof typeof providerSettings] ?? "")
    : "";
}

export function readProviderInstanceMetadataValue(
  settings: ServerSettings | null,
  instanceId: ProviderInstanceId,
  field: "accentColor" | "displayName",
): string {
  return settings?.providerInstances[instanceId]?.[field]?.trim() ?? "";
}

export function readProviderInstanceEnvironment(
  settings: ServerSettings | null,
  instanceId: ProviderInstanceId,
): readonly ProviderInstanceEnvironmentVariable[] {
  return settings?.providerInstances[instanceId]?.environment ?? [];
}

export function readAdditionalProviderInstances(
  settings: ServerSettings | null,
  provider: InstallProviderKey,
): readonly [ProviderInstanceId, ProviderInstanceConfig][] {
  if (!settings) return [];
  const defaultInstanceId = defaultProviderInstanceIdForSettingsKey(provider);
  return Object.entries(settings.providerInstances)
    .filter(
      (entry): entry is [ProviderInstanceId, ProviderInstanceConfig] =>
        entry[0] !== defaultInstanceId && entry[1].driver === provider,
    )
    .toSorted(([leftId], [rightId]) => String(leftId).localeCompare(String(rightId)));
}

export type ProviderInstanceRow = {
  readonly id: ProviderInstanceId;
  readonly driver: InstallProviderKey;
  readonly title: string;
  readonly badgeLabel?: string;
  readonly displayName: string;
  readonly accentColor?: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly statusText: string;
};

export function readProviderInstanceEnabledValue(
  settings: ServerSettings | null,
  instanceId: ProviderInstanceId,
  fallback: boolean,
): boolean {
  const instance = settings?.providerInstances[instanceId];
  if (typeof instance?.enabled === "boolean") {
    return instance.enabled;
  }
  if (
    instance?.config &&
    typeof instance.config === "object" &&
    !globalThis.Array.isArray(instance.config)
  ) {
    const enabled = (instance.config as Record<string, unknown>).enabled;
    if (typeof enabled === "boolean") {
      return enabled;
    }
  }
  return fallback;
}

// Short per-row status for the instance list: version, "disabled", "not
// checked" (no snapshot yet), or an update marker; full detail text lives in
// the detail view.
function providerInstanceListStatusText(
  snapshot: ServerProvider | undefined,
  enabled: boolean,
): string {
  if (!enabled) return "disabled";
  if (!snapshot) return "not checked";
  if (snapshot.versionAdvisory?.status === "behind_latest") return "update";
  return snapshot.version || "not installed";
}

function buildProviderInstanceRow(input: {
  readonly instanceId: ProviderInstanceId;
  readonly providerSettings: InstallProviderSettings;
  readonly isDefault: boolean;
  readonly serverSettings: ServerSettings | null;
  readonly snapshot: ServerProvider | undefined;
}): ProviderInstanceRow {
  const { instanceId, providerSettings, isDefault, serverSettings, snapshot } = input;
  const enabled = readProviderInstanceEnabledValue(
    serverSettings,
    instanceId,
    serverSettings
      ? serverSettings.providers[providerSettings.provider].enabled
      : DEFAULT_SERVER_SETTINGS.providers[providerSettings.provider].enabled,
  );
  const accentColor = normalizeProviderAccentColor(
    serverSettings?.providerInstances[instanceId]?.accentColor,
  );
  const savedDisplayName = readProviderInstanceMetadataValue(
    serverSettings,
    instanceId,
    "displayName",
  );
  return {
    id: instanceId,
    driver: providerSettings.provider,
    title: providerSettings.title,
    ...(providerSettings.badgeLabel ? { badgeLabel: providerSettings.badgeLabel } : {}),
    displayName: isDefault
      ? savedDisplayName || providerSettings.title
      : savedDisplayName || String(instanceId),
    ...(accentColor ? { accentColor } : {}),
    enabled,
    isDefault,
    statusText: providerInstanceListStatusText(snapshot, enabled),
  };
}

// One row per configured provider instance: each install provider's default
// instance first, then its additional instances, in INSTALL_PROVIDER_SETTINGS
// order. List entries are derived purely from settings + snapshots.
export function buildProviderInstanceRows(input: {
  readonly serverSettings: ServerSettings | null;
  readonly snapshots: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<ProviderInstanceRow> {
  const snapshotByInstanceId = new Map(
    input.snapshots.map((snapshot) => [snapshot.instanceId, snapshot] as const),
  );
  const rows: ProviderInstanceRow[] = [];
  for (const providerSettings of INSTALL_PROVIDER_SETTINGS) {
    const defaultInstanceId = defaultProviderInstanceIdForSettingsKey(providerSettings.provider);
    rows.push(
      buildProviderInstanceRow({
        instanceId: defaultInstanceId,
        providerSettings,
        isDefault: true,
        serverSettings: input.serverSettings,
        snapshot: snapshotByInstanceId.get(defaultInstanceId),
      }),
    );
    for (const [instanceId] of readAdditionalProviderInstances(
      input.serverSettings,
      providerSettings.provider,
    )) {
      rows.push(
        buildProviderInstanceRow({
          instanceId,
          providerSettings,
          isDefault: false,
          serverSettings: input.serverSettings,
          snapshot: snapshotByInstanceId.get(instanceId),
        }),
      );
    }
  }
  return rows;
}

export function readProviderInstanceConfigValue(
  instance: ProviderInstanceConfig,
  field: InstallProviderFieldKey,
): string {
  const config = instance.config;
  if (!config || typeof config !== "object" || globalThis.Array.isArray(config)) {
    return "";
  }
  return String((config as Record<string, unknown>)[field] ?? "");
}

export function sortProviderModelPreferenceOptions(
  options: ReadonlyArray<ModelMenuOption>,
  appSettings: AppSettings,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ModelMenuOption> {
  const preferences = appSettings.providerModelPreferences[instanceId];
  const modelOrder = new Map((preferences?.modelOrder ?? []).map((slug, index) => [slug, index]));
  const favoriteModels = new Set(
    appSettings.favorites
      .filter((favorite) => favorite.provider === instanceId)
      .map((favorite) => favorite.model),
  );
  return options
    .map((option, index) => ({ option, index }))
    .toSorted((left, right) => {
      const favoriteDelta =
        Number(favoriteModels.has(right.option.slug)) -
        Number(favoriteModels.has(left.option.slug));
      if (favoriteDelta !== 0) return favoriteDelta;
      const leftRank = modelOrder.get(left.option.slug) ?? Number.POSITIVE_INFINITY;
      const rightRank = modelOrder.get(right.option.slug) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map(({ option }) => option);
}

export function readProviderInstallEnabled(
  settings: ServerSettings,
  provider: InstallProviderKey,
): boolean {
  return readProviderInstanceEnabledValue(
    settings,
    defaultProviderInstanceIdForSettingsKey(provider),
    settings.providers[provider].enabled,
  );
}

export function isProviderInstallSettingsDirtyForSettings(
  settings: ServerSettings,
  providerSettings: InstallProviderSettings,
): boolean {
  if (
    settings.providerInstances[
      defaultProviderInstanceIdForSettingsKey(providerSettings.provider)
    ] !== undefined
  ) {
    return true;
  }
  if (
    readProviderInstallEnabled(settings, providerSettings.provider) !==
    DEFAULT_SERVER_SETTINGS.providers[providerSettings.provider].enabled
  ) {
    return true;
  }
  return providerSettings.fields.some(
    (field) =>
      readProviderInstallSettingValue(settings, providerSettings.provider, field.key) !==
      String(
        DEFAULT_SERVER_SETTINGS.providers[providerSettings.provider][
          field.key as keyof (typeof DEFAULT_SERVER_SETTINGS.providers)[typeof providerSettings.provider]
        ] ?? "",
      ),
  );
}
