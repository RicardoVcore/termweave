// Owns all state, derived values, and handlers for the Settings > Providers
// view so ui.tsx stays small; App passes its shared inputs in and reads the
// returned values. Writes are instance-keyed and internally routed to the
// default-instance or additional-instance path based on the row's driver.
import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerConfig,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@termweave/contracts";
import {
  createTransportNativeApi,
  DEFAULT_APP_SETTINGS,
  MAX_CUSTOM_MODEL_LENGTH,
  MODEL_PROVIDER_SETTINGS,
  normalizeCustomModelSlugs,
  patchCustomModels,
  scoreModelPickerSearch,
  type AppSettings,
} from "@termweave/client-core";
import { getModelOptions, normalizeModelSlug } from "@termweave/shared/model";
import { normalizeProviderAccentColor } from "../../providerInstances";
import type { T1Logger } from "../../log";
import {
  INSTALL_PROVIDER_SETTINGS,
  buildDefaultProviderInstanceUpdatePatch,
  buildDeleteProviderInstancePatch,
  buildDuplicateDefaultProviderInstancePatch,
  buildProviderInstanceUpdatePatch,
  buildResetDefaultProviderInstancesPatch,
  type InstallProviderFieldKey,
  type InstallProviderSettings,
} from "../../providerSettings";
import {
  EMPTY_PROVIDER_ENVIRONMENT_DRAFT,
  MODEL_PREFERENCE_ROWS_COLLAPSED_COUNT,
  PROVIDER_ENVIRONMENT_VARIABLE_NAME_PATTERN,
  isProviderInstallSettingsDirtyForSettings,
  modelMenuDisplayLabel,
  readProviderInstallSettingValue,
  readProviderInstanceConfigValue,
  sortProviderModelPreferenceOptions,
  buildProviderInstanceRows,
  readProviderInstanceEnvironment,
  readProviderInstanceMetadataValue,
  type InstallProviderKey,
  type ModelMenuInstanceEntry,
  type ModelMenuOption,
  type ProviderEnvironmentDraftMap,
  type ProviderInstanceRow,
  type ProviderInstanceWritePatch,
} from "./providerSettingsModel";

type T1Api = ReturnType<typeof createTransportNativeApi>["api"];

// Everything App owns that the Providers view logic needs but does not
// compute itself (values shared with the model picker and other views).
export type UseProviderSettingsInput = {
  api: T1Api | null;
  logger: T1Logger;
  appSettings: AppSettings;
  updateAppSettings: (patch: Partial<AppSettings>) => void;
  serverSettings: ServerSettings | null;
  setServerSettings: Dispatch<SetStateAction<ServerSettings | null>>;
  updateServerSettings: (patch: ServerSettingsPatch) => void;
  setServerConfig: Dispatch<SetStateAction<ServerConfig | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  providerSnapshots: ReadonlyArray<ServerProvider>;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
  modelMenuEntryByInstanceId: ReadonlyMap<ProviderInstanceId, ModelMenuInstanceEntry>;
  rawProviderModelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ModelMenuOption>
  >;
  currentGitTextGenerationInstanceId: ProviderInstanceId;
  currentGitTextGenerationModel: string;
  currentGitTextGenerationEntry: ModelMenuInstanceEntry;
  gitTextGenerationModelOptions: ReadonlyArray<ModelMenuOption>;
};

