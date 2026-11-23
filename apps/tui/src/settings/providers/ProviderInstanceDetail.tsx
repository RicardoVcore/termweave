// Right column of Settings > Providers: everything about the selected
// provider instance - header, status, name, runtime, environment, models.
import type { ProviderInstanceEnvironmentVariable, ProviderInstanceId } from "@termweave/contracts";
import {
  EMPTY_PROVIDER_ENVIRONMENT_DRAFT,
  type ProviderEnvironmentDraft,
  type ProviderInstanceRow,
} from "./providerSettingsModel";
import { INSTALL_PROVIDER_SETTINGS } from "../../providerSettings";
import {
  canRunProviderUpdate,
  formatProviderVersionStatus,
  isProviderUpdateActive,
  providerUpdateButtonLabel,
} from "../../providerUpdateStatus";
import {
  PALETTE,
  SettingsRow,
  SettingsSection,
  ToolbarButton,
  TogglePill,
} from "../../uiPrimitives";
import { ProviderModelsSection } from "./ProviderModelsSection";
import type { ProviderSettingsState } from "./useProviderSettings";

export function ProviderInstanceDetail(props: {
  row: ProviderInstanceRow;
  state: ProviderSettingsState;
}) {
  const { row, state } = props;
  const snapshot = state.providerSnapshotByInstanceId.get(row.id);
  const fields =
    INSTALL_PROVIDER_SETTINGS.find((entry) => entry.provider === row.driver)?.fields ?? [];
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1 }}>
      <SettingsSection title={row.title}>
        <SettingsRow
          title={row.displayName}
          description={
            row.isDefault
              ? `Default ${row.title} instance${row.badgeLabel ? ` · ${row.badgeLabel}` : ""}`
              : `Additional ${row.title} instance`
          }
          status={formatProviderVersionStatus(snapshot) ?? "Not checked yet."}
          control={
            <box style={{ flexDirection: "row", alignItems: "center" }}>
              {snapshot?.versionAdvisory?.canUpdate ? (
                <ToolbarButton
                  label={providerUpdateButtonLabel(snapshot)}
                  disabled={
                    !state.apiAvailable ||
                    !canRunProviderUpdate(snapshot) ||
                    isProviderUpdateActive(snapshot) ||
                    state.updatingProviderInstanceId === row.id
                  }
                  onPress={() => {
                    if (snapshot) void state.runProviderUpdate(snapshot);
                  }}
                />
              ) : null}
              {!row.isDefault ? (
                <ToolbarButton label="Remove" onPress={() => state.removeInstance(row.id)} />
              ) : null}
            </box>
          }
        />
        <SettingsRow
          title="Name"
          description="Optional label and accent color shown in provider and model pickers."
        >
          <InstanceMetadataInput
            label="Display name"
            value={state.instanceMetadataValue(row.id, "displayName")}
            placeholder={row.title}
            onInput={(value) => state.setInstanceDisplayName(row.id, value)}
          />
          <InstanceMetadataInput
            label="Accent color"
            hint="Use a six-digit hex color such as #7c3aed."
            value={state.instanceMetadataValue(row.id, "accentColor")}
            placeholder="#7c3aed"
            onInput={(value) => state.setInstanceAccentColor(row.id, value)}
          />
        </SettingsRow>
        <SettingsRow title="Runtime" description="Override the CLI used for this instance.">
          {fields.map((field) => (
            <InstanceMetadataInput
              key={`${row.id}:${field.key}`}
              label={field.label}
              hint={field.description}
              value={state.instanceFieldValue(row.id, field.key)}
              placeholder={field.placeholder}
              onInput={(value) => state.setInstanceField(row.id, field.key, value)}
            />
          ))}
        </SettingsRow>
        <InstanceEnvironmentRow row={row} state={state} />
      </SettingsSection>
      {state.instanceModelEntry ? (
        <ProviderModelsSection state={state} driverTitle={row.title} />
      ) : (
        <text
          content="Enable and refresh this instance to manage its models."
          style={{ fg: PALETTE.subtle, marginBottom: 1 }}
        />
      )}
    </box>
  );
}

