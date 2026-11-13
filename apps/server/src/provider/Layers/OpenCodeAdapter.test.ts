// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import {
  OpenCodeSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@termweave/contracts";
import { createModelSelection } from "@termweave/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, vi } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Queue, Schema, Stream } from "effect";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";

import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const SESSION_ID = "ses_test";

/** Minimal async event source backing the fake `event.subscribe` iterable. */
function makeAsyncEventSource({ leadWithConnected = true }: { leadWithConnected?: boolean } = {}) {
  const pending: OpenCodeEvent[] = [];
  let waiter: ((result: IteratorResult<OpenCodeEvent>) => void) | null = null;
  let closed = false;
  // The real server always leads with `server.connected` as soon as the lazy
  // `event.subscribe` iterable is consumed; emit it on the first `next()`.
  const serverConnected: OpenCodeEvent = opencodeEvent("server.connected", {});
  let connectedSent = false;
  const offer = (event: OpenCodeEvent) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ value: event, done: false });
      return;
    }
    pending.push(event);
  };
  const iterable: AsyncIterable<OpenCodeEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (leadWithConnected && !connectedSent) {
          connectedSent = true;
          return { value: serverConnected, done: false };
        }
        const buffered = pending.shift();
        if (buffered) {
          return { value: buffered, done: false };
        }
        if (closed) {
          return { done: true, value: undefined as never };
        }
        return new Promise<IteratorResult<OpenCodeEvent>>((resolve) => {
          waiter = resolve;
        });
      },
    }),
  };
  const close = () => {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ done: true, value: undefined as never });
    }
  };
  return { offer, close, iterable };
}

function makeFakeOpenCodeRuntime({
  leadWithConnected = true,
}: { leadWithConnected?: boolean } = {}) {
  const source = makeAsyncEventSource({ leadWithConnected });
  const shape: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => Effect.die("not used in test"),
    connectToOpenCodeServer: () =>
      Effect.succeed({
        url: "http://127.0.0.1:1",
        password: null,
        exitCode: null,
        external: true,
      }),
    runOpenCodeCommand: () => Effect.die("not used in test"),
    createOpenCodeSdkClient: () =>
      ({
        session: {
          create: vi.fn(async () => ({ id: SESSION_ID })),
          switchModel: vi.fn(async () => undefined),
          switchAgent: vi.fn(async () => undefined),
          prompt: vi.fn(async () => undefined),
          interrupt: vi.fn(async () => undefined),
          context: vi.fn(async () => []),
          remove: vi.fn(async () => undefined),
        },
        event: {
          subscribe: vi.fn(() => source.iterable),
        },
      }) as unknown as OpenCodeClient,
    loadOpenCodeInventory: () => Effect.die("not used in test"),
  };
  return { shape, source };
}

/** Build a 2.x SDK event with the session id already attached. */
const opencodeEvent = (type: OpenCodeEvent["type"], data: Record<string, unknown>): OpenCodeEvent =>
  ({ id: "evt-1", created: 0, type, data }) as unknown as OpenCodeEvent;

const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const scriptedTurnEvents: Array<OpenCodeEvent> = [
  opencodeEvent("session.execution.started", { sessionID: SESSION_ID }),
  opencodeEvent("session.text.delta", {
    sessionID: SESSION_ID,
    assistantMessageID: "msg_1",
    ordinal: 0,
    delta: "po",
  }),
  opencodeEvent("session.text.delta", {
    sessionID: SESSION_ID,
    assistantMessageID: "msg_1",
    ordinal: 0,
    delta: "ng",
  }),
  opencodeEvent("session.text.ended", {
    sessionID: SESSION_ID,
    assistantMessageID: "msg_1",
    ordinal: 0,
    text: "pong",
  }),
  opencodeEvent("session.tool.input.started", {
    sessionID: SESSION_ID,
    assistantMessageID: "msg_1",
    id: "call_1",
    name: "bash",
  }),
  opencodeEvent("session.tool.called", {
    sessionID: SESSION_ID,
    assistantMessageID: "msg_1",
    id: "call_1",
    input: { command: "echo pong" },
    executed: true,
  }),
  opencodeEvent("session.tool.success", {
    sessionID: SESSION_ID,
    assistantMessageID: "msg_1",
    id: "call_1",
    content: [{ type: "text", text: "pong" }],
    executed: true,
  }),
  // The session id lives on `data.form`, not directly on `data`.
  opencodeEvent("form.created", {
    form: {
      id: "form_1",
      sessionID: SESSION_ID,
      title: "Follow-up",
      fields: [
        { key: "confirm", type: "boolean", title: "Confirm" },
        {
          key: "tags",
          type: "multiselect",
          title: "Tags",
          options: [
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
          ],
        },
      ],
    },
  }),
  opencodeEvent("session.execution.succeeded", { sessionID: SESSION_ID }),
  // Trailing markers that must NOT complete the turn a second time.
  opencodeEvent("session.idle", { sessionID: SESSION_ID }),
  opencodeEvent("session.status", { sessionID: SESSION_ID, status: { type: "idle" } }),
];

