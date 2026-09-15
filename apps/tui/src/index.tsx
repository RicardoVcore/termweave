import fs from "node:fs/promises";
import path from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import React from "react";
import { DEFAULT_APP_THEME } from "@termweave/client-core";
import { resolveTuiPaths } from "./config";
import { readPrefs } from "./prefs";
import {
  normalizeRendererThemeMode,
  resolveTerminalPalette,
  shouldResolveTerminalPalette,
  shouldTrackSystemThemeMode,
} from "./rendererTheme";
import { normalizeTuiThemeId, resolveTerminalThemeMode, resolveTuiTheme } from "./theme";
import { App } from "./ui";
import { resolveServerAuthToken } from "./serverSupervisor";
import {
  assertKnownAttachCommand,
  buildDirectAttachServerConnection,
  buildSshAttachServerConnection,
  parseDirectAttachCommand,
  startSshAttach,
} from "./tuiCli";

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function terminalIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return [env.TERM_PROGRAM, env.TERM, env.COLORTERM].filter(Boolean).join(" ").toLowerCase();
}

function shouldUseKittyKeyboard(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = readBooleanEnv(env.T1CODE_USE_KITTY_KEYBOARD);
  if (forced !== undefined) return forced;
  const identity = terminalIdentity(env);
  return ["ghostty", "kitty", "wezterm", "iterm"].some((token) => identity.includes(token));
}

function shouldUseAlternateScreen(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.T1CODE_USE_ALTERNATE_SCREEN) ?? true;
}

function shouldUseMouse(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.T1CODE_USE_MOUSE) ?? true;
}

function shouldEnableMouseMovement(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env.T1CODE_ENABLE_MOUSE_MOVEMENT) ?? false;
}

const sshStartup = new AbortController();
let sshAttach: Awaited<ReturnType<typeof startSshAttach>> = null;
let destroyUi: (() => void) | null = null;
let requestInterrupt: (() => void) | null = null;
let shuttingDown = false;

