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
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";

import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const SESSION_ID = "ses_test";

/** Minimal async event source backing the fake `event.subscribe` iterable. */
function makeAsyncEventSource() {
  const pending: OpenCodeEvent[] = [];
  let waiter: ((result: IteratorResult<OpenCodeEvent>) => void) | null = null;
  let closed = false;
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
      next: () =>
        new Promise<IteratorResult<OpenCodeEvent>>((resolve) => {
          const buffered = pending.shift();
          if (buffered) {
            resolve({ value: buffered, done: false });
            return;
          }
          if (closed) {
            resolve({ done: true, value: undefined as never });
            return;
          }
          waiter = resolve;
        }),
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

function makeFakeOpenCodeRuntime() {
  const source = makeAsyncEventSource();
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
      }),
    ),
  );
});
