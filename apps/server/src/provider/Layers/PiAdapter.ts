/**
 * PiAdapter — per-instance adapter for the Pi coding agent (`pi --mode rpc`).
 *
 * One Pi child process per Termweave thread. The adapter owns the turn
 * lifecycle (docs/pi-rpc.md section 4): it mints a `TurnId` per accepted
 * `prompt`, maps session events through `PiTurnMapper`, answers extension
 * dialogs (approvals via the bundled extension, user inputs from the user's
 * own extensions) and publishes canonical runtime events on a PubSub.
 *
 * Deliberately unwired: the driver, provider snapshot and registration are
 * separate phases; this module only builds the adapter closure.
 *
 * @module PiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeRequestId,
  TurnId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type PiSettings,
  type ThreadId,
} from "@termweave/contracts";
import { getModelSelectionStringOptionValue } from "@termweave/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  ensurePiApprovalExtension,
  parsePiApprovalTitle,
  PI_APPROVAL_TITLE_PREFIX,
  type PiApprovalPayload,
} from "../pi/piApprovalExtension.ts";
import {
  makePiRpcProcess,
  PiRpcCommandError,
  PiRpcError,
  type PiRpcProcess,
} from "../pi/PiRpcProcess.ts";
import { createPiTurnMapper, type PiRuntimeEventDraft } from "../pi/PiTurnMapper.ts";
import type { PiExtensionUiRequest, PiRecord, PiSessionStats } from "../pi/piRpcProtocol.ts";
import { type PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RESUME_CURSOR_VERSION = 1 as const;
const INTERRUPT_ABORT_TIMEOUT = "30 seconds";
const STOP_EXIT_TIMEOUT = "5 seconds";

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this
   * value. Defaults to the built-in instance id (`pi`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Test-only: prepended to Pi's argv so tests can run a fake Pi script
   * through `process.execPath`. Never set in production.
   */
  readonly extraArgsPrefix?: ReadonlyArray<string>;
}

interface PendingApproval {
  readonly piRequestId: string | undefined;
  readonly toolCallId: string;
  readonly requestType: PiApprovalRequestType;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly piRequestId: string | undefined;
  readonly method: string;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly mapper: ReturnType<typeof createPiTurnMapper>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly pi: PiRpcProcess;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turn: ActiveTurn | undefined;
  /**
   * Abort sequence currently in flight (see `abortActiveTurn`). `sendTurn`
   * waits for it before writing the next prompt so a late `abort` can never
   * kill a turn that Pi already settled and the client restarted.
   */
  abortInFlight: Fiber.Fiber<void, never> | undefined;
  thinkingLevel: string | undefined;
  stopped: boolean;
}

type PiApprovalRequestType =
  | "command_execution_approval"
  | "file_change_approval"
  | "dynamic_tool_call";

interface PiUsageSnapshot {
  readonly usedTokens: number;
  readonly maxTokens?: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePiResumeCursor(raw: unknown): { sessionFile: string } | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== PI_RESUME_CURSOR_VERSION) return undefined;
  if (typeof raw.sessionFile !== "string" || !raw.sessionFile.trim()) return undefined;
  return { sessionFile: raw.sessionFile.trim() };
}

