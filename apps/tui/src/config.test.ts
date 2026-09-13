import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import { resolveTuiPaths } from "./config";

describe("resolveTuiPaths", () => {
  it("prefers TUI-specific paths", () => {
    const paths = resolveTuiPaths({
      T1CODE_HOME: "/tmp/t1-home",
      T1CODE_CONFIG_HOME: "/tmp/t1-config",
      T1CODE_STATE_HOME: "/tmp/t1-state",
    });

    expect(paths).toEqual({
      userHomeDir: os.homedir(),
      homeDir: "/tmp/t1-home",
      configHomeDir: "/tmp/t1-config",
      stateHomeDir: "/tmp/t1-state",
      prefsPath: "/tmp/t1-config/prefs.json",
      logPath: "/tmp/t1-state/tui.log",
      imagesDir: "/tmp/t1-state/images",
    });
  });

  it("uses XDG config, data, and state locations on Linux", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/Users/tester");

    const paths = resolveTuiPaths({
      XDG_CONFIG_HOME: "/var/config",
      XDG_DATA_HOME: "/var/data",
      XDG_STATE_HOME: "/var/state",
    });

    expect(paths).toEqual({
      userHomeDir: "/Users/tester",
      homeDir: "/var/data/termweave",
      configHomeDir: "/var/config/termweave",
      stateHomeDir: "/var/state/termweave",
      prefsPath: "/var/config/termweave/prefs.json",
      logPath: "/var/state/termweave/tui.log",
      imagesDir: "/var/state/termweave/images",
    });
  });

  it("keeps legacy defaults on non-Linux platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "homedir").mockReturnValue("/Users/tester");

    const paths = resolveTuiPaths({});

    expect(paths).toEqual({
      userHomeDir: "/Users/tester",
      homeDir: "/Users/tester/.t1",
      configHomeDir: "/Users/tester/.config/termweave",
      stateHomeDir: "/Users/tester/.config/termweave",
      prefsPath: "/Users/tester/.config/termweave/prefs.json",
      logPath: "/Users/tester/.config/termweave/tui.log",
      imagesDir: "/Users/tester/.config/termweave/images",
    });
  });
});
