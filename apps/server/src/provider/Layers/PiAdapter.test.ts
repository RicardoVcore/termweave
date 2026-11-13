// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@termweave/contracts";
import { createModelSelection } from "@termweave/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Queue, Schema, Stream } from "effect";
import type { TimeoutError } from "effect/Cause";

import type { ProviderAdapterError } from "../Errors.ts";
import { ServerConfig } from "../../config.ts";
import { type PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const decodePiSettings = Schema.decodeSync(PiSettings);
const FIXTURES_DIR = path.dirname(
  fileURLToPath(new URL("../../../integration/fixtures/pi-rpc/x.jsonl", import.meta.url)),
);
const fixturePath = (name: string) => path.join(FIXTURES_DIR, `${name}.jsonl`);

/**
 * Fake Pi: answers the commands the adapter sends, then replays a recorded
 * fixture (`rec` entries, responses filtered) stopping at any dialog until
 * the matching `extension_ui_response` arrives. Diagnostic side channels for
 * the tests go through files named by env vars.
 */
const FAKE_PI_SCRIPT = `
import fs from "node:fs";
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const respond = (id, command, data) => write({ id, type: "response", command, success: true, data });
const state = { sessionId: "s1", sessionFile: "/tmp/fake-pi-session.jsonl", model: { provider: "venice-ai", id: "m" }, thinkingLevel: "medium" };
const records = process.env.PI_FAKE_FIXTURE
  ? fs.readFileSync(process.env.PI_FAKE_FIXTURE, "utf8").trim().split("\\n").map((l) => JSON.parse(l).rec).filter((r) => r.type !== "response")
  : [];
// Appends keep the file consistent for readers while records stream in.
const recordReceived = (line) => {
  if (process.env.PI_FAKE_RECEIVED_FILE) {
    try { fs.appendFileSync(process.env.PI_FAKE_RECEIVED_FILE, line + "\\n"); }
    catch (error) { process.stderr.write("recordReceived failed: " + error + "\\n"); }
  }
};
let pos = 0;
let openDialog = null;
const pump = () => {
  while (pos < records.length) {
    const rec = records[pos];
    const method = rec.method ?? "";
    if (rec.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(method)) {
      pos += 1;
      openDialog = rec;
      write(rec);
      return;
    }
    pos += 1;
    write(rec);
  }
};
const handle = (record) => {
  const line = record.type === "extension_ui_response" ? "extension_ui_response:" + JSON.stringify(record) : record.type;
  recordReceived(line);
  if (record.type === "extension_ui_response") {
    if (openDialog && record.id === openDialog.id) { openDialog = null; pump(); }
    return;
  }
  switch (record.type) {
    case "get_state": respond(record.id, "get_state", state); break;
    case "set_model": state.model = { provider: record.provider, id: record.modelId }; respond(record.id, "set_model", state.model); break;
    case "set_thinking_level": state.thinkingLevel = record.level; respond(record.id, "set_thinking_level", {}); break;
    case "clear_queue": respond(record.id, "clear_queue", { steering: [], followUp: [] }); break;
    case "abort": respond(record.id, "abort", {}); break;
    case "get_session_stats": respond(record.id, "get_session_stats", { tokens: { input: 11, output: 7, cacheRead: 3, total: 21.4 }, contextUsage: { tokens: 12.4, contextWindow: 1000 } }); break;
    case "get_messages": respond(record.id, "get_messages", { messages: [] }); break;
    case "get_fork_messages": respond(record.id, "get_fork_messages", { messages: [] }); break;
    case "fork": respond(record.id, "fork", { text: "", cancelled: false }); break;
    case "prompt":
      if (process.env.PI_FAKE_REJECT === "1") {
        write({ id: record.id, type: "response", command: "prompt", success: false, error: "No API key found" });
        break;
      }
      respond(record.id, "prompt", { disposition: "started" });
      pump();
      break;
  }
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
if (process.env.PI_FAKE_ARGV_FILE) fs.writeFileSync(process.env.PI_FAKE_ARGV_FILE, process.argv.slice(1).join("\\n"));
`;

interface FakePiHandle {
  readonly scriptPath: string;
  readonly environment: Record<string, string>;
  readonly argvFile: string;
  readonly receivedFile: string;
  readReceived(): Array<string>;
}

const makeFakePi = (
  tmpDir: string,
  options: { fixture?: string; reject?: boolean } = {},
): FakePiHandle => {
  const scriptPath = path.join(tmpDir, "fake-pi.mjs");
  fs.writeFileSync(scriptPath, FAKE_PI_SCRIPT);
  const argvFile = path.join(tmpDir, "argv.txt");
  const receivedFile = path.join(tmpDir, "received.txt");
  const environment: Record<string, string> = {
    PI_FAKE_ARGV_FILE: argvFile,
    PI_FAKE_RECEIVED_FILE: receivedFile,
    ...(options.fixture ? { PI_FAKE_FIXTURE: fixturePath(options.fixture) } : {}),
    ...(options.reject ? { PI_FAKE_REJECT: "1" } : {}),
  };
  return {
    scriptPath,
    environment,
    argvFile,
    receivedFile,
    readReceived: () =>
      fs.existsSync(receivedFile)
        ? fs.readFileSync(receivedFile, "utf8").split("\n").filter(Boolean)
        : [],
  };
};

const makeAdapter = (tmpDir: string, fake: FakePiHandle) =>
  makePiAdapter(decodePiSettings({ binaryPath: process.execPath }), {
    instanceId: ProviderInstanceId.make("pi"),
    // Test-only hook: run the fake Pi script through node.
    extraArgsPrefix: [fake.scriptPath],
    environment: fake.environment,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ServerConfig.layerTest(process.cwd(), tmpDir)).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

type PiAdapter = PiAdapterShape;

const collectEvents = (adapter: PiAdapter) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped,
    );
    return queue;
  });

