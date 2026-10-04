import fs from "node:fs";
import { mock } from "bun:test";

const stopMarker = process.env.TERMWEAVE_TEST_STOP_MARKER;
if (!stopMarker) throw new Error("TERMWEAVE_TEST_STOP_MARKER is required.");

const sshProfile = {
  id: "test",
  label: "test",
  transport: "ssh",
  host: "test",
  port: 22,
  remotePort: 3773,
};
const connection = {
  host: "127.0.0.1",
  port: 41000,
  authToken: null,
  wsUrl: "ws://127.0.0.1:41000/",
};

mock.module(import.meta.resolve("../tuiCli.ts"), () => ({
  resolveLaunchProfile: () => sshProfile,
  directTargetFromProfile: () => null,
  buildDirectAttachServerConnection: () => connection,
  buildSshAttachServerConnection: () => connection,
  startSshAttach: async () => ({
    profile: sshProfile,
    localPort: 41000,
    stop: () => fs.appendFileSync(stopMarker, "stopped\n"),
  }),
}));

mock.module(import.meta.resolve("../prefs.ts"), () => ({
  readPrefs: async () => ({}),
  writePrefs: async () => undefined,
}));

// Park startup right after the SSH attach is live: the renderer never arrives.
const opentui = await import("@opentui/core");
mock.module("@opentui/core", () => ({
  ...opentui,
  createCliRenderer: async () => {
    process.stdout.write("RENDERER_PENDING\n");
    return new Promise<never>(() => {});
  },
}));