export type ProviderSettingsState = {
  instanceRows: ReadonlyArray<ProviderInstanceRow>;
  selectedInstanceId: ProviderInstanceId;
  selectedRow: ProviderInstanceRow;
  selectInstance: (instanceId: ProviderInstanceId) => void;
  addInstance: (driver: InstallProviderKey) => void;
  removeInstance: (instanceId: ProviderInstanceId) => void;
  setInstanceEnabled: (instanceId: ProviderInstanceId, enabled: boolean) => void;
  setInstanceDisplayName: (instanceId: ProviderInstanceId, value: string) => void;
  setInstanceAccentColor: (instanceId: ProviderInstanceId, value: string) => void;
  setInstanceField: (
    instanceId: ProviderInstanceId,
    field: InstallProviderFieldKey,
    value: string,
  ) => void;
  instanceMetadataValue: (
    instanceId: ProviderInstanceId,
    field: "accentColor" | "displayName",
  ) => string;
  instanceFieldValue: (instanceId: ProviderInstanceId, field: InstallProviderFieldKey) => string;
  instanceEnvironment: (
    instanceId: ProviderInstanceId,
  ) => readonly ProviderInstanceEnvironmentVariable[];
  providerEnvironmentDraftByInstance: ProviderEnvironmentDraftMap;
  setProviderEnvironmentDraftByInstance: Dispatch<SetStateAction<ProviderEnvironmentDraftMap>>;
  addInstanceEnvVar: (instanceId: ProviderInstanceId) => void;
  updateInstanceEnvVar: (
    instanceId: ProviderInstanceId,
    name: string,
    patch: Partial<Pick<ProviderInstanceEnvironmentVariable, "sensitive" | "value">>,
  ) => void;
  removeInstanceEnvVar: (instanceId: ProviderInstanceId, name: string) => void;
  apiAvailable: boolean;
  isRefreshingProviders: boolean;
  updatingProviderInstanceId: ProviderInstanceId | null;
  refreshProviderSnapshots: (instanceId?: ProviderInstanceId) => Promise<void>;
  runProviderUpdate: (provider: ServerProvider) => Promise<void>;
  providerSnapshotByInstanceId: ReadonlyMap<ProviderInstanceId, ServerProvider>;
  providerLastCheckedAt: string | null;
  isGitTextGenerationModelDirty: boolean;
  selectedGitTextGenerationModelLabel: string;
  selectedGitTextGenerationProviderLabel: string;
  resetGitTextGenerationModel: () => void;
  instanceModelEntry: ModelMenuInstanceEntry | null;
  instanceModelOptions: ReadonlyArray<ModelMenuOption>;
  instanceModelHiddenModels: ReadonlySet<string>;
  instanceModelFavoriteModels: ReadonlySet<string>;
  isModelPreferencesQueryActive: boolean;
  filteredModelPreferenceOptions: ReadonlyArray<ModelMenuOption>;
  modelPreferenceIndexBySlug: ReadonlyMap<string, number>;
  visibleModelPreferenceRows: ReadonlyArray<ModelMenuOption>;
  instanceFavoriteModelCount: number;
  instanceHiddenModelCount: number;
  hasInstanceModelSettings: boolean;
  modelPreferencesQuery: string;
  setModelPreferencesQuery: Dispatch<SetStateAction<string>>;
  showAllModelPreferenceRows: boolean;
  setShowAllModelPreferenceRows: Dispatch<SetStateAction<boolean>>;
  toggleFavoriteModel: (instanceId: ProviderInstanceId, slug: string) => void;
  toggleHiddenModel: (instanceId: ProviderInstanceId, slug: string) => void;
  moveModelPreference: (instanceId: ProviderInstanceId, slug: string, direction: -1 | 1) => void;
  resetInstanceModelPreferences: (instanceId: ProviderInstanceId) => void;
  instanceCustomModelProvider: ProviderKind | null;
  instanceCustomModelSlugs: readonly string[];
  customModelInputByProvider: Record<ProviderKind, string>;
  setCustomModelInputByProvider: Dispatch<SetStateAction<Record<ProviderKind, string>>>;
  customModelErrorByProvider: Partial<Record<ProviderKind, string | null>>;
  setCustomModelErrorByProvider: Dispatch<
    SetStateAction<Partial<Record<ProviderKind, string | null>>>
  >;
  showAllCustomModels: boolean;
  setShowAllCustomModels: Dispatch<SetStateAction<boolean>>;
  addCustomModel: (provider: ProviderKind) => void;
  removeCustomModel: (provider: ProviderKind, slug: string) => void;
  resetInstanceCustomModels: (provider: ProviderKind) => void;
  hasCustomModels: boolean;
  isInstallSettingsDirty: boolean;
  resetProviderInstallSettings: () => void;
  hasAnyModelPreferenceSettings: boolean;
  resetTransientState: () => void;
};