const stopSshAttach = () => {
  sshStartup.abort(new Error("SSH tunnel startup cancelled."));
  sshAttach?.stop();
  sshAttach = null;
};
const onSigint = () => (requestInterrupt ? requestInterrupt() : shutdown(0));
const onSigterm = () => shutdown(0);
const removeProcessCleanup = () => {
  stopSshAttach();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("exit", stopSshAttach);
};
const shutdown = (code = 0, error?: unknown) => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopSshAttach();
  try {
    destroyUi?.();
  } catch {}
  if (error) {
    process.stderr.write(
      `t1 tui shutdown after error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = code || 1;
  } else {
    process.exitCode = code;
  }
  setTimeout(() => process.exit(process.exitCode ?? code), 50).unref();
};

process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.once("exit", stopSshAttach);
const cliArgs = process.argv.slice(2);
assertKnownAttachCommand(cliArgs);
const directTarget = parseDirectAttachCommand(cliArgs);
if (!directTarget) {
  sshAttach = await startSshAttach(cliArgs, { signal: sshStartup.signal }).catch(
    (error: unknown) => {
      if (!shuttingDown) throw error;
      return null;
    },
  );
}
if (shuttingDown) await new Promise<never>(() => {});
const sshAuthToken = resolveServerAuthToken();
const initialServerConnection = directTarget
  ? buildDirectAttachServerConnection(directTarget, sshAuthToken)
  : sshAttach
    ? buildSshAttachServerConnection(sshAttach, sshAuthToken)
    : undefined;
const initialServerConnectionProps = initialServerConnection ? { initialServerConnection } : {};

if (process.env.T1CODE_HEADLESS === "1") {
  const paths = resolveTuiPaths();
  const outputPath =
    process.env.T1CODE_HEADLESS_FRAME_PATH?.trim() ||
    path.join(paths.configHomeDir, "headless-frame.txt");
  const timeoutMs = Number(process.env.T1CODE_HEADLESS_TIMEOUT_MS ?? 1_500);
  const width = Number(process.env.T1CODE_HEADLESS_WIDTH ?? 160);
  const height = Number(process.env.T1CODE_HEADLESS_HEIGHT ?? 48);
  const testSetup = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
  });
  let unmountRoot: (() => void) | null = null;
  destroyUi = () => {
    try {
      unmountRoot?.();
    } catch {}
    try {
      testSetup.renderer.destroy();
    } catch {}
  };
  testSetup.renderer.once("destroy", removeProcessCleanup);
  const root = createRoot(testSetup.renderer);
  unmountRoot = () => root.unmount();
  root.render(<App renderer={testSetup.renderer} {...initialServerConnectionProps} />);

  setTimeout(() => {
    void (async () => {
      await testSetup.renderOnce();
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, testSetup.captureCharFrame(), "utf8");
      process.stdout.write(`Headless frame written to ${outputPath}\n`);
      shutdown(0);
    })();
  }, timeoutMs);
} else {
  let interruptRequestToken = 0;
  const paths = resolveTuiPaths();
  const prefs = await readPrefs(paths);
  const appTheme = prefs.appSettings?.theme ?? DEFAULT_APP_THEME;
  const tuiThemeId = normalizeTuiThemeId(prefs.tuiThemeId);
  const tracksSystemThemeMode = shouldTrackSystemThemeMode(appTheme);
  const usesTerminalPalette = shouldResolveTerminalPalette(tuiThemeId);
  const shouldDeferInitialBackground = tracksSystemThemeMode || usesTerminalPalette;
  const initialTheme = resolveTuiTheme(appTheme, tuiThemeId);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: shouldUseAlternateScreen() ? "alternate-screen" : "main-screen",
    useMouse: shouldUseMouse(),
    enableMouseMovement: shouldEnableMouseMovement(),
    useKittyKeyboard: shouldUseKittyKeyboard() ? { events: true } : null,
    ...(!shouldDeferInitialBackground ? { backgroundColor: initialTheme.palette.canvas } : {}),
  });
  let unmountRoot: (() => void) | null = null;
  destroyUi = () => {
    try {
      unmountRoot?.();
    } catch {}
    try {
      renderer.destroy();
    } catch {}
  };
  renderer.once("destroy", removeProcessCleanup);
  const initialRendererThemeMode = normalizeRendererThemeMode(renderer.themeMode);
  const detectedTerminalPalette = usesTerminalPalette
    ? await resolveTerminalPalette(renderer, { clearCache: true })
    : { colors: null, durationMs: 0 };
  const initialSystemThemeMode =
    resolveTerminalThemeMode(detectedTerminalPalette.colors) ?? initialRendererThemeMode;
  const rendererTheme = resolveTuiTheme(appTheme, tuiThemeId, {
    systemMode: initialSystemThemeMode,
    terminalColors: detectedTerminalPalette.colors,
  });
  renderer.setBackgroundColor?.(rendererTheme.palette.canvas);
  const root = createRoot(renderer);
  unmountRoot = () => root.unmount();

  const renderApp = () => {
    root.render(
      <App
        renderer={renderer}
        interruptRequestToken={interruptRequestToken}
        onRequestExit={() => shutdown(0)}
        initialTuiThemeId={tuiThemeId}
        initialSystemThemeMode={initialSystemThemeMode}
        initialTerminalThemeColors={detectedTerminalPalette.colors}
        {...initialServerConnectionProps}
        {...(prefs.appSettings ? { initialAppSettings: prefs.appSettings } : {})}
      />,
    );
  };

  const signalHandlers = [
    ["SIGHUP", () => shutdown(0)],
    ["uncaughtException", (error: unknown) => shutdown(1, error)],
    ["unhandledRejection", (error: unknown) => shutdown(1, error)],
  ] as const;

  for (const [event, handler] of signalHandlers) {
    process.on(event, handler);
  }

  renderer.once("destroy", () => {
    for (const [event, handler] of signalHandlers) {
      process.off(event, handler);
    }
  });

  requestInterrupt = () => {
    interruptRequestToken += 1;
    renderApp();
  };
  renderApp();
}
