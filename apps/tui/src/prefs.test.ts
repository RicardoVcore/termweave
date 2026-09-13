import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TuiPaths } from "./config";
import { readPrefs, writePrefs, type TuiPrefs } from "./prefs";

async function makePaths(): Promise<{ root: string; paths: TuiPaths }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "termweave-prefs-"));
  return {
    root,
    paths: {
      userHomeDir: path.join(root, "user-home"),
      homeDir: path.join(root, "home"),
      configHomeDir: path.join(root, "config"),
      stateHomeDir: path.join(root, "state"),
      prefsPath: path.join(root, "config", "prefs.json"),
      logPath: path.join(root, "state", "tui.log"),
      imagesDir: path.join(root, "state", "images"),
    },
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("prefs", () => {
  it("persists thread read state alongside other tui prefs", async () => {
    const { root, paths } = await makePaths();
    tempRoots.push(root);

    await writePrefs(paths, {
      tuiThemeId: "terminal-match",
      selectedThreadId: "thread-1",
      locallyUnreadThreadIds: ["thread-2"],
      threadLastVisitedAtById: {
        "thread-1": "2026-03-24T12:00:00.000Z",
      },
      draftThreadsByProjectId: {
        "project-1": {
          id: "draft-thread-1",
          projectId: "project-1",
        },
      },
      composerDraftsByThreadId: {
        "thread-1": {
          text: "unsent draft",
          mentions: [
            {
              type: "path",
              path: "apps/tui/src/ui.tsx",
              kind: "file",
              parentPath: "apps/tui/src",
            },
          ],
          attachments: [
            {
              type: "image",
              name: "draft-image.png",
              mimeType: "image/png",
              sizeBytes: 4,
              dataUrl: "data:image/png;base64,MTIzNA==",
              localPath: "/tmp/draft-image.png",
            },
          ],
        },
      },
      mainView: "settings",
      diffOpen: true,
    });

    await expect(readPrefs(paths)).resolves.toEqual({
      tuiThemeId: "terminal-match",
      selectedThreadId: "thread-1",
      locallyUnreadThreadIds: ["thread-2"],
      threadLastVisitedAtById: {
        "thread-1": "2026-03-24T12:00:00.000Z",
      },
      draftThreadsByProjectId: {
        "project-1": {
          id: "draft-thread-1",
          projectId: "project-1",
        },
      },
      composerDraftsByThreadId: {
        "thread-1": {
          text: "unsent draft",
          mentions: [
            {
              type: "path",
              path: "apps/tui/src/ui.tsx",
              kind: "file",
              parentPath: "apps/tui/src",
            },
          ],
          attachments: [
            {
              type: "image",
              name: "draft-image.png",
              mimeType: "image/png",
              sizeBytes: 4,
              dataUrl: "data:image/png;base64,MTIzNA==",
              localPath: "/tmp/draft-image.png",
            },
          ],
        },
      },
      mainView: "settings",
      diffOpen: true,
    });
  });

  it("persists keybindings as the active main view", async () => {
    const { root, paths } = await makePaths();
    tempRoots.push(root);

    await writePrefs(paths, {
      mainView: "keybindings",
    });

    await expect(readPrefs(paths)).resolves.toEqual({
      mainView: "keybindings",
    });
  });

  it("sanitizes connection profiles before writing", async () => {
    const { root, paths } = await makePaths();
    tempRoots.push(root);

    await writePrefs(paths, {
      connectionProfiles: [
        {
          id: "vps",
          label: "VPS",
          transport: "direct",
          host: "100.64.0.10",
          port: 3773,
          tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
          password: "must-not-persist",
          privateKey: "must-not-persist",
        },
      ],
    } as unknown as TuiPrefs);

    await expect(fs.readFile(paths.prefsPath, "utf8")).resolves.toContain(
      '"tokenEnvVar": "TERMWEAVE_AUTH_TOKEN"',
    );
    const raw = JSON.parse(await fs.readFile(paths.prefsPath, "utf8")) as TuiPrefs;
    expect(raw.connectionProfiles).toEqual([
      {
        id: "vps",
        label: "VPS",
        transport: "direct",
        host: "100.64.0.10",
        port: 3773,
        tokenEnvVar: "TERMWEAVE_AUTH_TOKEN",
      },
    ]);
  });
});
