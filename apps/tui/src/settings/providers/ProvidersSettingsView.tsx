// Settings > Providers: instance list beside/below the selected instance's
// detail, plus the shared text generation model row. Mouse-driven like the
// rest of Settings.
import { formatCheckedRelativeTime } from "../../timeFormatting";
import {
  PALETTE,
  SettingResetButton,
  SettingsRow,
  SidebarMouseEvent,
  ToolbarButton,
} from "../../uiPrimitives";
import { ProviderInstanceDetail } from "./ProviderInstanceDetail";
import { ProviderInstanceList } from "./ProviderInstanceList";
import type { ProviderSettingsState } from "./useProviderSettings";

const PROVIDERS_SIDE_BY_SIDE_MIN_COLUMNS = 96;
const PROVIDERS_LIST_WIDTH = 30;

// Select menu kinds this view can open; ui.tsx owns the menu items.
export type ProviderSettingsSelectKind =
  | "git-model-provider"
  | "git-model"
  | "provider-instance-add";

export function ProvidersSettingsView(props: {
  columns: number;
  state: ProviderSettingsState;
  // Kind currently shown in the open settings select menu, else null.
  activeSelectKind: string | null;
  onOpenSelectMenu: (kind: ProviderSettingsSelectKind, event?: SidebarMouseEvent) => void;
}) {
  const { state } = props;
  const sideBySide = props.columns >= PROVIDERS_SIDE_BY_SIDE_MIN_COLUMNS;
  const selectedRow =
    state.instanceRows.find((row) => row.id === state.selectedInstanceId) ?? state.instanceRows[0]!;
  return (
    <box style={{ flexDirection: "column" }}>
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 1,
        }}
      >
        <text content="Providers" style={{ fg: PALETTE.text }} />
        <box style={{ flexDirection: "row", alignItems: "center" }}>
          {state.isInstallSettingsDirty ? (
            <ToolbarButton
              label="Reset"
              disabled={!state.apiAvailable}
              onPress={state.resetProviderInstallSettings}
            />
          ) : null}
          <ToolbarButton
            label={state.isRefreshingProviders ? "Refreshing..." : "Refresh"}
            disabled={!state.apiAvailable || state.isRefreshingProviders}
            onPress={() => {
              void state.refreshProviderSnapshots();
            }}
          />
          <text
            content={
              state.providerLastCheckedAt
                ? formatCheckedRelativeTime(state.providerLastCheckedAt)
                : "Never checked"
            }
            style={{ fg: PALETTE.subtle }}
          />
        </box>
      </box>
      <box style={sideBySide ? { flexDirection: "row" } : { flexDirection: "column" }}>
        <box
          style={sideBySide ? { width: PROVIDERS_LIST_WIDTH, flexShrink: 0 } : { flexShrink: 0 }}
        >
          <ProviderInstanceList
            rows={state.instanceRows}
            selectedInstanceId={selectedRow.id}
            onSelectInstance={state.selectInstance}
            onToggleEnabled={state.setInstanceEnabled}
            onAddInstance={(event) => props.onOpenSelectMenu("provider-instance-add", event)}
          />
        </box>
        {sideBySide ? <box style={{ width: 1, backgroundColor: PALETTE.border }} /> : null}
        <ProviderInstanceDetail row={selectedRow} state={state} />
      </box>
      <TextGenerationModelRow
        state={state}
        activeSelectKind={props.activeSelectKind}
        onOpenSelectMenu={props.onOpenSelectMenu}
      />
    </box>
  );
}

// Shared text generation model dropdowns, unchanged from the old Models page.
function TextGenerationModelRow(props: {
  state: ProviderSettingsState;
  activeSelectKind: string | null;
  onOpenSelectMenu: (kind: "git-model-provider" | "git-model", event?: SidebarMouseEvent) => void;
}) {
  const { state } = props;
  return (
    <SettingsRow
      title="Text generation model"
      description="Used for generated commit messages, PR titles, and branch names."
      resetAction={
        state.isGitTextGenerationModelDirty ? (
          <SettingResetButton onPress={state.resetGitTextGenerationModel} />
        ) : null
      }
      control={
        <box style={{ flexDirection: "row", alignItems: "center" }}>
          <ToolbarButton
            label={`${state.selectedGitTextGenerationProviderLabel} ▾`}
            surface="inset"
            active={props.activeSelectKind === "git-model-provider"}
            onPress={(event) => props.onOpenSelectMenu("git-model-provider", event)}
          />
          <ToolbarButton
            label={`${state.selectedGitTextGenerationModelLabel} ▾`}
            surface="inset"
            active={props.activeSelectKind === "git-model"}
            onPress={(event) => props.onOpenSelectMenu("git-model", event)}
          />
        </box>
      }
    />
  );
}