export function useProviderSettings(input: UseProviderSettingsInput): ProviderSettingsState {
  const {
    api,
    logger,
    appSettings,
    updateAppSettings,
    serverSettings,
    setServerSettings,
    updateServerSettings,
    setServerConfig,
    setStatus,
    providerSnapshots,
    customModelsByProvider,
    modelMenuEntryByInstanceId,
    rawProviderModelOptionsByInstance,
    currentGitTextGenerationInstanceId,
    currentGitTextGenerationModel,
    currentGitTextGenerationEntry,
    gitTextGenerationModelOptions,
  } = input;

  const [selectedInstanceIdState, setSelectedInstanceIdState] = useState<ProviderInstanceId | null>(
    null,
  );
  const [providerEnvironmentDraftByInstance, setProviderEnvironmentDraftByInstance] =
    useState<ProviderEnvironmentDraftMap>({});
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [showAllCustomModels, setShowAllCustomModels] = useState(false);
  const [showAllModelPreferenceRows, setShowAllModelPreferenceRows] = useState(false);
  const [modelPreferencesQuery, setModelPreferencesQuery] = useState("");
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const providerRefreshInFlightRef = useRef(false);
  const [updatingProviderInstanceId, setUpdatingProviderInstanceId] =
    useState<ProviderInstanceId | null>(null);
  const providerUpdateInFlightRef = useRef<ProviderInstanceId | null>(null);
  // Guard on refs, not state: two calls in one tick would both read the
  // stale closure value and run concurrently. State stays for rendering only.
  const refreshProviderSnapshots = useCallback(
    async (instanceId?: ProviderInstanceId) => {
      if (!api || providerRefreshInFlightRef.current) return;
      providerRefreshInFlightRef.current = true;
      setIsRefreshingProviders(true);
      try {
        const payload = await api.server.refreshProviders(instanceId ? { instanceId } : undefined);
        setServerConfig((current) =>
          current
            ? {
                ...current,
                providerInstances: payload.providers,
              }
            : current,
        );
        setStatus("Providers refreshed");
      } catch (error) {
        logger.log("server.providers.refreshFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus("Provider refresh failed");
      } finally {
        providerRefreshInFlightRef.current = false;
        setIsRefreshingProviders(false);
      }
    },
    [api, logger, setServerConfig, setStatus],
  );

  const runProviderUpdate = useCallback(
    async (provider: ServerProvider) => {
      if (!api || providerUpdateInFlightRef.current !== null) return;
      providerUpdateInFlightRef.current = provider.instanceId;
      setUpdatingProviderInstanceId(provider.instanceId);
      try {
        const payload = await api.server.updateProvider({
          provider: provider.driver,
          instanceId: provider.instanceId,
        });
        setServerConfig((current) =>
          current
            ? {
                ...current,
                providerInstances: payload.providers,
              }
            : current,
        );
        const updated = payload.providers.find(
          (candidate) => candidate.instanceId === provider.instanceId,
        );
        setStatus(updated?.updateState?.message ?? "Provider update finished");
      } catch (error) {
        logger.log("server.providers.updateFailed", {
          provider: provider.driver,
          instanceId: provider.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus("Provider update failed");
      } finally {
        providerUpdateInFlightRef.current = null;
        setUpdatingProviderInstanceId(null);
      }
    },
    [api, logger, setServerConfig, setStatus],
  );
  const providerSnapshotByInstanceId = useMemo(
    () => new Map(providerSnapshots.map((provider) => [provider.instanceId, provider] as const)),
    [providerSnapshots],
  );
  const providerLastCheckedAt =
    providerSnapshots.length > 0
      ? providerSnapshots.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          providerSnapshots[0]!.checkedAt,
        )
      : null;
  const instanceRows = useMemo(
    () => buildProviderInstanceRows({ serverSettings, snapshots: providerSnapshots }),
    [providerSnapshots, serverSettings],
  );
  const instanceRowById = useMemo(
    () => new Map(instanceRows.map((row) => [row.id, row] as const)),
    [instanceRows],
  );
  // Selected instance falls back to the first row when it disappears
  // (e.g. after removal), so writes always target an existing instance.
  const selectedInstanceId =
    selectedInstanceIdState !== null && instanceRowById.has(selectedInstanceIdState)
      ? selectedInstanceIdState
      : instanceRows[0]!.id;
  const selectedRow = instanceRowById.get(selectedInstanceId)!;
  const selectedDriver = selectedRow.driver;

  function selectInstance(instanceId: ProviderInstanceId) {
    setSelectedInstanceIdState(instanceId);
    // Instance-scoped view state resets on switch so the new instance's
    // content starts unfiltered and collapsed.
    setModelPreferencesQuery("");
    setShowAllModelPreferenceRows(false);
    setShowAllCustomModels(false);
  }

  // Single write path for every instance edit. Default instances go through
  // buildDefaultProviderInstanceUpdatePatch (which also mirrors codex/claude
  // binary paths into app settings), all others through
  // buildProviderInstanceUpdatePatch.
  function writeInstance(
    instanceId: ProviderInstanceId,
    configPatch: Partial<Record<InstallProviderFieldKey, string>>,
    instancePatch?: ProviderInstanceWritePatch,
  ) {
    if (!serverSettings) {
      setStatus("Settings loading");
      return;
    }
    const row = instanceRowById.get(instanceId);
    if (!row) return;
    if (row.isDefault && row.driver === "codex") {
      updateAppSettings({
        ...(configPatch.binaryPath !== undefined
          ? { codexBinaryPath: configPatch.binaryPath }
          : {}),
        ...(configPatch.homePath !== undefined ? { codexHomePath: configPatch.homePath } : {}),
      });
    } else if (
      row.isDefault &&
      row.driver === "claudeAgent" &&
      configPatch.binaryPath !== undefined
    ) {
      updateAppSettings({ claudeBinaryPath: configPatch.binaryPath });
    }
    const textGenerationModelSelection =
      instancePatch?.enabled === false && currentGitTextGenerationInstanceId === instanceId
        ? DEFAULT_SERVER_SETTINGS.textGenerationModelSelection
        : undefined;
    const settingsPatch = row.isDefault
      ? buildDefaultProviderInstanceUpdatePatch({
          settings: serverSettings,
          provider: row.driver,
          configPatch,
          instancePatch,
        })
      : buildProviderInstanceUpdatePatch({
          settings: serverSettings,
          instanceId,
          configPatch,
          instancePatch,
        });
    setServerSettings((current) =>
      current
        ? {
            ...current,
            ...(textGenerationModelSelection ? { textGenerationModelSelection } : {}),
            ...(settingsPatch.providers
              ? {
                  providers: {
                    ...current.providers,
                    ...settingsPatch.providers,
                  } as ServerSettings["providers"],
                }
              : {}),
            providerInstances: settingsPatch.providerInstances ?? current.providerInstances,
          }
        : current,
    );
    updateServerSettings({
      ...settingsPatch,
      ...(textGenerationModelSelection ? { textGenerationModelSelection } : {}),
    });
  }

  function setInstanceEnabled(instanceId: ProviderInstanceId, enabled: boolean) {
    writeInstance(instanceId, {}, { enabled });
  }

  function setInstanceDisplayName(instanceId: ProviderInstanceId, value: string) {
    const trimmed = value.trim();
    writeInstance(instanceId, {}, { displayName: trimmed || undefined });
  }

  function setInstanceAccentColor(instanceId: ProviderInstanceId, value: string) {
    const trimmed = value.trim();
    writeInstance(
      instanceId,
      {},
      {
        accentColor:
          trimmed.length === 0 ? undefined : (normalizeProviderAccentColor(trimmed) ?? trimmed),
      },
    );
  }

  function setInstanceField(
    instanceId: ProviderInstanceId,
    field: InstallProviderFieldKey,
    value: string,
  ) {
    writeInstance(instanceId, { [field]: value });
  }

  function instanceMetadataValue(
    instanceId: ProviderInstanceId,
    field: "accentColor" | "displayName",
  ): string {
    return readProviderInstanceMetadataValue(serverSettings, instanceId, field);
  }

  function instanceFieldValue(
    instanceId: ProviderInstanceId,
    field: InstallProviderFieldKey,
  ): string {
    const row = instanceRowById.get(instanceId);
    if (!row) return "";
    if (!serverSettings) {
      if (row.isDefault && row.driver === "codex") {
        if (field === "binaryPath") return appSettings.codexBinaryPath;
        if (field === "homePath") return appSettings.codexHomePath;
      }
      if (row.isDefault && row.driver === "claudeAgent" && field === "binaryPath") {
        return appSettings.claudeBinaryPath;
      }
      const defaultProviderSettings = DEFAULT_SERVER_SETTINGS.providers[row.driver];
      return field in defaultProviderSettings
        ? String(defaultProviderSettings[field as keyof typeof defaultProviderSettings] ?? "")
        : "";
    }
    if (row.isDefault) {
      return readProviderInstallSettingValue(serverSettings, row.driver, field);
    }
    const instance = serverSettings.providerInstances[instanceId];
    return instance ? readProviderInstanceConfigValue(instance, field) : "";
  }

  function instanceEnvironment(
    instanceId: ProviderInstanceId,
  ): readonly ProviderInstanceEnvironmentVariable[] {
    return readProviderInstanceEnvironment(serverSettings, instanceId);
  }

  function updateInstanceEnvironment(
    instanceId: ProviderInstanceId,
    environment: readonly ProviderInstanceEnvironmentVariable[],
  ) {
    writeInstance(
      instanceId,
      {},
      { environment: environment.length > 0 ? [...environment] : undefined },
    );
  }

  function addInstanceEnvVar(instanceId: ProviderInstanceId) {
    const draft =
      providerEnvironmentDraftByInstance[instanceId] ?? EMPTY_PROVIDER_ENVIRONMENT_DRAFT;
    const name = draft.name.trim();
    if (!PROVIDER_ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      setStatus("Invalid environment variable name");
      return;
    }
    const current = instanceEnvironment(instanceId);
    if (current.some((variable) => variable.name === name)) {
      setStatus("Environment variable already exists");
      return;
    }
    updateInstanceEnvironment(instanceId, [
      ...current,
      {
        name,
        value: draft.value,
        sensitive: draft.sensitive,
      },
    ]);
    setProviderEnvironmentDraftByInstance((currentDrafts) => ({
      ...currentDrafts,
      [instanceId]: EMPTY_PROVIDER_ENVIRONMENT_DRAFT,
    }));
  }

  function removeInstanceEnvVar(instanceId: ProviderInstanceId, name: string) {
    updateInstanceEnvironment(
      instanceId,
      instanceEnvironment(instanceId).filter((variable) => variable.name !== name),
    );
  }

  function updateInstanceEnvVar(
    instanceId: ProviderInstanceId,
    name: string,
    patch: Partial<Pick<ProviderInstanceEnvironmentVariable, "sensitive" | "value">>,
  ) {
    updateInstanceEnvironment(
      instanceId,
      instanceEnvironment(instanceId).map((variable) => {
        if (variable.name !== name) return variable;
        const nextValue = patch.value ?? variable.value;
        const nextSensitive = patch.sensitive ?? variable.sensitive;
        if (patch.value !== undefined) {
          return { name, value: nextValue, sensitive: nextSensitive, valueRedacted: false };
        }
        if (variable.valueRedacted !== undefined) {
          return {
            name,
            value: nextValue,
            sensitive: nextSensitive,
            valueRedacted: variable.valueRedacted,
          };
        }
        return { name, value: nextValue, sensitive: nextSensitive };
      }),
    );
  }

  // Stable identity so ui.tsx can depend on it in memos (e.g. select menu
  // items) without re-computing every render.
  const addInstance = useCallback(
    (driver: InstallProviderKey) => {
      if (!serverSettings) {
        setStatus("Settings loading");
        return;
      }
      const providerSettings: InstallProviderSettings | undefined = INSTALL_PROVIDER_SETTINGS.find(
        (entry) => entry.provider === driver,
      );
      if (!providerSettings) return;
      const { instanceId, patch } = buildDuplicateDefaultProviderInstancePatch({
        settings: serverSettings,
        provider: providerSettings.provider,
        title: providerSettings.title,
      });
      setServerSettings((current) =>
        current
          ? {
              ...current,
              providerInstances: patch.providerInstances ?? current.providerInstances,
            }
          : current,
      );
      updateServerSettings(patch);
      setSelectedInstanceIdState(instanceId);
      // Instance-scoped view state resets on switch so the new instance's
      // content starts unfiltered and collapsed (same as selectInstance).
      setModelPreferencesQuery("");
      setShowAllModelPreferenceRows(false);
      setShowAllCustomModels(false);
      setStatus(`Added ${String(instanceId)}`);
    },
    [serverSettings, setServerSettings, setStatus, updateServerSettings],
  );

  // Global reset of every default instance: drops explicit default entries so
  // settings fall back to the legacy provider config, and resets mirrored app
  // binary paths. Additional instances are untouched.
  function resetProviderInstallSettings() {
    updateAppSettings({
      claudeBinaryPath: DEFAULT_APP_SETTINGS.claudeBinaryPath,
      codexBinaryPath: DEFAULT_APP_SETTINGS.codexBinaryPath,
      codexHomePath: DEFAULT_APP_SETTINGS.codexHomePath,
    });
    const settingsPatch = buildResetDefaultProviderInstancesPatch({
      settings: serverSettings ?? DEFAULT_SERVER_SETTINGS,
      providers: INSTALL_PROVIDER_SETTINGS.map((providerSettings) => providerSettings.provider),
    });
    const providerPatch = settingsPatch.providers as NonNullable<ServerSettingsPatch["providers"]>;
    setServerSettings((current) =>
      current
        ? {
            ...current,
            providers: {
              ...current.providers,
              ...providerPatch,
            } as ServerSettings["providers"],
            providerInstances: settingsPatch.providerInstances ?? current.providerInstances,
          }
        : current,
    );
    updateServerSettings(settingsPatch);
  }

  function removeInstance(instanceId: ProviderInstanceId) {
    if (!serverSettings) {
      setStatus("Settings loading");
      return;
    }
    const settingsPatch = buildDeleteProviderInstancePatch({
      settings: serverSettings,
      instanceId,
    });
    const textGenerationModelSelection =
      currentGitTextGenerationInstanceId === instanceId
        ? DEFAULT_SERVER_SETTINGS.textGenerationModelSelection
        : undefined;
    setServerSettings((current) =>
      current
        ? {
            ...current,
            ...(textGenerationModelSelection ? { textGenerationModelSelection } : {}),
            providerInstances: settingsPatch.providerInstances ?? current.providerInstances,
          }
        : current,
    );
    const nextProviderModelPreferences = { ...appSettings.providerModelPreferences };
    delete nextProviderModelPreferences[instanceId];
    updateAppSettings({
      providerModelPreferences: nextProviderModelPreferences,
      favorites: appSettings.favorites.filter((favorite) => favorite.provider !== instanceId),
      ...(currentGitTextGenerationInstanceId === instanceId
        ? { textGenerationModel: DEFAULT_APP_SETTINGS.textGenerationModel }
        : {}),
    });
    setProviderEnvironmentDraftByInstance((currentDrafts) => {
      const { [instanceId]: _removed, ...rest } = currentDrafts;
      return rest;
    });
    updateServerSettings({
      ...settingsPatch,
      ...(textGenerationModelSelection ? { textGenerationModelSelection } : {}),
    });
    setStatus(`Removed ${String(instanceId)}`);
  }

  const isGitTextGenerationModelDirty =
    currentGitTextGenerationInstanceId !==
      DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId ||
    currentGitTextGenerationModel !== DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model ||
    (serverSettings?.textGenerationModelSelection.options?.length ?? 0) > 0;
  const selectedGitTextGenerationModelOption = gitTextGenerationModelOptions.find(
    (option) => option.slug === currentGitTextGenerationModel,
  );
  const selectedGitTextGenerationModelLabel = selectedGitTextGenerationModelOption
    ? modelMenuDisplayLabel(selectedGitTextGenerationModelOption)
    : currentGitTextGenerationModel;
  const selectedGitTextGenerationProviderLabel = currentGitTextGenerationEntry.displayName;
  function resetGitTextGenerationModel() {
    const textGenerationModelSelection = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection;
    updateAppSettings({ textGenerationModel: DEFAULT_APP_SETTINGS.textGenerationModel });
    setServerSettings((current) =>
      current
        ? {
            ...current,
            textGenerationModelSelection,
          }
        : current,
    );
    updateServerSettings({ textGenerationModelSelection });
  }

  // Model preferences are keyed by the selected instance. Instances without a
  // model-menu entry (disabled or unavailable) expose no models.
  const instanceModelEntry = modelMenuEntryByInstanceId.get(selectedInstanceId) ?? null;
  const instanceModelOptions = instanceModelEntry
    ? sortProviderModelPreferenceOptions(
        rawProviderModelOptionsByInstance.get(instanceModelEntry.instanceId) ?? [],
        appSettings,
        instanceModelEntry.instanceId,
      )
    : [];
  const selectedInstanceModelPreferences = appSettings.providerModelPreferences[
    selectedInstanceId
  ] ?? {
    hiddenModels: [],
    modelOrder: [],
  };
  const instanceModelHiddenModels = new Set(selectedInstanceModelPreferences.hiddenModels);
  const instanceModelFavoriteModels = new Set(
    appSettings.favorites
      .filter((favorite) => favorite.provider === selectedInstanceId)
      .map((favorite) => favorite.model),
  );
  const isModelPreferencesQueryActive = modelPreferencesQuery.trim().length > 0;
  // Filter keeps preference order (no re-rank) so Up/Down stay meaningful.
  const filteredModelPreferenceOptions = instanceModelEntry
    ? instanceModelOptions.filter(
        (option) =>
          scoreModelPickerSearch(
            {
              name: option.name,
              slug: option.slug,
              ...(option.shortName ? { shortName: option.shortName } : {}),
              ...(option.subProvider ? { subProvider: option.subProvider } : {}),
              driverKind: instanceModelEntry.driverKind,
              providerDisplayName: instanceModelEntry.displayName,
            },
            modelPreferencesQuery,
          ) !== null,
      )
    : [];
  const modelPreferenceIndexBySlug = new Map(
    instanceModelOptions.map((option, index) => [option.slug, index] as const),
  );
  const visibleModelPreferenceRows =
    isModelPreferencesQueryActive || showAllModelPreferenceRows
      ? filteredModelPreferenceOptions
      : filteredModelPreferenceOptions.slice(0, MODEL_PREFERENCE_ROWS_COLLAPSED_COUNT);
  const instanceFavoriteModelCount = instanceModelFavoriteModels.size;
  const instanceHiddenModelCount = instanceModelHiddenModels.size;
  const hasInstanceModelSettings =
    instanceFavoriteModelCount > 0 ||
    instanceHiddenModelCount > 0 ||
    selectedInstanceModelPreferences.modelOrder.length > 0;

  function updateProviderModelPreferences(
    instanceId: ProviderInstanceId,
    nextPreferences: {
      readonly hiddenModels: readonly string[];
      readonly modelOrder: readonly string[];
    },
  ) {
    updateAppSettings({
      providerModelPreferences: {
        ...appSettings.providerModelPreferences,
        [instanceId]: {
          hiddenModels: [
            ...new Set(nextPreferences.hiddenModels.filter((slug) => slug.length > 0)),
          ],
          modelOrder: [...new Set(nextPreferences.modelOrder.filter((slug) => slug.length > 0))],
        },
      },
    });
  }

  function updateFavoriteModels(instanceId: ProviderInstanceId, models: readonly string[]) {
    updateAppSettings({
      favorites: [
        ...appSettings.favorites.filter((favorite) => favorite.provider !== instanceId),
        ...[...new Set(models.filter((slug) => slug.length > 0))].map((model) => ({
          provider: instanceId,
          model,
        })),
      ],
    });
  }

  function toggleFavoriteModel(instanceId: ProviderInstanceId, slug: string) {
    const current = appSettings.favorites
      .filter((favorite) => favorite.provider === instanceId)
      .map((favorite) => favorite.model);
    updateFavoriteModels(
      instanceId,
      current.includes(slug) ? current.filter((model) => model !== slug) : [...current, slug],
    );
  }

  function toggleHiddenModel(instanceId: ProviderInstanceId, slug: string) {
    const preferences = appSettings.providerModelPreferences[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    updateProviderModelPreferences(instanceId, {
      ...preferences,
      hiddenModels: preferences.hiddenModels.includes(slug)
        ? preferences.hiddenModels.filter((model) => model !== slug)
        : [...preferences.hiddenModels, slug],
    });
  }

  function moveModelPreference(instanceId: ProviderInstanceId, slug: string, direction: -1 | 1) {
    const currentOrder = sortProviderModelPreferenceOptions(
      rawProviderModelOptionsByInstance.get(instanceId) ?? [],
      appSettings,
      instanceId,
    ).map((option) => option.slug);
    const index = currentOrder.indexOf(slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) {
      return;
    }
    const nextOrder = [...currentOrder];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex]!, nextOrder[index]!];
    const preferences = appSettings.providerModelPreferences[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    updateProviderModelPreferences(instanceId, {
      ...preferences,
      modelOrder: nextOrder,
    });
  }

  function resetInstanceModelPreferences(instanceId: ProviderInstanceId) {
    updateFavoriteModels(instanceId, []);
    updateProviderModelPreferences(instanceId, { hiddenModels: [], modelOrder: [] });
    setShowAllModelPreferenceRows(false);
  }

  // Custom models are stored per driver, so the selected instance's driver
  // decides which list the Custom models subsection edits. Drivers with
  // custom-model support come from MODEL_PROVIDER_SETTINGS so adding a
  // provider there needs no edit here.
  const instanceCustomModelProvider: ProviderKind | null =
    MODEL_PROVIDER_SETTINGS.find((entry) => entry.provider === selectedDriver)?.provider ?? null;
  const instanceCustomModelSlugs = instanceCustomModelProvider
    ? customModelsByProvider[instanceCustomModelProvider]
    : [];
  const hasCustomModels = MODEL_PROVIDER_SETTINGS.some(
    (entry) => customModelsByProvider[entry.provider].length > 0,
  );
  function addCustomModel(provider: ProviderKind) {
    const customModelInput = customModelInputByProvider[provider];
    const customModels = customModelsByProvider[provider];
    const normalized = normalizeModelSlug(customModelInput, provider);
    if (!normalized) {
      setCustomModelErrorByProvider((current) => ({
        ...current,
        [provider]: "Enter a model slug.",
      }));
      return;
    }
    if (getModelOptions(provider).some((option) => option.slug === normalized)) {
      setCustomModelErrorByProvider((current) => ({
        ...current,
        [provider]: "That model is already built in.",
      }));
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setCustomModelErrorByProvider((current) => ({
        ...current,
        [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
      }));
      return;
    }
    if (customModels.includes(normalized)) {
      setCustomModelErrorByProvider((current) => ({
        ...current,
        [provider]: "That custom model is already saved.",
      }));
      return;
    }

    updateProviderCustomModels(provider, [...customModels, normalized]);
    setCustomModelInputByProvider((current) => ({ ...current, [provider]: "" }));
    setCustomModelErrorByProvider((current) => ({ ...current, [provider]: null }));
  }

  function removeCustomModel(provider: ProviderKind, slug: string) {
    const customModels = customModelsByProvider[provider];
    updateProviderCustomModels(
      provider,
      customModels.filter((model) => model !== slug),
    );
    setCustomModelErrorByProvider((current) => ({ ...current, [provider]: null }));
  }

  // Clears every saved custom slug for one driver (app settings and the
  // server-side default instance config).
  function resetInstanceCustomModels(provider: ProviderKind) {
    updateProviderCustomModels(provider, []);
    setCustomModelErrorByProvider((current) => ({ ...current, [provider]: null }));
    setShowAllCustomModels(false);
  }

  function updateProviderCustomModels(provider: ProviderKind, models: readonly string[]) {
    const nextModels = normalizeCustomModelSlugs(models, provider);
    updateAppSettings(patchCustomModels(provider, nextModels));
    if (!serverSettings) {
      setStatus("Settings loading");
      return;
    }
    const settingsPatch = buildDefaultProviderInstanceUpdatePatch({
      settings: serverSettings,
      provider,
      configPatch: { customModels: nextModels },
    });
    const providerPatch = settingsPatch.providers as NonNullable<ServerSettingsPatch["providers"]>;
    setServerSettings((current) =>
      current
        ? {
            ...current,
            providers: {
              ...current.providers,
              ...providerPatch,
            } as ServerSettings["providers"],
            providerInstances: settingsPatch.providerInstances ?? current.providerInstances,
          }
        : current,
    );
    updateServerSettings(settingsPatch);
  }

  function resetTransientState() {
    setSelectedInstanceIdState(null);
    setCustomModelInputByProvider({ codex: "", claudeAgent: "" });
    setCustomModelErrorByProvider({});
    setShowAllCustomModels(false);
    setModelPreferencesQuery("");
    setShowAllModelPreferenceRows(false);
  }

  // Summary badges shown outside this view still need whole-page dirty state.
  const isInstallSettingsDirty = serverSettings
    ? INSTALL_PROVIDER_SETTINGS.some((providerSettings) =>
        isProviderInstallSettingsDirtyForSettings(serverSettings, providerSettings),
      )
    : appSettings.codexBinaryPath !== DEFAULT_APP_SETTINGS.codexBinaryPath ||
      appSettings.codexHomePath !== DEFAULT_APP_SETTINGS.codexHomePath ||
      appSettings.claudeBinaryPath !== DEFAULT_APP_SETTINGS.claudeBinaryPath;
  const hasAnyModelPreferenceSettings =
    Object.values(appSettings.providerModelPreferences).some(
      (preferences) => preferences.hiddenModels.length > 0 || preferences.modelOrder.length > 0,
    ) || appSettings.favorites.length > 0;

  return {
    instanceRows,
    selectedInstanceId,
    selectedRow,
    selectInstance,
    addInstance,
    removeInstance,
    setInstanceEnabled,
    setInstanceDisplayName,
    setInstanceAccentColor,
    setInstanceField,
    instanceMetadataValue,
    instanceFieldValue,
    instanceEnvironment,
    providerEnvironmentDraftByInstance,
    setProviderEnvironmentDraftByInstance,
    addInstanceEnvVar,
    updateInstanceEnvVar,
    removeInstanceEnvVar,
    apiAvailable: api !== null,
    isRefreshingProviders,
    updatingProviderInstanceId,
    refreshProviderSnapshots,
    runProviderUpdate,
    providerSnapshotByInstanceId,
    providerLastCheckedAt,
    isGitTextGenerationModelDirty,
    selectedGitTextGenerationModelLabel,
    selectedGitTextGenerationProviderLabel,
    resetGitTextGenerationModel,
    instanceModelEntry,
    instanceModelOptions,
    instanceModelHiddenModels,
    instanceModelFavoriteModels,
    isModelPreferencesQueryActive,
    filteredModelPreferenceOptions,
    modelPreferenceIndexBySlug,
    visibleModelPreferenceRows,
    instanceFavoriteModelCount,
    instanceHiddenModelCount,
    hasInstanceModelSettings,
    modelPreferencesQuery,
    setModelPreferencesQuery,
    showAllModelPreferenceRows,
    setShowAllModelPreferenceRows,
    toggleFavoriteModel,
    toggleHiddenModel,
    moveModelPreference,
    resetInstanceModelPreferences,
    instanceCustomModelProvider,
    instanceCustomModelSlugs,
    customModelInputByProvider,
    setCustomModelInputByProvider,
    customModelErrorByProvider,
    setCustomModelErrorByProvider,
    showAllCustomModels,
    setShowAllCustomModels,
    addCustomModel,
    removeCustomModel,
    resetInstanceCustomModels,
    hasCustomModels,
    isInstallSettingsDirty,
    resetProviderInstallSettings,
    hasAnyModelPreferenceSettings,
    resetTransientState,
  };
}
