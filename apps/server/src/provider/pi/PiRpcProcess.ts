/**
 * `PiRpcProcess` spawns one `pi --mode rpc` child process and exposes a small
 * command/response plus event-stream surface over its stdio JSONL framing.
 *
 * Usage: run `makePiRpcProcess` inside a scope, subscribe to `records` before
 * sending anything, then use `request` for commands and `send` for
 * fire-and-forget records (extension UI responses). Closing stdin with
 * `closeStdin` shuts Pi down in an orderly way; `exited` completes with the
 * exit code. Pending `request`s fail with `PiRpcError` when the process exits.
 */
import { Cause, Data, Deferred, Effect, Queue, Ref, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  parsePiRecord,
  type PiCommand,
  type PiRecord,
  type PiResponse,
  type PiResponseData,
} from "./piRpcProtocol.ts";

const STDERR_TAIL_LIMIT = 4 * 1024;

type PendingResponse = Deferred.Deferred<unknown, PiRpcError | PiRpcCommandError>;

/** Transport-level failure: spawn failure, closed stdin or unexpected exit. */
export class PiRpcError extends Data.TaggedError("PiRpcError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** The command reached Pi but Pi reported `success: false`. */
export class PiRpcCommandError extends Data.TaggedError("PiRpcCommandError")<{
  readonly command: string;
  readonly error: string;
}> {}

export interface PiRpcProcess {
  /** Send a command, wait for the response with the same id. Fails with PiRpcCommandError on success:false. */
  readonly request: <C extends PiCommand>(
    command: C,
  ) => Effect.Effect<PiResponseData<C>, PiRpcError | PiRpcCommandError>;
  /** Fire-and-forget write (used for extension_ui_response). */
  readonly send: (record: object) => Effect.Effect<void, PiRpcError>;
  /** Every non-response stdout record (session events and extension_ui_request), in order. */
  readonly records: Stream.Stream<PiRecord>;
  /** Close stdin (orderly shutdown). */
  readonly closeStdin: Effect.Effect<void>;
  /** Completes when the process exits, with the exit code. */
  readonly exited: Effect.Effect<number, PiRpcError>;
}

export interface PiRpcProcessOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

const encoder = new TextEncoder();

export const makePiRpcProcess: (
  options: PiRpcProcessOptions,
) => Effect.Effect<
  PiRpcProcess,
  PiRpcError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> = Effect.fn("makePiRpcProcess")(function* (options: PiRpcProcessOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(options.binaryPath, [...options.args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: process.platform === "win32",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcError({ detail: `Failed to spawn Pi process: ${options.binaryPath}`, cause }),
      ),
    );

  // stdin is a queue of encoded JSONL lines; `Queue.end` closes the pipe.
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  yield* Stream.fromQueue(stdin).pipe(
    Stream.run(child.stdin),
    Effect.catchCause(() => Effect.void),
    Effect.forkIn(scope),
  );

  // Records emitted before the adapter subscribes must be buffered, so the
  // stream is backed by a queue drained by one consumer.
  const recordQueue = yield* Queue.unbounded<PiRecord, Cause.Done>();
  const pendingRef = yield* Ref.make<Map<string, PendingResponse>>(new Map());
  const exitedRef = yield* Ref.make(false);
  const exited = yield* Deferred.make<number, PiRpcError>();
  const stderrTailRef = yield* Ref.make("");

  const failPending = (detail: string, cause?: unknown) =>
    Ref.getAndSet(pendingRef, new Map<string, PendingResponse>()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          pending.values(),
          (deferred) =>
            Deferred.fail(deferred, new PiRpcError({ detail, cause })).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

  yield* child.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.gen(function* () {
        yield* Ref.set(exitedRef, true);
        const stderrTail = yield* Ref.get(stderrTailRef);
        yield* Effect.logDebug("Pi process exited", {
          exitCode: code,
          ...(stderrTail.trim().length > 0 ? { stderr: stderrTail } : {}),
        });
        yield* failPending(`Pi process exited with code ${Number(code)}`);
        yield* Deferred.succeed(exited, Number(code));
        yield* Queue.end(recordQueue);
      }),
    ),
    Effect.catchCause((cause) =>
      Deferred.fail(
        exited,
        new PiRpcError({ detail: "Failed to read Pi process exit code", cause }),
      ),
    ),
    Effect.forkIn(scope),
  );

  // stderr is diagnostics only: keep a tail for error reports, never parse it.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrTailRef, (current) => (current + chunk).slice(-STDERR_TAIL_LIMIT)),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.forkIn(scope),
  );

  const handleResponse = (response: PiResponse) =>
    Effect.gen(function* () {
      if (response.id === undefined) {
        yield* Effect.logDebug("Ignoring Pi response without id", { response });
        return;
      }
      const id = response.id;
      const pending = yield* Ref.get(pendingRef);
      const deferred = pending.get(id);
      if (deferred === undefined) {
        yield* Effect.logDebug("Ignoring Pi response with unknown id", { id, response });
        return;
      }
      yield* Ref.update(pendingRef, (current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      if (response.success === false) {
        yield* Deferred.fail(
          deferred,
          new PiRpcCommandError({
            command: response.command ?? "unknown",
            error: response.error ?? "Pi command failed",
          }),
        ).pipe(Effect.ignore);
        return;
      }
      yield* Deferred.succeed(deferred, response.data).pipe(Effect.ignore);
    });

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const record = parsePiRecord(line);
      if (record === undefined) {
        return Effect.void;
      }
      if (record.type === "response") {
        // `PiUnknownEvent` carries a string `type`, so the check above does
        // not narrow the union on its own.
        return handleResponse(record as PiResponse);
      }
      return Queue.offer(recordQueue, record).pipe(Effect.asVoid);
    }),
    Effect.catchCause((cause) => Effect.logWarning("Pi stdout reader failed", { cause })),
    Effect.forkIn(scope),
  );

  const writeLine = (record: object) =>
    Queue.offer(stdin, encoder.encode(`${JSON.stringify(record)}\n`)).pipe(
      Effect.flatMap((offered) =>
        offered ? Effect.void : Effect.fail(new PiRpcError({ detail: "Pi stdin is closed" })),
      ),
    );

  // Ids only grow inside the synchronous prefix of `request`, so a plain
  // counter is race-free.
  let nextCommandId = 0;

  const request = <C extends PiCommand>(
    command: C,
  ): Effect.Effect<PiResponseData<C>, PiRpcError | PiRpcCommandError> =>
    Effect.gen(function* () {
      const id = String(++nextCommandId);
      const deferred = yield* Deferred.make<unknown, PiRpcError | PiRpcCommandError>();
      yield* Ref.update(pendingRef, (current) => new Map(current).set(id, deferred));
      const offered = yield* Queue.offer(
        stdin,
        encoder.encode(`${JSON.stringify({ ...command, id })}\n`),
      );
      if (!offered) {
        yield* Ref.update(pendingRef, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        return yield* new PiRpcError({ detail: "Pi stdin is closed" });
      }
      // The exit watcher may have drained the pending map before we registered.
      if (yield* Ref.get(exitedRef)) {
        return yield* new PiRpcError({ detail: "Pi process exited before the response arrived" });
      }
      const data = yield* Deferred.await(deferred);
      return data as PiResponseData<C>;
    });

  return {
    request,
    send: writeLine,
    records: Stream.fromQueue(recordQueue),
    closeStdin: Queue.end(stdin).pipe(Effect.asVoid),
    exited: Deferred.await(exited),
  } satisfies PiRpcProcess;
});
