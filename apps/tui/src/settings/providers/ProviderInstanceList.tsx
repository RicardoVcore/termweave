// Left column of Settings > Providers: one row per provider instance plus the
// "+ Add instance" entry point that opens the settings select menu.
import type { ProviderInstanceId } from "@termweave/contracts";
import { PALETTE, SidebarMouseEvent, TogglePill, providerPickerIcon } from "../../uiPrimitives";
import { truncateTitleForDisplay } from "../../threadTitle";
import type { ProviderInstanceRow } from "./providerSettingsModel";

const INSTANCE_NAME_MAX_LENGTH = 14;

export function ProviderInstanceList(props: {
  rows: ReadonlyArray<ProviderInstanceRow>;
  selectedInstanceId: ProviderInstanceId;
  onSelectInstance: (instanceId: ProviderInstanceId) => void;
  onToggleEnabled: (instanceId: ProviderInstanceId, enabled: boolean) => void;
  onAddInstance: (event?: SidebarMouseEvent) => void;
}) {
  return (
    <box style={{ flexDirection: "column" }}>
      {props.rows.map((row) => (
        <ProviderInstanceRowItem
          key={row.id}
          row={row}
          selected={row.id === props.selectedInstanceId}
          onSelect={() => props.onSelectInstance(row.id)}
          onToggleEnabled={() => props.onToggleEnabled(row.id, !row.enabled)}
        />
      ))}
      <AddInstanceRow onPress={props.onAddInstance} />
    </box>
  );
}

// One selectable instance row: icon, display name, short status, enabled pill.
function ProviderInstanceRowItem(props: {
  row: ProviderInstanceRow;
  selected: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
}) {
  const { row, selected } = props;
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onSelect();
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 1,
        minHeight: 1,
        backgroundColor: selected ? PALETTE.surfaceAlt : "transparent",
      }}
    >
      <text
        content={providerPickerIcon(row.driver)}
        style={{ fg: row.accentColor ?? PALETTE.muted, marginRight: 1 }}
      />
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1 }}>
        <text
          content={truncateTitleForDisplay(row.displayName, INSTANCE_NAME_MAX_LENGTH)}
          style={{ fg: selected ? PALETTE.text : PALETTE.subtle }}
        />
      </box>
      <text content={row.statusText} style={{ fg: PALETTE.subtle, marginRight: 1 }} />
      <TogglePill checked={row.enabled} onPress={props.onToggleEnabled} />
    </box>
  );
}

function AddInstanceRow(props: { onPress: (event?: SidebarMouseEvent) => void }) {
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onPress(event);
      }}
      style={{ flexDirection: "row", alignItems: "center", paddingLeft: 1, minHeight: 1 }}
    >
      <text content="+ Add instance" style={{ fg: PALETTE.muted }} />
    </box>
  );
}
