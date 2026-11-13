// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { describe, expect } from "vitest";

import { makePiRpcProcess, PiRpcError } from "./PiRpcProcess.ts";

// Fake Pi: echoes a success response for get_state/prompt, ignores other
// commands, emits one session event at startup and exits 0 on stdin EOF.
const FAKE_PI_SCRIPT = `
let buffer = "";
process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === "get_state" || record.type === "prompt") {
        process.stdout.write(
          JSON.stringify({ type: "response", command: record.type, success: true, id: record.id }) + "\\n",
        );
      }
    } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
`;

// Fake Pi: answers the first command with a flushed response and exits
// immediately in the write callback, so stdout drains around the exit event.
const FAKE_PI_EXIT_AFTER_RESPONSE_SCRIPT = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    if (line.trim().length === 0) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === "get_state" || record.type === "prompt") {
        process.stdout.write(
          JSON.stringify({ type: "response", command: record.type, success: true, id: record.id }) + "\\n",
          () => process.exit(0),
        );
      }
    } catch {}
  }
});
`;

// Fake Pi: kills itself with a signal as soon as the first command arrives.
const FAKE_PI_SELF_KILL_SCRIPT = `
process.stdin.on("data", () => {
  process.kill(process.pid, "SIGKILL");
});
`;

type FakePiOptions = {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
};

const spawnFakePiOptions = (tmpDir: string, script: string = FAKE_PI_SCRIPT): FakePiOptions => {
  const scriptPath = path.join(tmpDir, "fake-pi.mjs");
  fs.writeFileSync(scriptPath, script);
  return { binaryPath: process.execPath, args: [scriptPath], cwd: tmpDir };
};

const withFakePi = <A, E, R>(
  run: (options: FakePiOptions) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-process-"))),
    (tmpDir) => run(spawnFakePiOptions(tmpDir)),
    (tmpDir) => Effect.sync(() => fs.rmSync(tmpDir, { recursive: true, force: true })),
  );

const withFakePiScript = <A, E, R>(
  script: string,
  run: (options: FakePiOptions) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-process-"))),
    (tmpDir) => run(spawnFakePiOptions(tmpDir, script)),
    (tmpDir) => Effect.sync(() => fs.rmSync(tmpDir, { recursive: true, force: true })),
  );

const provideNodeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

describe("PiRpcProcess", () => {
  it.effect("request resolves with the correlated response", () =>
    withFakePi((options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* makePiRpcProcess(options);
          const data = yield* pi.request({ type: "get_state" });
          expect(data).toBeUndefined();
        }),
      ),
    ).pipe(provideNodeServices),
  );

  it.effect("records stream delivers session events emitted before subscription", () =>
    withFakePi((options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* makePiRpcProcess(options);
          const records = yield* Stream.runCollect(Stream.take(pi.records, 1));
          expect(records[0]?.type).toBe("agent_settled");
        }),
      ),
    ).pipe(provideNodeServices),
  );

  it.effect("closeStdin makes the process exit", () =>
    withFakePi((options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* makePiRpcProcess(options);
          yield* pi.closeStdin;
          const code = yield* pi.exited;
          expect(code).toBe(0);
        }),
      ),
    ).pipe(provideNodeServices),
  );

  it.effect("a pending request fails when the process exits", () =>
    withFakePi((options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* makePiRpcProcess(options);
          const fiber = yield* Effect.forkScoped(pi.request({ type: "abort" }));
          yield* pi.closeStdin;
          const code = yield* pi.exited;
          expect(code).toBe(0);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
            expect(error).toBeInstanceOf(PiRpcError);
          }
        }),
      ),
    ).pipe(provideNodeServices),
  );

  it.effect("request succeeds when the final response is flushed just before exit", () =>
    withFakePiScript(FAKE_PI_EXIT_AFTER_RESPONSE_SCRIPT, (options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* makePiRpcProcess(options);
          // The fake writes the response and exits in the write callback, so
          // the exit watcher races the buffered stdout line.
          const data = yield* pi.request({ type: "get_state" });
          expect(data).toBeUndefined();
        }),
      ),
    ).pipe(provideNodeServices),
  );

  it.effect("signal exit fails pending requests with PiRpcError and completes records", () =>
    withFakePiScript(FAKE_PI_SELF_KILL_SCRIPT, (options) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* makePiRpcProcess(options);
          const recordsFiber = yield* Effect.forkScoped(Stream.runCollect(pi.records));
          const requestFiber = yield* Effect.forkScoped(pi.request({ type: "get_state" }));
          const exit = yield* Fiber.await(requestFiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
            expect(error).toBeInstanceOf(PiRpcError);
          }
          const records = yield* Fiber.join(recordsFiber);
          expect(records.length).toBe(0);
        }),
      ),
    ).pipe(provideNodeServices),
  );
});
