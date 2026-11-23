// Shared TUI primitives: live theme palette plus small reusable controls
// (toolbar buttons, toggles, settings sections/rows) consumed by ui.tsx.
import { useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_TUI_THEME, type TuiColor, type TuiPalette, type TuiTheme } from "./theme";

export type SidebarMouseEvent = {
  button?: number;
  x?: number;
  y?: number;
  modifiers?: {
    shift?: boolean;
    ctrl?: boolean;
    alt?: boolean;
  };
  preventDefault: () => void;
  stopPropagation?: () => void;
};

export const PALETTE: TuiPalette = { ...DEFAULT_TUI_THEME.palette };
export let ACTIVE_TUI_THEME = DEFAULT_TUI_THEME;

export function setActiveTuiTheme(theme: TuiTheme): void {
  ACTIVE_TUI_THEME = theme;
}

export function ToolbarButton(props: {
  icon?: string;
  label?: string | undefined;
  active?: boolean;
  disabled?: boolean;
  iconColor?: TuiColor;
  marginRight?: number;
  compact?: boolean;
  surface?: "default" | "inset";
  chrome?: "default" | "bare";
  width?: number;
  justifyContent?: "center" | "flex-start" | "flex-end";
  onPress: (event?: SidebarMouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const foreground = props.disabled ? PALETTE.subtle : props.active ? PALETTE.text : PALETTE.muted;
  const isBare = props.chrome === "bare";
  const restingBackground = props.surface === "inset" ? PALETTE.controlInset : PALETTE.control;
  const disabledBackground = props.surface === "inset" ? PALETTE.controlInset : PALETTE.control;
  const background = isBare
    ? "transparent"
    : props.active
      ? PALETTE.controlActive
      : props.disabled
        ? disabledBackground
        : hovered
          ? props.surface === "inset"
            ? PALETTE.controlInsetHover
            : PALETTE.controlHover
          : restingBackground;

  return (
    <box
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        if (props.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        props.onPress(event);
      }}
      style={{
        backgroundColor: background,
        paddingLeft: isBare ? 1 : 1,
        paddingRight: isBare ? 1 : 1,
        marginRight: isBare ? 0 : (props.marginRight ?? 1),
        minHeight: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: props.justifyContent ?? "center",
        flexShrink: 0,
        ...(isBare
          ? props.label
            ? {}
            : { width: props.width ?? 3 }
          : props.label
            ? {}
            : props.compact
              ? { width: props.width ?? 3, paddingLeft: 0, paddingRight: 0 }
              : { width: props.width ?? 4 }),
      }}
    >
      {props.icon ? (
        <text
          content={props.icon}
          style={{ fg: props.iconColor ?? foreground, marginRight: props.label ? 1 : 0 }}
        />
      ) : null}
      {props.label ? <text content={props.label} style={{ fg: foreground }} /> : null}
    </box>
  );
}

export function TogglePill(props: { checked: boolean; onPress: () => void; disabled?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const background = props.disabled
    ? PALETTE.controlActive
    : props.checked
      ? hovered
        ? PALETTE.composerSendHover
        : PALETTE.composerSend
      : hovered
        ? PALETTE.controlHover
        : PALETTE.controlActive;
  const knobColor = props.disabled ? PALETTE.subtle : ACTIVE_TUI_THEME.colors.controlKnob;
  const edgeColor = background;

  return (
    <box
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        if (props.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        props.onPress();
      }}
      style={{
        width: 4,
        height: 1,
        backgroundColor: background,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <text content="▐" style={{ fg: edgeColor }} />
      <text content={props.checked ? " " : "■"} style={{ fg: knobColor }} />
      <text content={props.checked ? "■" : " "} style={{ fg: knobColor }} />
      <text content="▌" style={{ fg: edgeColor }} />
    </box>
  );
}

// Icons shown next to provider names across pickers and settings lists.
export function providerPickerIcon(provider: string): string {
  if (provider === "claudeAgent") return "✱";
  if (provider === "cursor") return "⌖";
  if (provider === "opencode") return "⌘";
  if (provider === "githubCopilot") return "";
  if (provider === "gemini") return "◇";
  if (provider === "acpRegistry") return "󰕮";
  if (provider === "pi") return "π";
  return "󰚩";
}

export function SettingsSection(props: { title: string; children: ReactNode }) {
  return (
    <box style={{ flexDirection: "column", marginBottom: 2 }}>
      <text content={props.title} style={{ fg: PALETTE.subtle, marginBottom: 1 }} />
      <box style={{ flexDirection: "column" }}>{props.children}</box>
    </box>
  );
}

export function SettingsRow(props: {
  title: string;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <box
      style={{
        flexDirection: "column",
        border: ["top"],
        borderColor: PALETTE.border,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 1,
        }}
      >
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1 }}>
          <box style={{ flexDirection: "row", alignItems: "center" }}>
            <text content={props.title} style={{ fg: PALETTE.text, marginRight: 1 }} />
            {props.resetAction ? props.resetAction : null}
          </box>
          <text content={props.description} style={{ fg: PALETTE.muted }} />
          {props.status ? (
            typeof props.status === "string" ? (
              <text content={props.status} style={{ fg: PALETTE.subtle }} />
            ) : (
              <box style={{ flexDirection: "column" }}>{props.status}</box>
            )
          ) : null}
        </box>
        {props.control ? (
          <box
            style={{
              marginLeft: 1,
              flexShrink: 0,
              alignSelf: "flex-start",
            }}
          >
            {props.control}
          </box>
        ) : null}
      </box>
      {props.children ? (
        <box style={{ flexDirection: "column", marginTop: 1 }}>{props.children}</box>
      ) : null}
    </box>
  );
}

export function SettingResetButton(props: { onPress: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <box
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onPress();
      }}
      style={{
        width: 3,
        height: 1,
        backgroundColor: hovered ? PALETTE.controlHover : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <text content="↺" style={{ fg: PALETTE.muted }} />
    </box>
  );
}
