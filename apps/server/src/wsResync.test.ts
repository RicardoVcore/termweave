import * as Http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  ApprovalRequestId,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  TurnId,
  WS_CHANNELS,
  type ProviderRuntimeEvent,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  type WebSocketResponse,
} from "@termweave/contracts";

import { createServer } from "./wsServer";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { OpenCodeRuntimeLive } from "./provider/opencodeRuntime";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { ServerConfig, deriveServerPaths, type ServerConfigShape } from "./config";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { ProviderEventLoggersLive } from "./provider/Layers/ProviderEventLoggers.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import { layer as ProviderMaintenanceRunnerLive } from "./provider/providerMaintenanceRunner.ts";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth";
import {
  ProcessDiagnostics,
  type ProcessDiagnosticsShape,
} from "./diagnostics/ProcessDiagnostics.ts";
import { TraceDiagnostics, type TraceDiagnosticsShape } from "./diagnostics/TraceDiagnostics.ts";
import {
  SourceControlDiscovery,
  type SourceControlDiscoveryShape,
} from "./sourceControl/SourceControlDiscovery.ts";
import {
  SourceControlRepositoryService,
  type SourceControlRepositoryServiceShape,
} from "./sourceControl/SourceControlRepositoryService.ts";
import { Open, type OpenShape } from "./open";
import type { ServerProviderStatus, SourceControlRepositoryInfo } from "@termweave/contracts";

const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const defaultOpenService: OpenShape = {
  openInEditor: () => Effect.void,
};

const defaultProcessDiagnostics: ProcessDiagnosticsShape = {
  read: Effect.succeed({
    serverPid: 1,
    readAt: "2026-01-01T00:00:00.000Z",
    processCount: 0,
    totalRssBytes: 0,
    totalCpuPercent: 0,
    processes: [],
    error: null,
  }),
  signal: (input) =>
    Effect.succeed({
      ...input,
      signaled: true,
      message: null,
    }),
};

const defaultTraceDiagnostics: TraceDiagnosticsShape = {
  read: (options) =>
    Effect.succeed({
      traceFilePath: options.traceFilePath,
      scannedFilePaths: [options.traceFilePath],
      readAt: "2026-01-01T00:00:00.000Z",
      recordCount: 0,
      parseErrorCount: 0,
      firstSpanAt: null,
      lastSpanAt: null,
      failureCount: 0,
      interruptionCount: 0,
      slowSpanThresholdMs: options.slowSpanThresholdMs ?? 1_000,
      slowSpanCount: 0,
      logLevelCounts: {},
      topSpansByCount: [],
      slowestSpans: [],
      commonFailures: [],
      latestFailures: [],
      latestWarningAndErrorLogs: [],
      partialFailure: null,
      error: null,
    }),
};

const defaultSourceControlDiscovery: SourceControlDiscoveryShape = {
  discover: () =>
    Effect.succeed({
      versionControlSystems: [
        {
          kind: "git",
          implemented: true,
          label: "Git",
          executable: "git",
          status: "available",
          version: "git version 2.50.0",
          installHint: "Install Git and make sure `git` is available on PATH.",
          detail: null,
        },
      ],
      sourceControlProviders: [],
    }),
};

const defaultSourceControlRepositoryService: SourceControlRepositoryServiceShape = {
  lookupRepository: () =>
    Effect.succeed({
      provider: "github",
      nameWithOwner: "owner/repo",
      url: "https://github.com/owner/repo",
      sshUrl: "git@github.com:owner/repo.git",
    } satisfies SourceControlRepositoryInfo),
  cloneRepository: (input) =>
    Effect.succeed({
      cwd: input.destinationPath,
      remoteUrl: input.remoteUrl ?? "git@github.com:owner/repo.git",
      repository: null,
    }),
  publishRepository: (input) =>
    Effect.succeed({
      repository: {
        provider: input.provider,
        nameWithOwner: input.repository,
        url: `https://github.com/${input.repository}`,
        sshUrl: `git@github.com:${input.repository}.git`,
      },
      remoteName: input.remoteName ?? "origin",
      remoteUrl: `git@github.com:${input.repository}.git`,
      branch: "main",
      upstreamBranch: `${input.remoteName ?? "origin"}/main`,
      status: "pushed",
    }),
};

