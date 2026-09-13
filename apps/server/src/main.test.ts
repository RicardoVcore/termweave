import * as Http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import type { OrchestrationReadModel } from "@termweave/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, beforeEach } from "vitest";
import { NetService } from "@termweave/shared/Net";

import { CliConfig, recordStartupHeartbeat, termweaveCli, type CliConfigShape } from "./main";
import { ServerConfig, type ServerConfigShape } from "./config";
import { Open, type OpenShape } from "./open";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { Server, type ServerShape } from "./wsServer";

const start = vi.fn(() => undefined);
const stop = vi.fn(() => undefined);
let testHomeDir = "";
let resolvedConfig: ServerConfigShape | null = null;
const serverStart = Effect.acquireRelease(
  Effect.gen(function* () {
    resolvedConfig = yield* ServerConfig;
    start();
    return {} as unknown as Http.Server;
  }),
  () => Effect.sync(() => stop()),
);
const findAvailablePort = vi.fn((preferred: number) => Effect.succeed(preferred));

const testLayer = Layer.mergeAll(
  Layer.succeed(CliConfig, {
    cwd: "/tmp/termweave-test-workspace",
    fixPath: Effect.void,
  } satisfies CliConfigShape),
  Layer.succeed(NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort,
  }),
  Layer.succeed(Server, { start: serverStart, stopSignal: Effect.void } satisfies ServerShape),
  Layer.succeed(Open, { openInEditor: () => Effect.void } satisfies OpenShape),
  AnalyticsService.layerTest,
  FetchHttpClient.layer,
  NodeServices.layer,
);

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(termweaveCli, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_HOME: testHomeDir, ...env } }),
      ),
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  testHomeDir = mkdtempSync(join(tmpdir(), "termweave-main-test-"));
  resolvedConfig = null;
});

afterEach(() => {
  if (testHomeDir !== "") {
    rmSync(testHomeDir, { recursive: true, force: true });
    testHomeDir = "";
  }
});

it.layer(testLayer)("server CLI command", (it) => {
  it.effect("starts TUI server with CLI configuration", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "4010", "--host", "0.0.0.0", "--auth-token", "auth-secret"]);

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 4010);
      assert.equal(resolvedConfig?.host, "0.0.0.0");
      assert.equal(resolvedConfig?.authToken, "auth-secret");
      assert.equal(resolvedConfig?.stateDir, `${testHomeDir}/userdata`);
      assert.equal(stop.mock.calls.length, 1);
    }),
  );

  it.effect("uses environment configuration", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        T3CODE_PORT: "4999",
        T3CODE_HOST: "100.88.10.4",
        T3CODE_AUTH_TOKEN: "env-token",
      });

      assert.equal(resolvedConfig?.port, 4999);
      assert.equal(resolvedConfig?.host, "100.88.10.4");
      assert.equal(resolvedConfig?.authToken, "env-token");
    }),
  );

  it.effect("uses fixed TUI defaults", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation(() => Effect.succeed(4666));
      yield* runCli([]);

      assert.equal(findAvailablePort.mock.calls.length, 0);
      assert.equal(resolvedConfig?.port, 3773);
      assert.equal(resolvedConfig?.host, "127.0.0.1");
    }),
  );

  it.effect("records startup heartbeat counts", () =>
    Effect.gen(function* () {
      const record = vi.fn(() => Effect.void);
      const getSnapshot = vi.fn(() =>
        Effect.succeed({
          snapshotSequence: 2,
          projects: [{} as OrchestrationReadModel["projects"][number]],
          threads: [
            {} as OrchestrationReadModel["threads"][number],
            {} as OrchestrationReadModel["threads"][number],
          ],
          updatedAt: new Date(1).toISOString(),
        } satisfies OrchestrationReadModel),
      );

      yield* recordStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, { getSnapshot }),
        Effect.provideService(AnalyticsService, { record, flush: Effect.void }),
      );
      assert.deepEqual(record.mock.calls[0], [
        "server.boot.heartbeat",
        { threadCount: 2, projectCount: 1 },
      ]);
    }),
  );
});
