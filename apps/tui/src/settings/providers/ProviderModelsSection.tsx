// Model preferences and custom model slugs for the selected provider
// instance's driver, extracted from ProviderInstanceDetail.
import type { ProviderInstanceId, ProviderKind } from "@termweave/contracts";
import { MODEL_PROVIDER_SETTINGS } from "@termweave/client-core";
import {
  CUSTOM_MODEL_ROWS_COLLAPSED_COUNT,
  MODEL_PREFERENCE_ROWS_COLLAPSED_COUNT,
} from "./providerSettingsModel";
import {
  PALETTE,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  ToolbarButton,
} from "../../uiPrimitives";
import type { ModelMenuOption } from "./providerSettingsModel";
import type { ProviderSettingsState } from "./useProviderSettings";

export function ProviderModelsSection(props: {
  state: ProviderSettingsState;
  driverTitle: string;
}) {
  const { state } = props;
  const instanceId = state.selectedInstanceId;
  const provider = state.instanceCustomModelProvider;
  return (
    <SettingsSection title="Models">
      <SettingsRow
        title="Model preferences"
        description="Customize model picker favorites, hidden models, and order for this instance."
        status={
          state.hasInstanceModelSettings
            ? `${state.instanceFavoriteModelCount} favorite · ${state.instanceHiddenModelCount} hidden`
            : `${state.instanceModelOptions.length} available`
        }
        resetAction={
          state.hasInstanceModelSettings ? (
            <SettingResetButton onPress={() => state.resetInstanceModelPreferences(instanceId)} />
          ) : null
        }
      >
        <box
          style={{
            backgroundColor: PALETTE.input,
            paddingLeft: 1,
            paddingRight: 1,
            height: 3,
            justifyContent: "center",
            marginBottom: 1,
          }}
        >
          <input
            value={state.modelPreferencesQuery}
            onInput={state.setModelPreferencesQuery}
            placeholder="Filter models..."
            cursorColor={PALETTE.cursor}
            style={{
              backgroundColor: PALETTE.input,
              focusedBackgroundColor: PALETTE.input,
              textColor: PALETTE.text,
              focusedTextColor: PALETTE.text,
              placeholderColor: PALETTE.subtle,
            }}
          />
        </box>
        {state.visibleModelPreferenceRows.map((model) => (
          <ModelPreferenceRow
            key={`${instanceId}:${model.slug}`}
            model={model}
            state={state}
            instanceId={instanceId}
          />
        ))}
        {state.isModelPreferencesQueryActive &&
        state.filteredModelPreferenceOptions.length === 0 ? (
          <text content="No models match." style={{ fg: PALETTE.subtle }} />
        ) : null}
        {!state.isModelPreferencesQueryActive &&
        state.instanceModelOptions.length > MODEL_PREFERENCE_ROWS_COLLAPSED_COUNT ? (
          <ToolbarButton
            label={state.showAllModelPreferenceRows ? "Show less" : "Show more"}
            onPress={() => state.setShowAllModelPreferenceRows((current) => !current)}
          />
        ) : null}
      </SettingsRow>
      {provider ? (
        <ProviderCustomModelsRow
          state={state}
          provider={provider}
          driverTitle={props.driverTitle}
        />
      ) : null}
    </SettingsSection>
  );
}

// One model row: Star / Up / Down / Hide controls over the ordered options.
function ModelPreferenceRow(props: {
  model: ModelMenuOption;
  state: ProviderSettingsState;
  instanceId: ProviderInstanceId;
}) {
  const { model, state, instanceId } = props;
  const isFavorite = state.instanceModelFavoriteModels.has(model.slug);
  const isHidden = !model.isCustom && state.instanceModelHiddenModels.has(model.slug);
  // Neighbours come from full list; rows may be filtered.
  const index = state.modelPreferenceIndexBySlug.get(model.slug)!;
  const previousModel = state.instanceModelOptions[index - 1];
  const nextModel = state.instanceModelOptions[index + 1];
  const canMoveUp =
    previousModel !== undefined &&
    state.instanceModelFavoriteModels.has(previousModel.slug) === isFavorite;
  const canMoveDown =
    nextModel !== undefined && state.instanceModelFavoriteModels.has(nextModel.slug) === isFavorite;
  return (
    <box
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: PALETTE.surfaceAlt,
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
      }}
    >
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1 }}>
        <text
          content={`${isFavorite ? "* " : ""}${model.name}${model.isCustom ? " · custom" : isHidden ? " · hidden" : ""}`}
          style={{ fg: isHidden ? PALETTE.subtle : PALETTE.text }}
        />
        {model.name !== model.slug ? (
          <text content={model.slug} style={{ fg: PALETTE.subtle }} />
        ) : null}
      </box>
      <box style={{ flexDirection: "row", alignItems: "center" }}>
        <ToolbarButton
          label={isFavorite ? "Unstar" : "Star"}
          onPress={() => state.toggleFavoriteModel(instanceId, model.slug)}
        />
        <ToolbarButton
          label="Up"
          disabled={!canMoveUp}
          onPress={() => state.moveModelPreference(instanceId, model.slug, -1)}
        />
        <ToolbarButton
          label="Down"
          disabled={!canMoveDown}
          onPress={() => state.moveModelPreference(instanceId, model.slug, 1)}
        />
        {!model.isCustom ? (
          <ToolbarButton
            label={isHidden ? "Show" : "Hide"}
            onPress={() => state.toggleHiddenModel(instanceId, model.slug)}
          />
        ) : null}
      </box>
    </box>
  );
}