const defaultProviderHealthService: ProviderHealthShape = {
  getStatuses: Effect.succeed([
    {
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
  ] satisfies ReadonlyArray<ServerProviderStatus>),
};

type ChannelBox = {
  push: WsPush[];
  response: WebSocketResponse[];
};

const channelsBySocket = new Map<WebSocket, ChannelBox>();

type DequeuedMessage = {
  channel?: string;
  data?: unknown;
} & Record<string, unknown>;

function dequeue(channels: DequeuedMessage[], timeoutMs: number): Promise<DequeuedMessage> {
  const entry = channels.shift();
  if (entry) return Promise.resolve(entry);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);
    const originalPush = channels.push.bind(channels);
    channels.push = (value: DequeuedMessage) => {
      clearTimeout(timer);
      channels.push = originalPush;
      resolve(value);
      return 0;
    };
  });
}

function connectWs(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = token ? `ws://127.0.0.1:${port}/?token=${token}` : `ws://127.0.0.1:${port}`;
    const ws = new WebSocket(wsUrl);
    const channels: ChannelBox = { push: [], response: [] };
    channelsBySocket.set(ws, channels);
    ws.on("open", () => resolve(ws));
    ws.on("error", (error) => reject(error));
    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const message = parsed as { id?: string; type?: string; channel?: string; data?: unknown };
      if (message.type === "push" && typeof message.channel === "string") {
        channels.push.push(message as unknown as WsPush);
      } else if (typeof message.id === "string") {
        channels.response.push(parsed as WebSocketResponse);
      }
    });
  });
}