// Small labeled input used by the Name and Runtime rows.
function InstanceMetadataInput(props: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  onInput: (value: string) => void;
}) {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <text content={props.label} style={{ fg: PALETTE.text, marginBottom: 1 }} />
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
          value={props.value}
          onInput={props.onInput}
          placeholder={props.placeholder}
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
      {props.hint ? <text content={props.hint} style={{ fg: PALETTE.subtle }} /> : null}
    </box>
  );
}

// Saved environment variables plus a draft row to add another one.
function InstanceEnvironmentRow(props: { row: ProviderInstanceRow; state: ProviderSettingsState }) {
  const { row, state } = props;
  const variables = state.instanceEnvironment(row.id);
  return (
    <SettingsRow
      title="Environment"
      description="Add API keys, base URLs, or other per-instance CLI settings. Sensitive values are stored separately after saving."
    >
      {variables.length === 0 ? (
        <text
          content="No environment variables yet."
          style={{ fg: PALETTE.subtle, marginBottom: 1 }}
        />
      ) : (
        variables.map((variable) => (
          <EnvironmentVariableRow
            key={`${row.id}:env:${variable.name}`}
            variable={variable}
            state={state}
            instanceId={row.id}
          />
        ))
      )}
      <EnvironmentDraftRow state={state} instanceId={row.id} />
    </SettingsRow>
  );
}

function EnvironmentVariableRow(props: {
  variable: ProviderInstanceEnvironmentVariable;
  state: ProviderSettingsState;
  instanceId: ProviderInstanceId;
}) {
  const { variable, state, instanceId } = props;
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
          content={`${variable.name}${variable.sensitive ? " · sensitive" : ""}`}
          style={{ fg: PALETTE.text }}
        />
        <text
          content={
            variable.valueRedacted
              ? "stored secret"
              : variable.value
                ? variable.sensitive
                  ? "value hidden"
                  : variable.value
                : "empty value"
          }
          style={{ fg: PALETTE.subtle }}
        />
      </box>
      <box style={{ flexDirection: "row", alignItems: "center" }}>
        <ToolbarButton
          label={variable.sensitive ? "Public" : "Sensitive"}
          onPress={() =>
            state.updateInstanceEnvVar(instanceId, variable.name, {
              sensitive: !variable.sensitive,
            })
          }
        />
        <ToolbarButton
          label="Remove"
          onPress={() => state.removeInstanceEnvVar(instanceId, variable.name)}
        />
      </box>
    </box>
  );
}

function EnvironmentDraftRow(props: {
  state: ProviderSettingsState;
  instanceId: ProviderInstanceId;
}) {
  const { state, instanceId } = props;
  const draft =
    state.providerEnvironmentDraftByInstance[instanceId] ?? EMPTY_PROVIDER_ENVIRONMENT_DRAFT;
  function updateDraft(patch: Partial<ProviderEnvironmentDraft>) {
    state.setProviderEnvironmentDraftByInstance((current) => ({
      ...current,
      [instanceId]: { ...(current[instanceId] ?? EMPTY_PROVIDER_ENVIRONMENT_DRAFT), ...patch },
    }));
  }
  return (
    <box
      style={{
        flexDirection: "column",
        backgroundColor: PALETTE.surfaceAlt,
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
      }}
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
          value={draft.name}
          onInput={(value) => updateDraft({ name: value })}
          placeholder="VARIABLE_NAME"
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
          value={draft.value}
          onInput={(value) => updateDraft({ value })}
          placeholder="Value"
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
      <box style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <box style={{ flexDirection: "row", alignItems: "center" }}>
          <ToolbarButton label="Add" onPress={() => state.addInstanceEnvVar(instanceId)} />
          <text
            content={draft.sensitive ? "Sensitive value" : "Public value"}
            style={{ fg: PALETTE.subtle }}
          />
        </box>
        <TogglePill
          checked={draft.sensitive}
          onPress={() => updateDraft({ sensitive: !draft.sensitive })}
        />
      </box>
      <text
        content="Sensitive values are stored separately after saving."
        style={{ fg: PALETTE.subtle }}
      />
    </box>
  );
}