/** Pi model ids may contain `/`; split the slug on the first `/` only. */
function splitPiModelSlug(slug: string): { provider: string; modelId: string } | undefined {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return undefined;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

function piApprovalRequestType(toolName: string): PiApprovalRequestType {
  if (toolName === "bash" || toolName === "powershell") return "command_execution_approval";
  if (toolName === "edit" || toolName === "write") return "file_change_approval";
  return "dynamic_tool_call";
}

function piApprovalDetail(payload: PiApprovalPayload): string | undefined {
  if (!isRecord(payload.input)) return undefined;
  for (const key of ["command", "path"]) {
    const value = payload.input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function piErrorText(error: PiRpcError | PiRpcCommandError): string {
  return error._tag === "PiRpcCommandError" ? error.error : error.detail;
}

/** Reason text for a failed `exited` watcher: prefer the `PiRpcError` detail. */
function exitWatcherReason(cause: Cause.Cause<PiRpcError | ProviderAdapterRequestError>): string {
  const reason = cause.reasons[0];
  const error = reason !== undefined && reason._tag === "Fail" ? reason.error : undefined;
  return error instanceof PiRpcError ? error.detail : Cause.pretty(cause);
}

function roundNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

/** `thread.token-usage.updated` usage snapshot derived from `get_session_stats`. */
function piUsageSnapshot(stats: PiSessionStats): PiUsageSnapshot {
  const tokens = stats.tokens ?? {};
  const contextTokens = roundNonNegative(stats.contextUsage?.tokens);
  const contextWindow = roundNonNegative(stats.contextUsage?.contextWindow);
  return {
    usedTokens: contextTokens ?? roundNonNegative(tokens.total) ?? 0,
    ...(contextWindow !== undefined && contextWindow > 0 ? { maxTokens: contextWindow } : {}),
    inputTokens: roundNonNegative(tokens.input) ?? 0,
    cachedInputTokens: roundNonNegative(tokens.cacheRead) ?? 0,
    outputTokens: roundNonNegative(tokens.output) ?? 0,
  };
}

/** User-input answer payload for an `extension_ui_response`; empty answers cancel the dialog. */
function piUserInputResponse(
  method: string,
  answers: ProviderUserInputAnswers,
): Record<string, unknown> {
  if (Object.keys(answers).length === 0) return { cancelled: true };
  if (method === "confirm") return { confirmed: answers.answer === "Yes" };
  return { value: String(answers.answer) };
}

/** Only `select` and `confirm` dialogs reach this: the TUI drops zero-option questions. */
function piUserInputQuestion(record: PiExtensionUiRequest): {
  readonly id: "answer";
  readonly header: "Pi extension";
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
} {
  const method = record.method ?? "";
  const title = typeof record.title === "string" ? record.title : "";
  const message = typeof record.message === "string" ? record.message : "";
  const options =
    method === "select"
      ? (record.options ?? [])
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({ label: option, description: option }))
      : [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ];
  const question =
    method === "confirm"
      ? [title, message].filter((part) => part.trim().length > 0).join("\n")
      : title.trim() || message.trim() || "Pi extension dialog";
  return { id: "answer", header: "Pi extension", question, options };
}

export function makePiAdapter(settings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;

    const environment = options?.environment
      ? Object.fromEntries(
          Object.entries(options.environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
      : undefined;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    /** Stamp an event draft and publish it on the adapter's runtime stream. */
    const publish = (threadId: ThreadId, draft: PiRuntimeEventDraft) =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        yield* PubSub.publish(runtimeEventPubSub, {
          ...draft,
          ...stamp,
          provider: PROVIDER,
          threadId,
          providerInstanceId: boundInstanceId,
        });
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /**
     * Cancel every open dialog: Pi blocks shutdown and abort while a dialog
     * is open, so interrupt and stop always cancel first (doc sections 4/7).
     * The response is sent and the resolved events are published here; the
     * awaiting fibers see their entry gone and exit without re-sending.
     */
    const cancelPendingDialogs = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        for (const [requestId, pending] of Array.from(ctx.pendingApprovals)) {
          ctx.pendingApprovals.delete(requestId);
          if (pending.piRequestId !== undefined) {
            yield* Effect.ignore(
              ctx.pi.send({
                type: "extension_ui_response",
                id: pending.piRequestId,
                cancelled: true,
              }),
            );
          }
          // A cancelled dialog terminates the tool call, same as a `cancel`
          // answer, so the tool item must complete as "declined".
          ctx.turn?.mapper.markDeclined(pending.toolCallId);
          yield* Effect.ignore(Deferred.succeed(pending.decision, "cancel"));
          yield* publish(ctx.threadId, {
            type: "request.resolved",
            turnId: ctx.turn?.turnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision: "cancel" },
          });
        }
        for (const [requestId, pending] of Array.from(ctx.pendingUserInputs)) {
          ctx.pendingUserInputs.delete(requestId);
          if (pending.piRequestId !== undefined) {
            yield* Effect.ignore(
              ctx.pi.send({
                type: "extension_ui_response",
                id: pending.piRequestId,
                cancelled: true,
              }),
            );
          }
          yield* Effect.ignore(Deferred.succeed(pending.answers, {}));
          yield* publish(ctx.threadId, {
            type: "user-input.resolved",
            turnId: ctx.turn?.turnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {} },
          });
        }
      });

    const emitTokenUsage = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const stats = yield* ctx.pi
          .request({ type: "get_session_stats" })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to read Pi session stats", { cause }).pipe(
                Effect.as(undefined),
              ),
            ),
          );
        if (stats === undefined) return;
        yield* publish(ctx.threadId, {
          type: "thread.token-usage.updated",
          payload: { usage: piUsageSnapshot(stats) },
        });
      });

    /** Settle bookkeeping when the mapper reports `agent_settled` (doc section 4). */
    const completeTurn = (ctx: PiSessionContext, turn: ActiveTurn) =>
      Effect.gen(function* () {
        if (ctx.turn !== turn) return;
        ctx.turn = undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: undefined,
          status: "ready",
          updatedAt: yield* nowIso,
        };
        // Publish `ready` before the stats round trip: `sendTurn` gates on
        // `ctx.turn`, so a fast follow-up turn can start between the two and
        // would otherwise be announced running and then stamped idle.
        yield* publish(ctx.threadId, {
          type: "session.state.changed",
          payload: { state: "ready" },
        });
        yield* emitTokenUsage(ctx);
      });

    const handleRecord = (ctx: PiSessionContext, record: PiRecord) =>
      Effect.gen(function* () {
        if (record.type === "extension_ui_request") {
          // `PiUnknownEvent` carries a string `type`, so the check above does
          // not narrow the union on its own.
          yield* handleExtensionUiRequest(ctx, record as PiExtensionUiRequest);
          return;
        }
        const turn = ctx.turn;
        if (!turn) {
          // Startup noise or records of turns this adapter did not start.
          yield* Effect.logDebug("Ignoring Pi record outside an active turn", {
            type: record.type,
          });
          return;
        }
        for (const draft of turn.mapper.map(record)) {
          yield* publish(ctx.threadId, draft);
        }
        if (turn.mapper.settled) {
          yield* completeTurn(ctx, turn);
        }
      });

    const approvalDecisionFiber = (
      ctx: PiSessionContext,
      requestId: ApprovalRequestId,
      pending: PendingApproval,
    ) =>
      Effect.gen(function* () {
        const decision = yield* Deferred.await(pending.decision);
        // When the entry is gone the dialog was cancelled by interrupt/stop or
        // dropped by its timeout, which already emitted the resolved event.
        if (ctx.pendingApprovals.get(requestId) === pending) {
          ctx.pendingApprovals.delete(requestId);
          yield* Effect.ignore(
            ctx.pi.send({
              type: "extension_ui_response",
              id: pending.piRequestId,
              value: decision,
            }),
          );
          if (decision === "decline" || decision === "cancel") {
            ctx.turn?.mapper.markDeclined(pending.toolCallId);
          }
          yield* publish(ctx.threadId, {
            type: "request.resolved",
            turnId: ctx.turn?.turnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision },
          });
          yield* publish(ctx.threadId, {
            type: "session.state.changed",
            payload: { state: "running" },
          });
          if (decision === "cancel") {
            // Pi only stops a tool batch when every result is terminating, so
            // cancelling one approval alongside others would not stop the
            // turn: run the interrupt sequence for it. Not awaited here: the
            // cancelled tool settles the run on its own, and awaiting would
            // make the `request.resolved` publisher race the abort instead of
            // `sendTurn`, which awaits `ctx.abortInFlight` itself.
            yield* abortActiveTurn(ctx);
          }
        }
      });

    const userInputAnswerFiber = (
      ctx: PiSessionContext,
      requestId: ApprovalRequestId,
      pending: PendingUserInput,
    ) =>
      Effect.gen(function* () {
        const answers = yield* Deferred.await(pending.answers);
        if (ctx.pendingUserInputs.get(requestId) === pending) {
          ctx.pendingUserInputs.delete(requestId);
          yield* Effect.ignore(
            ctx.pi.send({
              type: "extension_ui_response",
              id: pending.piRequestId,
              ...piUserInputResponse(pending.method, answers),
            }),
          );
          yield* publish(ctx.threadId, {
            type: "user-input.resolved",
            turnId: ctx.turn?.turnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers },
          });
        }
      });

    const handleApprovalRequest = (ctx: PiSessionContext, record: PiExtensionUiRequest) =>
      Effect.gen(function* () {
        const title = record.title ?? "";
        const payload = parsePiApprovalTitle(title);
        if (!payload) {
          // Prefixed but malformed: cancel so Pi never blocks on a dialog we
          // cannot map to an approval.
          if (record.id !== undefined) {
            yield* Effect.ignore(
              ctx.pi.send({ type: "extension_ui_response", id: record.id, cancelled: true }),
            );
          }
          yield* Effect.logWarning("Failed to parse Pi approval dialog title", { title });
          return;
        }
        if (record.id === undefined) {
          yield* Effect.logWarning("Ignoring Pi approval dialog without a request id", { title });
          return;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const detail = piApprovalDetail(payload);
        const pending: PendingApproval = {
          piRequestId: record.id,
          toolCallId: payload.toolCallId,
          requestType: piApprovalRequestType(payload.toolName),
          decision: yield* Deferred.make<ProviderApprovalDecision>(),
        };
        ctx.pendingApprovals.set(requestId, pending);
        yield* publish(ctx.threadId, {
          type: "request.opened",
          turnId: ctx.turn?.turnId,
          requestId: RuntimeRequestId.make(requestId),
          providerRefs: {
            providerRequestId: record.id,
            providerItemId: ProviderItemId.make(payload.toolCallId),
          },
          payload: {
            requestType: pending.requestType,
            ...(detail !== undefined ? { detail } : {}),
            args: payload.input,
          },
        });
        yield* publish(ctx.threadId, {
          type: "session.state.changed",
          payload: { state: "waiting" },
        });
        yield* approvalDecisionFiber(ctx, requestId, pending).pipe(Effect.forkIn(ctx.scope));
        // Pi auto-resolves dialogs opened with a `timeout`, so drop the entry
        // when it elapses; late answers then fail as unknown requests. The
        // answer fiber skips the resolved event once the entry is gone, so
        // publish it here (without `extension_ui_response`: Pi already
        // resolved the dialog itself).
        const timeoutMs = record.timeout;
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          yield* Effect.gen(function* () {
            yield* Effect.sleep(timeoutMs);
            if (ctx.pendingApprovals.get(requestId) === pending) {
              ctx.pendingApprovals.delete(requestId);
              ctx.turn?.mapper.markDeclined(pending.toolCallId);
              yield* Effect.ignore(Deferred.succeed(pending.decision, "cancel"));
              yield* publish(ctx.threadId, {
                type: "request.resolved",
                turnId: ctx.turn?.turnId,
                requestId: RuntimeRequestId.make(requestId),
                payload: { requestType: pending.requestType, decision: "cancel" },
              });
            }
          }).pipe(Effect.forkIn(ctx.scope));
        }
      });

    const handleUserInputRequest = (ctx: PiSessionContext, record: PiExtensionUiRequest) =>
      Effect.gen(function* () {
        if (record.id === undefined) {
          yield* Effect.logDebug("Ignoring Pi dialog without a request id", {
            method: record.method,
          });
          return;
        }
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const pending: PendingUserInput = {
          piRequestId: record.id,
          method: record.method ?? "",
          answers: yield* Deferred.make<ProviderUserInputAnswers>(),
        };
        ctx.pendingUserInputs.set(requestId, pending);
        yield* publish(ctx.threadId, {
          type: "user-input.requested",
          turnId: ctx.turn?.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { questions: [piUserInputQuestion(record)] },
        });
        yield* userInputAnswerFiber(ctx, requestId, pending).pipe(Effect.forkIn(ctx.scope));
        // Pi auto-resolves dialogs opened with a `timeout`, so drop the entry
        // when it elapses; late answers then fail as unknown requests. The
        // answer fiber skips the resolved event once the entry is gone, so
        // publish it here (without `extension_ui_response`: Pi already
        // resolved the dialog itself).
        const timeoutMs = record.timeout;
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          yield* Effect.gen(function* () {
            yield* Effect.sleep(timeoutMs);
            if (ctx.pendingUserInputs.get(requestId) === pending) {
              ctx.pendingUserInputs.delete(requestId);
              yield* Effect.ignore(Deferred.succeed(pending.answers, {}));
              yield* publish(ctx.threadId, {
                type: "user-input.resolved",
                turnId: ctx.turn?.turnId,
                requestId: RuntimeRequestId.make(requestId),
                payload: { answers: {} },
              });
            }
          }).pipe(Effect.forkIn(ctx.scope));
        }
      });

    const handleNotify = (ctx: PiSessionContext, record: PiExtensionUiRequest) =>
      Effect.gen(function* () {
        const notifyType = typeof record.notifyType === "string" ? record.notifyType : "info";
        const message =
          typeof record.message === "string" && record.message.trim()
            ? record.message.trim()
            : "Pi extension notification";
        // Startup notifies (user extension noise) must not surface as turn
        // warnings; only surface them while a turn is active (doc section 7).
        if ((notifyType === "warning" || notifyType === "error") && ctx.turn) {
          yield* publish(ctx.threadId, {
            type: "runtime.warning",
            turnId: ctx.turn.turnId,
            payload: { message },
          });
          return;
        }
        yield* Effect.logDebug("Pi extension notification", { notifyType, message });
      });

    /**
     * The TUI has no free-text dialog yet (the client drops zero-option
     * questions), so `input`/`editor` dialogs could never be answered and
     * would block Pi forever: cancel them immediately.
     */
    const handleUnsupportedInputRequest = (ctx: PiSessionContext, record: PiExtensionUiRequest) =>
      Effect.gen(function* () {
        if (record.id !== undefined) {
          yield* Effect.ignore(
            ctx.pi.send({ type: "extension_ui_response", id: record.id, cancelled: true }),
          );
        }
        const title =
          typeof record.title === "string" && record.title.trim()
            ? record.title.trim()
            : "Pi extension dialog";
        if (ctx.turn) {
          yield* publish(ctx.threadId, {
            type: "runtime.warning",
            turnId: ctx.turn.turnId,
            payload: {
              message: `Pi extension asked for free-text input (${title}), which Termweave does not support yet; cancelled.`,
            },
          });
          return;
        }
        yield* Effect.logWarning("Cancelled unsupported Pi free-text dialog", {
          method: record.method,
          title,
        });
      });

    const handleExtensionUiRequest = (ctx: PiSessionContext, record: PiExtensionUiRequest) => {
      const method = record.method ?? "";
      if (
        method === "select" &&
        typeof record.title === "string" &&
        record.title.startsWith(PI_APPROVAL_TITLE_PREFIX)
      ) {
        return handleApprovalRequest(ctx, record);
      }
      if (method === "select" || method === "confirm") {
        return handleUserInputRequest(ctx, record);
      }
      if (method === "input" || method === "editor") {
        return handleUnsupportedInputRequest(ctx, record);
      }
      if (method === "notify") return handleNotify(ctx, record);
      // setStatus / setWidget / setTitle / set_editor_text and unknown methods.
      return Effect.logDebug("Ignoring Pi extension UI record", { method });
    };

    const handleProcessExit = (ctx: PiSessionContext, reason: string) =>
      Effect.gen(function* () {
        // Only the registered session reports an unexpected exit; a context
        // whose startSession failed (or that was replaced) is already handled.
        if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        ctx.session = { ...ctx.session, status: "error", lastError: reason };
        yield* publish(ctx.threadId, {
          type: "session.exited",
          payload: { exitKind: "error", reason },
        });
        const turn = ctx.turn;
        if (turn) {
          ctx.turn = undefined;
          ctx.session = { ...ctx.session, activeTurnId: undefined };
          yield* publish(ctx.threadId, {
            type: "turn.completed",
            turnId: turn.turnId,
            payload: { state: "failed", errorMessage: reason },
          });
        }
        yield* cancelPendingDialogs(ctx);
        // This watcher runs outside the session scope, so closing here releases
        // the process handles and the record-loop fiber that outlived the exit.
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      });

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.session = { ...ctx.session, status: "closed" };
        yield* cancelPendingDialogs(ctx);
        yield* Effect.ignore(ctx.pi.closeStdin);
        yield* ctx.pi.exited.pipe(
          Effect.timeoutOption(STOP_EXIT_TIMEOUT),
          Effect.tap((exited) =>
            Option.isNone(exited)
              ? Effect.logWarning("Pi did not exit within the stop grace period", {
                  threadId: ctx.threadId,
                })
              : Effect.void,
          ),
          Effect.ignore,
        );
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* publish(ctx.threadId, { type: "session.exited", payload: { exitKind: "graceful" } });
      });

    /**
     * Apply a bound model selection: `set_model` with the slug split on the
     * first `/`, then `set_thinking_level` from the `thinking` option. Only
     * values that differ from the session's current ones are sent.
     */
    const applyModelSelection = (
      ctx: PiSessionContext,
      modelSelection: ModelSelection | undefined,
    ) =>
      Effect.gen(function* () {
        if (!modelSelection || modelSelection.instanceId !== boundInstanceId) return;
        if (modelSelection.model !== ctx.session.model) {
          const split = splitPiModelSlug(modelSelection.model);
          if (!split) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "set_model",
              detail: `Invalid Pi model slug '${modelSelection.model}'; expected <provider>/<id>.`,
            });
          }
          yield* ctx.pi
            .request({ type: "set_model", provider: split.provider, modelId: split.modelId })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_model",
                    detail: piErrorText(cause),
                    cause,
                  }),
              ),
            );
          ctx.session = { ...ctx.session, model: modelSelection.model };
        }
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (thinking !== undefined && thinking !== ctx.thinkingLevel) {
          yield* ctx.pi.request({ type: "set_thinking_level", level: thinking }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "set_thinking_level",
                  detail: piErrorText(cause),
                  cause,
                }),
            ),
          );
          ctx.thinkingLevel = thinking;
        }
      });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const args = [...(options?.extraArgsPrefix ?? []), "--mode", "rpc"];
          const resume = parsePiResumeCursor(input.resumeCursor);
          let resumed = false;
          if (resume) {
            const sessionFileExists = yield* fileSystem.exists(resume.sessionFile).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            if (sessionFileExists) {
              args.push("--session", resume.sessionFile);
              resumed = true;
            }
          }
          if (input.resumeCursor !== undefined && !resumed) {
            // Malformed cursor or missing session file: start fresh, but say so.
            yield* publish(input.threadId, {
              type: "runtime.warning",
              payload: { message: "Pi session file not found, starting a new session" },
            });
          }
          if (input.runtimeMode === "approval-required") {
            const extensionPath = yield* ensurePiApprovalExtension(serverConfig.stateDir).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            args.push("-e", extensionPath);
          }

          const pi = yield* makePiRpcProcess({
            binaryPath: settings.binaryPath,
            args,
            cwd,
            ...(environment ? { env: environment } : {}),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.detail,
                  cause,
                }),
            ),
          );

          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
          };
          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            pi,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            turn: undefined,
            abortInFlight: undefined,
            thinkingLevel: undefined,
            stopped: false,
          };

          yield* Stream.runForEach(pi.records, (record) =>
            handleRecord(ctx, record).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to handle Pi record", { cause, record }),
              ),
            ),
          ).pipe(Effect.forkIn(sessionScope));
          // The exit watcher must survive a scope close (it closes the scope
          // itself on an unexpected exit), so it runs detached. It exits as
          // soon as the process does, so it cannot leak. `exited` fails on a
          // signal exit or transport death, so both outcomes must run the
          // same cleanup.
          yield* pi.exited.pipe(
            Effect.flatMap((code) => handleProcessExit(ctx, `Pi exited with code ${code}`)),
            Effect.catchCause((cause) =>
              handleProcessExit(ctx, `Pi process terminated: ${exitWatcherReason(cause)}`).pipe(
                Effect.catch(() => Effect.void),
              ),
            ),
            Effect.forkDetach,
          );

          yield* applyModelSelection(
            ctx,
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined,
          );
          const state = yield* pi.request({ type: "get_state" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "get_state",
                  detail: piErrorText(cause),
                  cause,
                }),
            ),
          );
          if (typeof state.sessionFile === "string" && state.sessionFile.trim()) {
            ctx.session = {
              ...ctx.session,
              resumeCursor: {
                schemaVersion: PI_RESUME_CURSOR_VERSION,
                sessionFile: state.sessionFile,
              },
            };
          }
          if (
            state.model !== undefined &&
            state.model.id !== "unknown" &&
            typeof state.model.id === "string" &&
            state.model.id.length > 0
          ) {
            ctx.session = { ...ctx.session, model: `${state.model.provider}/${state.model.id}` };
          }
          if (typeof state.thinkingLevel === "string") {
            ctx.thinkingLevel = state.thinkingLevel;
          }

          // Register only after the fallible tail: a failed set_model or
          // get_state must leave no phantom session behind (the startSession
          // scope finalizer then closes the scope and kills the process).
          sessions.set(input.threadId, ctx);
          scopeTransferred = true;

          yield* publish(input.threadId, { type: "session.started", payload: { resume: state } });
          yield* publish(input.threadId, {
            type: "session.state.changed",
            payload: { state: "ready", reason: "Pi RPC session ready" },
          });
          yield* publish(input.threadId, {
            type: "thread.started",
            payload:
              typeof state.sessionId === "string" ? { providerThreadId: state.sessionId } : {},
          });

          return ctx.session;
        }).pipe(Effect.scoped),
      );

    const failPrompt = (
      ctx: PiSessionContext,
      turnId: TurnId,
      cause: PiRpcError | PiRpcCommandError,
    ) =>
      Effect.gen(function* () {
        const text = piErrorText(cause);
        if (ctx.turn?.turnId === turnId) {
          ctx.turn = undefined;
          ctx.session = { ...ctx.session, activeTurnId: undefined, status: "ready" };
        }
        yield* publish(ctx.threadId, {
          type: "runtime.error",
          turnId,
          payload: { message: text, class: "provider_error" },
        });
        // `turn.started` was already announced, so close the turn: it must
        // never stay open.
        yield* publish(ctx.threadId, {
          type: "turn.completed",
          turnId,
          payload: { state: "failed", errorMessage: text },
        });
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: text,
          cause,
        });
      });

    const loadTurnImages = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        if (!input.attachments || input.attachments.length === 0) return undefined;
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        for (const attachment of input.attachments) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return images;
      });

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.turn !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: "A Pi turn is already running.",
          });
        }
        // The previous turn may have been cancelled or interrupted and its
        // `abort` round trip may still be in flight. Pi settles the aborted
        // turn on its own, so the client can already send the next turn while
        // the abort is still being written; Pi processes stdin commands in
        // order, so the abort must go out before the new prompt or it kills
        // the new turn instead of the old one.
        if (ctx.abortInFlight !== undefined) yield* Fiber.await(ctx.abortInFlight);
        yield* applyModelSelection(
          ctx,
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined,
        );
        const message = input.input?.trim() ?? "";
        const images = yield* loadTurnImages(input);
        if (message.length === 0 && (images === undefined || images.length === 0)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const turnId = TurnId.make(yield* randomUUIDv4);
        // Re-check and set with no yield in between so concurrent sends cannot
        // both pass the gate.
        if (ctx.turn !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: "A Pi turn is already running.",
          });
        }
        // Set before the prompt is written so no record can arrive unmapped.
        ctx.turn = { turnId, mapper: createPiTurnMapper({ turnId }) };
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          status: "running",
          updatedAt: yield* nowIso,
        };
        // Ingestion expects `turn.started` first: the record loop publishes
        // turn events as soon as `ctx.turn` is set, so announce the turn
        // before the prompt is written.
        const model = ctx.session.model;
        yield* publish(input.threadId, {
          type: "turn.started",
          turnId,
          payload: model !== undefined ? { model } : {},
        });
        const result = yield* ctx.pi
          .request({
            type: "prompt",
            message,
            ...(images !== undefined && images.length > 0 ? { images } : {}),
          })
          .pipe(Effect.catch((cause) => failPrompt(ctx, turnId, cause)));
        if (result.disposition === "handled") {
          // An extension command consumed the prompt; no agent run follows and
          // no `agent_settled` will arrive, so complete the turn here.
          if (ctx.turn?.turnId === turnId) {
            ctx.turn = undefined;
            ctx.session = { ...ctx.session, activeTurnId: undefined, status: "ready" };
          }
          yield* publish(input.threadId, {
            type: "turn.completed",
            turnId,
            payload: { state: "completed" },
          });
        }
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    /**
     * Doc section 4 interrupt sequence: mark the turn interrupted, cancel open
     * dialogs (Pi blocks abort while one is open), drop queued turns and
     * abort. Shared by `interruptTurn` and cancelled approvals, since Pi only
     * stops a tool batch when every result is terminating.
     *
     * Forked into the session scope and tracked as `ctx.abortInFlight`:
     * callers may fire-and-forget it (cancelled approvals, where the aborted
     * tool settles the run on its own), while `sendTurn` awaits the tracker so
     * the late `abort` is always written before the next `prompt`.
     */
    const abortActiveTurn = (
      ctx: PiSessionContext,
    ): Effect.Effect<Fiber.Fiber<void, never> | undefined> =>
      Effect.gen(function* () {
        const turn = ctx.turn;
        if (!turn) return undefined;
        let fiber: Fiber.Fiber<void, never> | undefined;
        const sequence = Effect.gen(function* () {
          turn.mapper.markInterruptRequested();
          // Dialog-cancel bookkeeping publishes events and can fail on event
          // stamping; swallowed so the forked fiber stays `Fiber<void, never>`
          // and the `abort` below is still sent.
          yield* cancelPendingDialogs(ctx).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to cancel pending Pi dialogs", { cause }),
            ),
          );
          yield* Effect.ignore(ctx.pi.request({ type: "clear_queue" }));
          yield* ctx.pi.request({ type: "abort" }).pipe(
            Effect.timeoutOption(INTERRUPT_ABORT_TIMEOUT),
            Effect.tap((aborted) =>
              Option.isNone(aborted)
                ? Effect.logWarning("Pi abort did not respond within the interrupt timeout", {
                    threadId: ctx.threadId,
                  })
                : Effect.void,
            ),
            Effect.ignore,
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (fiber !== undefined && ctx.abortInFlight === fiber) {
                ctx.abortInFlight = undefined;
              }
            }),
          ),
        );
        fiber = yield* sequence.pipe(Effect.forkIn(ctx.scope));
        ctx.abortInFlight = fiber;
        return fiber;
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const fiber = yield* abortActiveTurn(ctx);
        if (fiber !== undefined) yield* Fiber.await(fiber);
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const data = yield* ctx.pi.request({ type: "get_messages" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_messages",
                detail: piErrorText(cause),
                cause,
              }),
          ),
        );
        return { threadId, turns: groupPiMessagesIntoTurns(data.messages) };
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (ctx.turn !== undefined) {
          // A fork swaps the live session file under the running turn.
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "fork",
            detail: "A Pi turn is already running.",
          });
        }
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const forkMessages = yield* ctx.pi.request({ type: "get_fork_messages" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_fork_messages",
                detail: piErrorText(cause),
                cause,
              }),
          ),
        );
        const entryIndex = forkMessages.messages.length - numTurns;
        if (entryIndex < 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Cannot roll back ${numTurns} turns; the thread only has ${forkMessages.messages.length}.`,
          });
        }
        const entryId = forkMessages.messages[entryIndex]?.entryId;
        if (typeof entryId !== "string" || !entryId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Pi fork entry at index ${entryIndex} has no entryId.`,
          });
        }
        const forkResult = yield* ctx.pi.request({ type: "fork", entryId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "fork",
                detail: piErrorText(cause),
                cause,
              }),
          ),
        );
        if (forkResult.cancelled) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "fork",
            detail: "Pi extension cancelled the fork.",
          });
        }
        const state = yield* ctx.pi.request({ type: "get_state" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_state",
                detail: piErrorText(cause),
                cause,
              }),
          ),
        );
        if (typeof state.sessionFile === "string" && state.sessionFile.trim()) {
          ctx.session = {
            ...ctx.session,
            resumeCursor: {
              schemaVersion: PI_RESUME_CURSOR_VERSION,
              sessionFile: state.sessionFile,
            },
            updatedAt: yield* nowIso,
          };
        }
        return yield* readThread(threadId);
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to stop Pi session during adapter shutdown", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies PiAdapterShape;
  });
}

/** `get_messages` -> thread snapshot: user messages start turns, the rest follows. */
function groupPiMessagesIntoTurns(
  messages: ReadonlyArray<unknown>,
): Array<{ id: TurnId; items: ReadonlyArray<unknown> }> {
  const turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }> = [];
  let current: { id: TurnId; items: Array<unknown> } | undefined;
  for (const message of messages) {
    const role = isRecord(message) ? message.role : undefined;
    if (role === "system") continue;
    if (role === "user" || current === undefined) {
      current = { id: TurnId.make(`pi-turn-${turns.length}`), items: [] };
      turns.push(current);
    }
    current.items.push(message);
  }
  return turns;
}