const takeUntil = (
  queue: Queue.Queue<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
) =>
  Effect.gen(function* () {
    const collected: Array<ProviderRuntimeEvent> = [];
    while (true) {
      const event = yield* Queue.take(queue);
      collected.push(event);
      if (predicate(event)) return collected;
    }
  }).pipe(Effect.timeout("10 seconds"));

const withAdapter = (
  options: { fixture?: string; reject?: boolean },
  run: (
    adapter: PiAdapter,
    fake: FakePiHandle,
    queue: Queue.Queue<ProviderRuntimeEvent>,
  ) => Effect.Effect<void, ProviderAdapterError | TimeoutError>,
) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapter-"));
  const fake = makeFakePi(tmpDir, options);
  return Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(tmpDir, fake);
      const queue = yield* collectEvents(adapter);
      yield* run(adapter, fake, queue);
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(tmpDir, { recursive: true, force: true }))));
};

const requestErrorOf = <A>(exit: Exit.Exit<A, ProviderAdapterError>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
  return error !== null && error._tag === "ProviderAdapterRequestError" ? error : undefined;
};

describe("PiAdapter", () => {
  it.live("maps a recorded text turn end to end", () =>
    withAdapter({ fixture: "c1-text" }, (adapter, fake, queue) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-c1");
        const session = yield* adapter.startSession({
          provider: "pi",
          cwd: process.cwd(),
          threadId,
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "pi");
        assert.equal(session.model, "venice-ai/m");
        assert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionFile: "/tmp/fake-pi-session.jsonl",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Reply with exactly: pong",
          modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "venice-ai/m", [
            { id: "thinking", value: "high" },
          ]),
        });

        const events = yield* takeUntil(queue, (event) => event.type === "turn.completed");
        // The usage event is published right after the turn completes.
        const usageEvents = yield* takeUntil(
          queue,
          (event) => event.type === "thread.token-usage.updated",
        );
        const all = [...events, ...usageEvents];
        const types = all.map((event) => event.type);

        const startedIndex = types.indexOf("turn.started");
        const completedIndex = types.indexOf("turn.completed");
        const usageIndex = types.indexOf("thread.token-usage.updated");
        assert.ok(startedIndex >= 0);
        assert.ok(completedIndex > startedIndex, "turn.completed must follow turn.started");
        assert.ok(usageIndex > completedIndex, "token usage must follow turn.completed");

        // `turn.started` must be the first event carrying the turn's id.
        const started = all.find((event) => event.type === "turn.started");
        assert.ok(started, "turn.started must be emitted");
        assert.ok(
          all.findIndex((event) => event.turnId === started.turnId) === all.indexOf(started),
        );
        assert.ok(
          all.some((event) => event !== started && event.turnId === started.turnId),
          "turn events must carry the turnId",
        );

        const deltas = all
          .filter(
            (event) =>
              event.type === "content.delta" && event.payload.streamKind === "assistant_text",
          )
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join("");
        assert.equal(deltas, "pong");
        const assistant = all.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        );
        assert.ok(assistant);
        assert.equal(assistant.type === "item.completed" ? assistant.payload.detail : "", "pong");
        const completed = all.find((event) => event.type === "turn.completed");
        assert.equal(
          completed?.type === "turn.completed" ? completed.payload.state : "",
          "completed",
        );

        const usage = all.find((event) => event.type === "thread.token-usage.updated");
        assert.deepEqual(
          usage?.type === "thread.token-usage.updated" ? usage.payload.usage : undefined,
          {
            usedTokens: 12,
            maxTokens: 1000,
            inputTokens: 11,
            cachedInputTokens: 3,
            outputTokens: 7,
          },
        );

        // The thinking option differs from the session's `medium`, so it must
        // be sent; the model slug matches `get_state`, so set_model must not.
        const receivedTypes = fake.readReceived();
        assert.ok(receivedTypes.includes("set_thinking_level"));
        assert.ok(!receivedTypes.includes("set_model"));
      }),
    ),
  );

  it.live("surfaces approval dialogs and resolves acceptForSession", () =>
    withAdapter({ fixture: "c3b-session-allow" }, (adapter, fake, queue) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-c3b");
        yield* adapter.startSession({
          provider: "pi",
          cwd: process.cwd(),
          threadId,
          runtimeMode: "approval-required",
        });

        // The approval extension must be loaded via -e in approval-required mode.
        const argv = fs.readFileSync(fake.argvFile, "utf8").split("\n");
        const extensionFlag = argv.indexOf("-e");
        assert.ok(extensionFlag >= 0, "argv must contain -e");
        assert.ok(argv[extensionFlag + 1]?.endsWith("termweave-approval.ts"));

        yield* adapter.sendTurn({ threadId, input: "run the command" });
        const opened = yield* takeUntil(queue, (event) => event.type === "request.opened").pipe(
          Effect.map((events) => events.at(-1)),
        );
        assert.ok(opened && opened.type === "request.opened");
        assert.equal(opened.payload.requestType, "command_execution_approval");
        assert.equal(opened.payload.detail, "echo session-allow-1");
        assert.equal(
          opened.providerRefs?.providerItemId,
          "chatcmpl-tool-8fdf633590924b909a27f4a9cc9f6ea9",
        );
        assert.ok(typeof opened.requestId === "string");

        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(opened.requestId),
          "acceptForSession",
        );
        const resolved = yield* takeUntil(queue, (event) => event.type === "request.resolved").pipe(
          Effect.map((events) => events.at(-1)),
        );
        assert.ok(resolved && resolved.type === "request.resolved");
        assert.equal(resolved.payload.decision, "acceptForSession");
        const completed = yield* takeUntil(queue, (event) => event.type === "turn.completed");
        assert.equal(
          completed.at(-1)?.type === "turn.completed" ? "turn.completed" : "",
          "turn.completed",
        );
      }),
    ),
  );

  it.live("interrupt cancels the open dialog before abort", () =>
    withAdapter({ fixture: "c3b-session-allow" }, (adapter, fake, queue) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-c3b-interrupt");
        yield* adapter.startSession({
          provider: "pi",
          cwd: process.cwd(),
          threadId,
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "run the command" });
        yield* takeUntil(queue, (event) => event.type === "request.opened");

        yield* adapter.interruptTurn(threadId);

        const received = fake.readReceived();
        const cancelledIndex = received.findIndex(
          (line) => line.startsWith("extension_ui_response:") && line.includes('"cancelled":true'),
        );
        const clearQueueIndex = received.indexOf("clear_queue");
        const abortIndex = received.indexOf("abort");
        assert.ok(cancelledIndex >= 0, "dialog must be cancelled");
        assert.ok(clearQueueIndex > cancelledIndex, "clear_queue must follow the dialog cancel");
        assert.ok(abortIndex > clearQueueIndex, "abort must follow clear_queue");

        const resolved = yield* takeUntil(queue, (event) => event.type === "request.resolved").pipe(
          Effect.map((events) => events.at(-1)),
        );
        assert.ok(resolved && resolved.type === "request.resolved");
        assert.equal(resolved.payload.decision, "cancel");

        const completed = yield* takeUntil(queue, (event) => event.type === "turn.completed").pipe(
          Effect.map((events) => events.at(-1)),
        );
        assert.ok(completed && completed.type === "turn.completed");
        assert.equal(completed.payload.state, "interrupted");
      }),
    ),
  );

  it.live("rejects sendTurn while a turn is active", () =>
    withAdapter({ fixture: "c3b-session-allow" }, (adapter, _fake, queue) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-c3b-serial");
        yield* adapter.startSession({
          provider: "pi",
          cwd: process.cwd(),
          threadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "first" });
        // The open approval dialog keeps the turn active, so this must fail
        // deterministically.
        yield* takeUntil(queue, (event) => event.type === "request.opened");
        const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "second" }));
        const error = requestErrorOf(exit);
        assert.ok(error, "sendTurn must fail with ProviderAdapterRequestError");
        assert.match(error.detail, /already running/);
      }),
    ),
  );

  it.live("fails the turn and emits runtime.error when Pi rejects the prompt", () =>
    withAdapter({ fixture: "c1-text", reject: true }, (adapter, _fake, queue) =>
      Effect.gen(function* () {
        const threadId = asThreadId("thread-reject");
        yield* adapter.startSession({
          provider: "pi",
          cwd: process.cwd(),
          threadId,
          runtimeMode: "full-access",
        });
        const exit = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "Reply with exactly: pong" }),
        );
        const error = requestErrorOf(exit);
        assert.ok(error, "sendTurn must fail with ProviderAdapterRequestError");
        assert.match(error.detail, /No API key found/);

        const started = yield* takeUntil(queue, (event) => event.type === "turn.started").pipe(
          Effect.map((events) => events.at(-1)),
        );
        assert.ok(started && started.type === "turn.started");
        const runtimeError = yield* takeUntil(queue, (event) => event.type === "runtime.error");
        const event = runtimeError.at(-1);
        assert.ok(event && event.type === "runtime.error");
        assert.equal(event.payload.message, "No API key found");
        assert.equal(event.payload.class, "provider_error");
        assert.equal(event.turnId, started.turnId);

        const completed = yield* takeUntil(queue, (event) => event.type === "turn.completed").pipe(
          Effect.map((events) => events.at(-1)),
        );
        assert.ok(completed && completed.type === "turn.completed");
        assert.equal(completed.turnId, started.turnId);
        assert.equal(completed.payload.state, "failed");
        assert.ok(typeof completed.payload.errorMessage === "string");
        assert.match(completed.payload.errorMessage, /No API key found/);
      }),
    ),
  );
});