async function connectAndAwaitWelcome(
  port: number,
): Promise<[WebSocket, WsPushMessage<typeof WS_CHANNELS.serverWelcome>]> {
  const ws = await connectWs(port);
  const welcome = await waitForPush(ws, WS_CHANNELS.serverWelcome);
  return [ws, welcome];
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<WebSocketResponse> {
  const channels = channelsBySocket.get(ws);
  if (!channels) throw new Error("WebSocket not initialized");

  const id = crypto.randomUUID();
  const body =
    method === ORCHESTRATION_WS_METHODS.dispatchCommand
      ? { _tag: method, command: params }
      : params && typeof params === "object" && !Array.isArray(params)
        ? { _tag: method, ...(params as Record<string, unknown>) }
        : { _tag: method };
  ws.send(JSON.stringify({ id, body }));

  while (true) {
    const response = await dequeue(channels.response, 60_000);
    const responseId = (response as { id?: string }).id;
    if (responseId === id || responseId === "unknown") {
      return response as unknown as WebSocketResponse;
    }
  }
}

async function waitForPush<C extends WsPushChannel>(
  ws: WebSocket,
  channel: C,
  predicate?: (push: WsPushMessage<C>) => boolean,
  maxMessages = 120,
  idleTimeoutMs = 5_000,
): Promise<WsPushMessage<C>> {
  const channels = channelsBySocket.get(ws);
  if (!channels) throw new Error("WebSocket not initialized");

  for (let remaining = maxMessages; remaining > 0; remaining--) {
    const push = await dequeue(channels.push, idleTimeoutMs);
    if (push.channel !== channel) continue;
    const typed = push as WsPushMessage<C>;
    if (!predicate || predicate(typed)) return typed;
  }
  throw new Error(`Timed out waiting for push on ${channel}`);
}

describe("orchestration reconnect and interrupted sessions", () => {
  let server: Http.Server | null = null;
  let serverScope: Scope.Closeable | null = null;
  const connections: WebSocket[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTestServer(
    options: {
      providerLayer?: Layer.Layer<ProviderService, never>;
    } = {},
  ): Promise<Http.Server> {
    if (serverScope) {
      throw new Error("Test server is already running");
    }
    const baseDir = makeTempDir("termweave-resync-base-");
    const derivedPaths = Effect.runSync(
      deriveServerPaths(baseDir).pipe(Effect.provide(NodeServices.layer)),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const providerLayer = options.providerLayer ?? makeServerProviderLayer();
    const providerHealthLayer = Layer.succeed(ProviderHealth, defaultProviderHealthService);
    const openLayer = Layer.succeed(Open, defaultOpenService);
    const processDiagnosticsLayer = Layer.succeed(ProcessDiagnostics, defaultProcessDiagnostics);
    const traceDiagnosticsLayer = Layer.succeed(TraceDiagnostics, defaultTraceDiagnostics);
    const sourceControlDiscoveryLayer = Layer.succeed(
      SourceControlDiscovery,
      defaultSourceControlDiscovery,
    );
    const sourceControlRepositoryServiceLayer = Layer.succeed(
      SourceControlRepositoryService,
      defaultSourceControlRepositoryService,
    );
    const serverConfigLayer = Layer.succeed(ServerConfig, {
      port: 0,
      host: undefined,
      cwd: "/test/project",
      baseDir,
      ...derivedPaths,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServePort: undefined,
    } satisfies ServerConfigShape);
    const infrastructureLayer = providerLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const runtimeLayer = Layer.merge(
      makeServerRuntimeServicesLayer().pipe(Layer.provide(infrastructureLayer)),
      infrastructureLayer,
    );
    const dependenciesLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(providerHealthLayer),
      Layer.provideMerge(
        ProviderMaintenanceRunnerLive.pipe(
          Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
        ),
      ),
      Layer.provideMerge(traceDiagnosticsLayer),
      Layer.provideMerge(processDiagnosticsLayer),
      Layer.provideMerge(sourceControlDiscoveryLayer),
      Layer.provideMerge(sourceControlRepositoryServiceLayer),
      Layer.provideMerge(ProviderEventLoggersLive),
      Layer.provideMerge(OpenCodeRuntimeLive),
      Layer.provideMerge(ServerSettingsLive),
      Layer.provideMerge(openLayer),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtimeServices = await Effect.runPromise(
      Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
    );

    try {
      const runtime = await Effect.runPromise(
        createServer().pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
      );
      serverScope = scope;
      return runtime;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  async function closeTestServer() {
    if (!serverScope) return;
    const scope = serverScope;
    serverScope = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  afterEach(async () => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    await closeTestServer();
    server = null;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("resyncs state after a reconnect via snapshot and ordered event replay", async () => {
    server = await createTestServer();
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [firstSocket] = await connectAndAwaitWelcome(port);
    connections.push(firstSocket);

    const workspaceRoot = makeTempDir("termweave-resync-project-");
    const createdAt = new Date().toISOString();
    await sendRequest(firstSocket, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-resync-project-create",
      projectId: "project-resync",
      title: "Resync Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    await sendRequest(firstSocket, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-resync-thread-create",
      threadId: "thread-resync",
      projectId: "project-resync",
      title: "Resync Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });

    // Disconnect and reconnect: the server state must survive the socket drop.
    firstSocket.close();
    connections.length = 0;
    const [secondSocket] = await connectAndAwaitWelcome(port);
    connections.push(secondSocket);

    const snapshotResponse = await sendRequest(secondSocket, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshotResponse.error).toBeUndefined();
    const snapshot = snapshotResponse.result as {
      projects: Array<{ id: string }>;
      threads: Array<{ id: string; projectId: string }>;
    };
    expect(snapshot.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "project-resync" })]),
    );
    expect(snapshot.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "thread-resync", projectId: "project-resync" }),
      ]),
    );

    const replayResponse = await sendRequest(secondSocket, ORCHESTRATION_WS_METHODS.replayEvents, {
      fromSequenceExclusive: 0,
    });
    expect(replayResponse.error).toBeUndefined();
    const replayedEvents = (
      Array.isArray(replayResponse.result) ? replayResponse.result : []
    ) as Array<{
      sequence: number;
      type: string;
      aggregateId: string;
    }>;
    expect(replayedEvents.length).toBeGreaterThan(0);
    const sequences = replayedEvents.map((event) => event.sequence);
    expect([...sequences].toSorted((left, right) => left - right)).toEqual(sequences);
    const eventTypes = replayedEvents.map((event) => event.type);
    expect(eventTypes).toContain("project.created");
    expect(eventTypes).toContain("thread.created");
  });

  it("resets the thread session to interrupted when the provider turn aborts", async () => {
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      startSession: (threadId) =>
        Effect.succeed({
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: ({ threadId }) =>
        Effect.succeed({
          threadId,
          turnId: asTurnId("provider-turn-interrupted"),
        }),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: () => unsupported(),
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    server = await createTestServer({
      providerLayer: Layer.succeed(ProviderService, providerService),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("termweave-interrupted-project-");
    const createdAt = new Date().toISOString();
    await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-interrupt-project-create",
      projectId: "project-interrupt",
      title: "Interrupt Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-interrupt-thread-create",
      threadId: "thread-interrupt",
      projectId: "project-interrupt",
      title: "Interrupt Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });

    const startTurnResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-interrupt-turn-start",
      threadId: "thread-interrupt",
      message: {
        messageId: "msg-interrupt-1",
        role: "user",
        text: "run something",
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt,
    });
    expect(startTurnResponse.error).toBeUndefined();

    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string };
      return event.type === "thread.session-set";
    });

    emitRuntimeEvent({
      type: "turn.started",
      eventId: asEventId("evt-interrupt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-interrupt"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("provider-turn-interrupted"),
    } as unknown as ProviderRuntimeEvent);

    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as {
        type?: string;
        payload?: { session?: { status?: string; activeTurnId?: string | null } };
      };
      return event.type === "thread.session-set" && event.payload?.session?.status === "running";
    });

    emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-interrupt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-interrupt"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("provider-turn-interrupted"),
      payload: {
        state: "interrupted",
        errorMessage: "Claude runtime interrupted.",
      },
    } as unknown as ProviderRuntimeEvent);

    // An interrupted turn clears the active turn and returns the session to
    // ready so the thread accepts a follow-up turn.
    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as {
        type?: string;
        payload?: { session?: { status?: string; activeTurnId?: string | null } };
      };
      return (
        event.type === "thread.session-set" &&
        event.payload?.session?.status === "ready" &&
        event.payload.session.activeTurnId === null
      );
    });

    // The thread accepts a follow-up turn after the interrupted turn.
    const followUpResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-interrupt-turn-follow-up",
      threadId: "thread-interrupt",
      message: {
        messageId: "msg-interrupt-2",
        role: "user",
        text: "try again",
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
    expect(followUpResponse.error).toBeUndefined();
  });

  it("delivers approval and user-input round trips to the websocket", async () => {
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      startSession: (threadId) =>
        Effect.succeed({
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: ({ threadId }) =>
        Effect.succeed({
          threadId,
          turnId: asTurnId("provider-turn-roundtrip"),
        }),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: () => unsupported(),
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    server = await createTestServer({
      providerLayer: Layer.succeed(ProviderService, providerService),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("termweave-roundtrip-project-");
    const createdAt = new Date().toISOString();
    await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-roundtrip-project-create",
      projectId: "project-roundtrip",
      title: "Roundtrip Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-roundtrip-thread-create",
      threadId: "thread-roundtrip",
      projectId: "project-roundtrip",
      title: "Roundtrip Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });

    emitRuntimeEvent({
      type: "request.opened",
      eventId: asEventId("evt-roundtrip-request-opened"),
      provider: "codex",
      threadId: asThreadId("thread-roundtrip"),
      createdAt,
      requestId: ApprovalRequestId.make("req-roundtrip-approval"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    } as unknown as ProviderRuntimeEvent);

    emitRuntimeEvent({
      type: "user-input.requested",
      eventId: asEventId("evt-roundtrip-user-input-requested"),
      provider: "codex",
      threadId: asThreadId("thread-roundtrip"),
      createdAt,
      turnId: asTurnId("provider-turn-roundtrip"),
      requestId: ApprovalRequestId.make("req-roundtrip-user-input"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    } as unknown as ProviderRuntimeEvent);

    emitRuntimeEvent({
      type: "request.resolved",
      eventId: asEventId("evt-roundtrip-request-resolved"),
      provider: "codex",
      threadId: asThreadId("thread-roundtrip"),
      createdAt,
      requestId: ApprovalRequestId.make("req-roundtrip-approval"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    } as unknown as ProviderRuntimeEvent);

    emitRuntimeEvent({
      type: "user-input.resolved",
      eventId: asEventId("evt-roundtrip-user-input-resolved"),
      provider: "codex",
      threadId: asThreadId("thread-roundtrip"),
      createdAt,
      turnId: asTurnId("provider-turn-roundtrip"),
      requestId: ApprovalRequestId.make("req-roundtrip-user-input"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    } as unknown as ProviderRuntimeEvent);

    const activityKinds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const push = await waitForPush(
        ws,
        ORCHESTRATION_WS_CHANNELS.domainEvent,
        (event) => {
          return event.data.type === "thread.activity-appended";
        },
        120,
      );
      const activity = (
        push.data as {
          payload?: { activity?: { kind?: string } };
        }
      ).payload?.activity;
      if (activity?.kind) {
        activityKinds.push(activity.kind);
      }
    }
    for (const expectedKind of [
      "approval.requested",
      "approval.resolved",
      "user-input.requested",
      "user-input.resolved",
    ]) {
      expect(activityKinds).toContain(expectedKind);
    }
  });
});
