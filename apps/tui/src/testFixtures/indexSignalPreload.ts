import fs from "node:fs";
import { mock } from "bun:test";

const stopMarker = process.env.TERMWEAVE_TEST_STOP_MARKER;
if (!stopMarker) throw new Error("TERMWEAVE_TEST_STOP_MARKER is required.");

mock.module(import.meta.resolve("../tuiCli.ts"), () => ({
  buildSshAttachServerConnection: () => ({
    host: "127.0.0.1",
    port: 41000,
    authToken: null,
    wsUrl: "ws://127.0.0.1:41000/",
  }),
  startSshAttach: async () => ({
    profile: {
      id: "test",
      label: "test",
      transport: "ssh",
      host: "test",
      port: 22,
      remotePort: 3773,
    },
    localPort: 41000,
    stop: () => fs.appendFileSync(stopMarker, "stopped\n"),
  }),
}));

mock.module(import.meta.resolve("../prefs.ts"), () => ({
  readPrefs: async () => {
    process.stdout.write("PREFS_PENDING\n");
    return new Promise<never>(() => {});
  },
  writePrefs: async () => undefined,
}));