// Custom model slugs are stored per driver and shared by all its instances.
function ProviderCustomModelsRow(props: {
  state: ProviderSettingsState;
  provider: ProviderKind;
  driverTitle: string;
}) {
  const { state, provider } = props;
  const savedSlugs = state.instanceCustomModelSlugs;
  const visibleSlugs = state.showAllCustomModels
    ? savedSlugs
    : savedSlugs.slice(0, CUSTOM_MODEL_ROWS_COLLAPSED_COUNT);
  const inputError = state.customModelErrorByProvider[provider] ?? null;
  return (
    <SettingsRow
      title="Custom models"
      description={`Shared by all ${props.driverTitle} instances.`}
      status={savedSlugs.length > 0 ? `${savedSlugs.length} saved model slug(s)` : null}
    >
      <box
        style={{
          backgroundColor: PALETTE.input,
          paddingLeft: 1,
          paddingRight: 1,
          height: 3,
          justifyContent: "center",
          marginBottom: 1,
        }}
      >
        <input
          value={state.customModelInputByProvider[provider]}
          onInput={(value) => {
            state.setCustomModelInputByProvider((current) => ({
              ...current,
              [provider]: value,
            }));
            state.setCustomModelErrorByProvider((current) => ({
              ...current,
              [provider]: null,
            }));
          }}
          onKeyDown={(key) => {
            if (
              key.name === "return" ||
              key.name === "enter" ||
              key.name === "kpenter" ||
              key.name === "linefeed"
            ) {
              key.preventDefault();
              state.addCustomModel(provider);
            }
          }}
          placeholder={
            MODEL_PROVIDER_SETTINGS.find((entry) => entry.provider === provider)?.example ||
            "custom/model-slug"
          }
          cursorColor={PALETTE.cursor}
          style={{
            backgroundColor: PALETTE.input,
            focusedBackgroundColor: PALETTE.input,
            textColor: PALETTE.text,
            focusedTextColor: PALETTE.text,
            placeholderColor: PALETTE.subtle,
          }}
        />
      </box>
      <box style={{ flexDirection: "row", alignItems: "center", marginBottom: 1 }}>
        <ToolbarButton label="Add" onPress={() => state.addCustomModel(provider)} />
        {savedSlugs.length > 0 ? (
          <ToolbarButton label="Reset" onPress={() => state.resetInstanceCustomModels(provider)} />
        ) : null}
      </box>
      {inputError ? (
        <text content={inputError} style={{ fg: PALETTE.warning, marginBottom: 1 }} />
      ) : null}
      {visibleSlugs.map((slug) => (
        <box
          key={`${provider}:${slug}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            backgroundColor: PALETTE.surfaceAlt,
            paddingLeft: 1,
            paddingRight: 1,
            marginBottom: 1,
          }}
        >
          <text content={slug} style={{ fg: PALETTE.text }} />
          <ToolbarButton label="Remove" onPress={() => state.removeCustomModel(provider, slug)} />
        </box>
      ))}
      {savedSlugs.length > CUSTOM_MODEL_ROWS_COLLAPSED_COUNT ? (
        <ToolbarButton
          label={state.showAllCustomModels ? "Show less" : "Show more"}
          onPress={() => state.setShowAllCustomModels((current) => !current)}
        />
      ) : null}
    </SettingsRow>
  );
}