describe("OpenCodeAdapter 2.x event mapping", () => {
  it.live("maps a scripted turn into runtime events and completes the turn once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fakeRuntime = makeFakeOpenCodeRuntime();
        const adapter = yield* makeOpenCodeAdapter(
          decodeOpenCodeSettings({ binaryPath: "opencode", serverUrl: "", serverPassword: "" }),
          { instanceId: ProviderInstanceId.make("opencode") },
        ).pipe(
          // Single combined provide: merging the layers avoids chained
          // `Effect.provide` calls, while `NodeServices` sits beneath the
          // merge since `ServerConfig.layerTest` depends on FileSystem/Path.
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(OpenCodeRuntime, fakeRuntime.shape),
              ServerConfig.layerTest(process.cwd(), process.cwd()),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );

        const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Queue.offer(runtimeEvents, event)),
          Effect.forkScoped,
        );

        const session = yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "opencode");

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "Reply with the single word: pong",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/test",
          ),
        });

        for (const event of scriptedTurnEvents) {
          fakeRuntime.source.offer(event);
        }

        const collected: Array<ProviderRuntimeEvent> = [];
        // Wait for turn.completed, then let the pump drain the trailing markers.
        yield* Effect.gen(function* () {
          while (!collected.some((event) => event.type === "turn.completed")) {
            collected.push(yield* Queue.take(runtimeEvents));
          }
        }).pipe(Effect.timeout("10 seconds"));
        yield* Effect.sleep("200 millis");
        const drained: Array<ProviderRuntimeEvent> = [];
        while (true) {
          const next = yield* Queue.poll(runtimeEvents);
          if (Option.isNone(next)) {
            break;
          }
          drained.push(next.value);
        }
        collected.push(...drained);

        const types = collected.map((event) => event.type);
        assert.deepEqual(types, [
          "session.started",
          "thread.started",
          "turn.started",
          "content.delta",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "user-input.requested",
          "turn.completed",
        ]);

        const deltas = collected.filter((event) => event.type === "content.delta");
        const deltaText = deltas
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join("");
        assert.equal(deltaText, "pong");

        const firstDelta = deltas[0];
        if (firstDelta?.type !== "content.delta") {
          throw new Error("expected a content.delta event");
        }
        assert.equal(firstDelta.payload.streamKind, "assistant_text");
        assert.equal(String(firstDelta.itemId), "msg_1:text:0");

        const completed = collected.filter((event) => event.type === "item.completed");
        assert.equal(completed.length, 2);
        const [assistantCompleted, toolCompleted] = completed;
        if (
          assistantCompleted?.type !== "item.completed" ||
          toolCompleted?.type !== "item.completed"
        ) {
          throw new Error("expected two item.completed events");
        }
        assert.equal(assistantCompleted.payload.itemType, "assistant_message");
        assert.equal(assistantCompleted.payload.status, "completed");
        assert.equal(assistantCompleted.payload.detail, "pong");
        assert.equal(toolCompleted.payload.itemType, "command_execution");
        assert.equal(toolCompleted.payload.status, "completed");
        assert.equal(toolCompleted.payload.detail, "pong");

        const turnCompleted = collected.filter((event) => event.type === "turn.completed");
        assert.equal(turnCompleted.length, 1);
        if (turnCompleted[0]?.type !== "turn.completed") {
          throw new Error("expected turn.completed");
        }
        assert.equal(turnCompleted[0].payload.state, "completed");

        // form.created must surface as a user-input request even though its
        // session id lives on `data.form`.
        const userInputRequested = collected.filter(
          (event) => event.type === "user-input.requested",
        );
        assert.equal(userInputRequested.length, 1);
        const userInput = userInputRequested[0];
        if (userInput?.type !== "user-input.requested") {
          throw new Error("expected user-input.requested");
        }
        assert.equal(String(userInput.requestId), "form_1");
        const questions = userInput.payload.questions;
        assert.equal(questions.length, 2);
        assert.deepEqual(
          questions[0]?.options.map((option) => option.label),
          ["Yes", "No"],
        );
        assert.equal(questions[1]?.multiSelect, true);
        assert.deepEqual(
          questions[1]?.options.map((option) => option.label),
          ["Alpha", "Beta"],
        );
      }),
    ),
  );

  it.live("emits runtime.error and session.exited when the event stream ends cleanly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fakeRuntime = makeFakeOpenCodeRuntime();
        const adapter = yield* makeOpenCodeAdapter(
          decodeOpenCodeSettings({ binaryPath: "opencode", serverUrl: "", serverPassword: "" }),
          { instanceId: ProviderInstanceId.make("opencode") },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(OpenCodeRuntime, fakeRuntime.shape),
              ServerConfig.layerTest(process.cwd(), process.cwd()),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );

        const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Queue.offer(runtimeEvents, event)),
          Effect.forkScoped,
        );

        const session = yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-eof"),
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "opencode");

        // A clean EOF (no stream failure) of the event source must still be
        // treated as an unexpected exit.
        fakeRuntime.source.close();

        const collected: Array<ProviderRuntimeEvent> = [];
        yield* Effect.gen(function* () {
          while (!collected.some((event) => event.type === "session.exited")) {
            collected.push(yield* Queue.take(runtimeEvents));
          }
        }).pipe(Effect.timeout("10 seconds"));

        assert.deepEqual(
          collected.map((event) => event.type),
          ["session.started", "thread.started", "runtime.error", "session.exited"],
        );
        const runtimeError = collected.find((event) => event.type === "runtime.error");
        if (runtimeError?.type !== "runtime.error") {
          throw new Error("expected a runtime.error event");
        }
        assert.equal(runtimeError.payload.message, "OpenCode event stream ended unexpectedly.");
        assert.equal(runtimeError.payload.class, "transport_error");
        const exited = collected.find((event) => event.type === "session.exited");
        if (exited?.type !== "session.exited") {
          throw new Error("expected a session.exited event");
        }
        assert.equal(exited.payload.reason, "OpenCode event stream ended unexpectedly.");
        assert.equal(exited.payload.exitKind, "error");
        assert.equal(exited.payload.recoverable, false);
      }),
    ),
  );

  it.live("fails startSession without session.exited when the pump ends before connecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fakeRuntime = makeFakeOpenCodeRuntime({ leadWithConnected: false });
        const adapter = yield* makeOpenCodeAdapter(
          decodeOpenCodeSettings({ binaryPath: "opencode", serverUrl: "", serverPassword: "" }),
          { instanceId: ProviderInstanceId.make("opencode") },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(OpenCodeRuntime, fakeRuntime.shape),
              ServerConfig.layerTest(process.cwd(), process.cwd()),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );

        const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Queue.offer(runtimeEvents, event)),
          Effect.forkScoped,
        );

        // A clean EOF (no stream failure) before `server.connected` must fail
        // the startup instead of waiting out the connect timeout.
        fakeRuntime.source.close();
        const startedExit = yield* Effect.exit(
          adapter.startSession({
            provider: "opencode",
            threadId: asThreadId("thread-eof-before-connected"),
            runtimeMode: "full-access",
          }),
        );
        assert.equal(Exit.isFailure(startedExit), true);

        // The session never started, so no lifecycle events were emitted.
        yield* Effect.sleep("200 millis");
        assert.equal(Option.isNone(yield* Queue.poll(runtimeEvents)), true);
      }),
    ),
  );
});
