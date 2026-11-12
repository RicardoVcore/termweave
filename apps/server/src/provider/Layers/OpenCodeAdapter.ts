import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ToolLifecycleItemType,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@termweave/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { FormInfo1, OpenCodeClient, OpenCodeEvent, PermissionAsked } from "@opencode/client";
import { getModelSelectionStringOptionValue } from "@termweave/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeFormFieldId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodeFormAnswers,
  toOpenCodePermissionReply,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";

const PROVIDER = ProviderDriverKind.make("opencode");

/** Default OpenCode 2.x agent id, used to reset in-session agent switches. */
const DEFAULT_OPENCODE_AGENT = "build";

type OpenCodeSubscribedEvent = OpenCodeEvent;

type OpenCodePermissionAsked = PermissionAsked["data"];
type OpenCodeForm = FormInfo1;

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpenCodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, OpenCodePermissionAsked>;
  readonly pendingQuestions: Map<string, OpenCodeForm>;
  /** OpenCode tool name per in-flight tool call id, populated by `session.tool.input.started`. */
  readonly toolNamesByCallId: Map<string, string>;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * Agent currently active on the OpenCode server for this session. 2.x
   * agent/variant selection is session state, so we track what we last
   * switched to and only issue `session.switchAgent` on change.
   */
  serverAgent: string | undefined;
  /**
   * Model (provider/model slug plus variant) currently active on the OpenCode
   * server for this session. Set from the model passed to `session.create`,
   * then kept in sync so `session.switchModel` only fires on change.
   */
  serverModel: { readonly model: string; readonly variant: string | undefined } | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

/** Map an OpenCode tool name to the canonical runtime item type used by the TUI. */
function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

/**
 * Stable runtime item id for a streamed text/reasoning part. The part kind is
 * part of the id: a text block and a reasoning block share the ordinal series
 * per assistant message, so the ids would otherwise collide.
 */
function contentItemId(
  kind: "text" | "reasoning",
  data: { assistantMessageID: string; ordinal: number },
): string {
  return `${data.assistantMessageID}:${kind}:${data.ordinal}`;
}

/** Join the text entries of a 2.x tool `content` payload into one detail string. */
function toolDetailFromContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("");
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  // `ensureSessionContext` is a sync gate used from both sync helpers and
  // Effect bodies. `Ref.getUnsafe` is an atomic read of the backing cell -
  // no fiber suspension required, which keeps this callable everywhere.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
}

function formAnswerToDisplay(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function toOpenCodeFormQuestions(form: OpenCodeForm): ReadonlyArray<UserInputQuestion> {
  return form.fields.map((field, index) => ({
    id: openCodeFormFieldId(field, index),
    header: field.title ?? field.key,
    question: field.description ?? field.title ?? field.key,
    options: (
      (field.type === "string" || field.type === "multiselect" ? field.options : undefined) ?? []
    ).map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
    })),
    ...(field.type === "multiselect" ? { multiSelect: true } : {}),
  }));
}

function sessionErrorMessage(error: unknown): string {
  const message =
    error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message.trim()
      : "";
  return message.length > 0 ? message : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* runOpenCodeSdk("session.interrupt", () =>
    context.client.session.interrupt({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered - the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* runOpenCodeSdk("session.interrupt", () =>
        context.client.session.interrupt({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.ignore({ log: true }));
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /**
     * Emit turn.completed exactly once per turn, keyed on the still-active
     * turn id. `"failed"` additionally marks the session errored: status
     * `error` with `lastError` set and the error surfaced in the payload, and
     * the session update happens even without an active turn.
     */
    const completeTurn = Effect.fn("completeTurn")(function* (
      context: OpenCodeSessionContext,
      state: "completed" | "interrupted" | "failed",
      raw: unknown,
      errorMessage?: string,
    ) {
      const turnId = context.activeTurnId;
      if (!turnId && state !== "failed") {
        return;
      }
      context.activeTurnId = undefined;
      yield* updateProviderSession(
        context,
        state === "failed"
          ? { status: "error", lastError: errorMessage ?? "OpenCode session failed." }
          : { status: "ready" },
        { clearActiveTurnId: true },
      );
      if (!turnId) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId, raw })),
        type: "turn.completed",
        payload: {
          state,
          ...(state === "failed" && errorMessage ? { errorMessage } : {}),
        },
      });
    });

    /**
     * Turn lifecycle. 2.x `session.execution.*` markers are the single source of
     * truth for turn completion; `session.status` idle and `session.idle` only
     * flip the session back to ready.
     */
    const handleTurnLifecycleEvent = Effect.fn("handleTurnLifecycleEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "session.execution.started": {
          yield* updateProviderSession(context, {
            status: "running",
            activeTurnId: turnId,
          });
          break;
        }

        case "session.execution.succeeded": {
          yield* completeTurn(context, "completed", event);
          break;
        }

        case "session.execution.interrupted": {
          yield* completeTurn(context, "interrupted", event);
          break;
        }

        case "session.execution.failed": {
          const message = sessionErrorMessage(event.data.error);
          yield* completeTurn(context, "failed", event, message);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.data.error,
            },
          });
          break;
        }

        case "session.status": {
          if (event.data.status.type === "busy") {
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.data.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.data.status.message,
                detail: event.data.status,
              },
            });
            break;
          }

          if (event.data.status.type === "idle") {
            yield* updateProviderSession(context, { status: "ready" });
          }
          break;
        }

        case "session.idle": {
          yield* updateProviderSession(context, { status: "ready" });
          break;
        }
      }
    });

    /**
     * Streaming assistant text and reasoning. Each `(assistantMessageID, ordinal)`
     * pair is one runtime item; `session.text.ended` carries the final text as
     * the source of truth and closes the assistant-message item.
     */
    const handleContentEvent = Effect.fn("handleContentEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "session.text.started":
        case "session.reasoning.started":
        case "session.reasoning.ended": {
          break;
        }

        case "session.text.delta":
        case "session.reasoning.delta": {
          if (event.data.delta.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: contentItemId(
                event.type === "session.text.delta" ? "text" : "reasoning",
                event.data,
              ),
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: event.type === "session.text.delta" ? "assistant_text" : "reasoning_text",
              delta: event.data.delta,
            },
          });
          break;
        }

        case "session.text.ended": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: contentItemId("text", event.data),
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(event.data.text.length > 0 ? { detail: event.data.text } : {}),
            },
          });
          break;
        }
      }
    });

    /** Emit one tool lifecycle item derived from a `session.tool.*` event. */
    const emitToolItem = Effect.fn("emitToolItem")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
      itemId: string,
      toolName: string,
      type: "item.started" | "item.updated" | "item.completed",
      status: "inProgress" | "completed" | "failed",
      extra?: { readonly detail?: string; readonly data?: unknown },
    ) {
      const detail = extra?.detail ?? "";
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          itemId,
          raw: event,
        })),
        type,
        payload: {
          itemType: toToolLifecycleItemType(toolName),
          status,
          title: toolName,
          ...(detail.length > 0 ? { detail } : {}),
          ...(extra?.data !== undefined ? { data: extra.data } : {}),
        },
      });
    });

    /** Tool lifecycle: input.started -> called (input) -> success/failed. */
    const handleToolEvent = Effect.fn("handleToolEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      switch (event.type) {
        case "session.tool.input.started": {
          context.toolNamesByCallId.set(event.data.id, event.data.name);
          yield* emitToolItem(
            context,
            event,
            event.data.id,
            event.data.name,
            "item.started",
            "inProgress",
            { data: { tool: event.data.name } },
          );
          break;
        }

        case "session.tool.called": {
          const toolName = context.toolNamesByCallId.get(event.data.id) ?? "unknown";
          yield* emitToolItem(
            context,
            event,
            event.data.id,
            toolName,
            "item.updated",
            "inProgress",
            {
              data: { tool: toolName, input: event.data.input },
            },
          );
          break;
        }

        case "session.tool.success": {
          const toolName = context.toolNamesByCallId.get(event.data.id) ?? "unknown";
          context.toolNamesByCallId.delete(event.data.id);
          yield* emitToolItem(
            context,
            event,
            event.data.id,
            toolName,
            "item.completed",
            "completed",
            {
              detail: toolDetailFromContent(event.data.content),
              data: { tool: toolName },
            },
          );
          break;
        }

        case "session.tool.failed": {
          const toolName = context.toolNamesByCallId.get(event.data.id) ?? "unknown";
          context.toolNamesByCallId.delete(event.data.id);
          yield* emitToolItem(context, event, event.data.id, toolName, "item.completed", "failed", {
            detail: event.data.error.message,
            data: { tool: toolName, error: event.data.error },
          });
          break;
        }
      }
    });

    /** Approval and form (user-input) protocol events. */
    const handleProtocolEvent = Effect.fn("handleProtocolEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "permission.asked": {
          context.pendingPermissions.set(event.data.id, event.data);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.data.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.data.action),
              detail:
                event.data.message ??
                (event.data.resources.length > 0
                  ? event.data.resources.join("\n")
                  : event.data.action),
              args: event.data.metadata,
            },
          });
          break;
        }

        case "permission.replied": {
          context.pendingPermissions.delete(event.data.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.data.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(event.data.reply),
            },
          });
          break;
        }

        case "form.created": {
          const form = event.data.form;
          context.pendingQuestions.set(form.id, form);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: form.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: toOpenCodeFormQuestions(form),
            },
          });
          break;
        }

        case "form.replied": {
          const form = context.pendingQuestions.get(event.data.id);
          context.pendingQuestions.delete(event.data.id);
          const answers = Object.fromEntries(
            (form?.fields ?? []).map((field, index) => [
              openCodeFormFieldId(field, index),
              formAnswerToDisplay(event.data.answer[field.key]),
            ]),
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.data.id,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }

        case "form.cancelled": {
          context.pendingQuestions.delete(event.data.id);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.data.id,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          break;
        }
      }
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const payloadSessionId =
        "sessionID" in event.data && typeof event.data.sessionID === "string"
          ? event.data.sessionID
          : undefined;
      if (payloadSessionId !== context.openCodeSessionId) {
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      switch (event.type) {
        case "session.execution.started":
        case "session.execution.succeeded":
        case "session.execution.interrupted":
        case "session.execution.failed":
        case "session.status":
        case "session.idle":
          yield* handleTurnLifecycleEvent(context, event);
          break;

        case "session.text.started":
        case "session.text.delta":
        case "session.text.ended":
        case "session.reasoning.started":
        case "session.reasoning.delta":
        case "session.reasoning.ended":
          yield* handleContentEvent(context, event);
          break;

        case "session.tool.input.started":
        case "session.tool.called":
        case "session.tool.success":
        case "session.tool.failed":
          yield* handleToolEvent(context, event);
          break;

        case "permission.asked":
        case "permission.replied":
        case "form.created":
        case "form.replied":
        case "form.cancelled":
          yield* handleProtocolEvent(context, event);
          break;

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes - no bookkeeping required.
      // 2.x `event.subscribe` returns the AsyncIterable directly and shares
      // one server-wide stream; `handleSubscribedEvent` filters by sessionID.
      yield* Stream.fromAsyncIterable(
        context.client.event.subscribe({ signal: eventsAbortController.signal }),
        (cause) =>
          new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      )
        .pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event)))
        .pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              // Expected paths: caller aborted the fetch or the session
              // has already been marked stopped. Treat as a clean exit.
              if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
                return;
              }
              if (Exit.isFailure(exit)) {
                yield* emitUnexpectedExit(
                  context,
                  openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
                );
              }
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        // Seed the server-side model state from the initial selection so the
        // first `sendTurn` does not issue a redundant `session.switchModel`.
        const initialModelParsed = parseOpenCodeModelSlug(input.modelSelection?.model);
        const initialVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below - closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                serverUrl,
                ...(serverPassword ? { serverPassword } : {}),
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                ...(server.password ? { serverPassword: server.password } : {}),
              });
              // 2.x: directory is per call, and the session is returned directly.
              const openCodeSession = yield* runOpenCodeSdk("session.create", () =>
                client.session.create({
                  title: `Termweave ${input.threadId}`,
                  location: { directory },
                  permissions: buildOpenCodePermissionRules(input.runtimeMode),
                  ...(initialModelParsed
                    ? {
                        model: {
                          providerID: initialModelParsed.providerID,
                          id: initialModelParsed.modelID,
                          ...(initialVariant ? { variant: initialVariant } : {}),
                        },
                      }
                    : {}),
                }),
              );
              return {
                sessionScope,
                server,
                client,
                openCodeSession,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        // Guard against a concurrent startSession call that may have raced
        // and already inserted a session while we were awaiting async work.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another call won the race – clean up the session we just created
          // (including the remote SDK session) and return the existing one.
          yield* runOpenCodeSdk("session.interrupt", () =>
            started.client.session.interrupt({
              sessionID: started.openCodeSession.id,
            }),
          ).pipe(Effect.ignore);
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          toolNamesByCallId: new Map(),
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          serverAgent: undefined,
          serverModel: initialModelParsed
            ? {
                model: `${initialModelParsed.providerID}/${initialModelParsed.modelID}`,
                variant: initialVariant,
              }
            : undefined,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      const turnId = TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      context.activeTurnId = turnId;
      context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
      context.activeVariant = variant;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          model: modelSelection?.model ?? context.session.model,
          ...(variant ? { effort: variant } : {}),
        },
      });

      // 2.x: model/agent/variant are session state, switched before prompting.
      // Variant rides on the model ref; omitting it resets to the model default.
      // The server already runs the model given at `session.create`, so
      // `session.switchModel` only fires when the requested model/variant
      // differs from what we last set on the server.
      const desiredModel = {
        model: `${parsedModel.providerID}/${parsedModel.modelID}`,
        variant,
      };
      // A failure anywhere in the sequence (switch or prompt) runs the shared
      // cleanup: clear active-turn state, flip the session back to ready with
      // lastError set, emit turn.aborted, then let the typed error propagate.
      yield* Effect.gen(function* () {
        if (
          context.serverModel?.model !== desiredModel.model ||
          context.serverModel?.variant !== desiredModel.variant
        ) {
          yield* runOpenCodeSdk("session.switchModel", () =>
            context.client.session.switchModel({
              sessionID: context.openCodeSessionId,
              model: {
                providerID: parsedModel.providerID,
                id: parsedModel.modelID,
                ...(variant ? { variant } : {}),
              },
            }),
          ).pipe(Effect.mapError(toRequestError));
          context.serverModel = desiredModel;
        }

        // `build` is the 2.x default agent; reset to it when a previous turn
        // switched the session onto a named agent.
        const turnAgent = context.activeAgent;
        const desiredAgent =
          turnAgent ?? (context.serverAgent !== undefined ? DEFAULT_OPENCODE_AGENT : undefined);
        if (desiredAgent !== undefined && desiredAgent !== context.serverAgent) {
          yield* runOpenCodeSdk("session.switchAgent", () =>
            context.client.session.switchAgent({
              sessionID: context.openCodeSessionId,
              agent: desiredAgent,
            }),
          ).pipe(Effect.mapError(toRequestError));
          context.serverAgent = desiredAgent;
        }

        // `session.prompt` enqueues the turn and returns immediately; the
        // assistant output arrives through the event pump.
        yield* runOpenCodeSdk("session.prompt", () =>
          context.client.session.prompt({
            sessionID: context.openCodeSessionId,
            text: text ?? "",
            ...(fileParts.length > 0 ? { files: fileParts } : {}),
          }),
        ).pipe(Effect.mapError(toRequestError));
      }).pipe(
        Effect.tapError((requestError) =>
          Effect.gen(function* () {
            context.activeTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            yield* updateProviderSession(
              context,
              {
                status: "ready",
                model: modelSelection?.model ?? context.session.model,
                lastError: requestError.detail,
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                turnId,
              })),
              type: "turn.aborted",
              payload: {
                reason: requestError.detail,
              },
            });
          }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
      };
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        yield* runOpenCodeSdk("session.interrupt", () =>
          context.client.session.interrupt({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        if (turnId ?? context.activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: turnId ?? context.activeTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          sessionID: context.openCodeSessionId,
          requestID: requestId,
          decision: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const form = context.pendingQuestions.get(requestId);
      if (!form) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "form.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      // 2.x replaces 1.x questions with forms; TUI answers are keyed by
      // `openCodeFormFieldId`, which we map back onto the form field keys.
      yield* runOpenCodeSdk("form.reply", () =>
        context.client.session.form.reply({
          sessionID: context.openCodeSessionId,
          formID: requestId,
          answer: toOpenCodeFormAnswers(form.fields, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.context", () =>
          context.client.session.context({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));

        // One turn per assistant message; the message and its content entries
        // are the opaque turn items, mirroring the 1.x `session.messages` shape.
        const turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }> = [];
        for (const message of messages) {
          if (message.type === "assistant") {
            turns.push({
              id: TurnId.make(message.id),
              items: [message, ...message.content],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.context", () =>
          context.client.session.context({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = messages.filter((message) => message.type === "assistant");
        // 2.x revert semantics (verified against a live server): stage(M) +
        // commit removes M and every later message. So to drop the last
        // `numTurns` assistant turns we stage the message at the START of the
        // first removed turn: the user prompt right before that assistant
        // reply when one exists, the assistant message itself otherwise.
        const firstRemoved = assistantMessages[assistantMessages.length - numTurns];
        if (!firstRemoved) {
          // `revert.stage` requires a messageID, so removing every turn (the
          // 1.x "revert to start" case) has no exact 2.x equivalent.
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.revert.stage",
            detail: `Cannot roll back ${numTurns} turn(s): the thread only has ${assistantMessages.length} assistant turn(s).`,
          });
        }
        const firstRemovedIndex = messages.indexOf(firstRemoved);
        const before = firstRemovedIndex > 0 ? messages[firstRemovedIndex - 1] : undefined;
        const cutMessage =
          before && before.type === "user" && before.time.created <= firstRemoved.time.created
            ? before
            : firstRemoved;

        // 2.x splits revert into stage (pick the revert point, optionally
        // stage file changes) and commit (apply it).
        yield* runOpenCodeSdk("session.revert.stage", () =>
          context.client.session.revert.stage({
            sessionID: context.openCodeSessionId,
            messageID: cutMessage.id,
            files: true,
          }),
        ).pipe(Effect.mapError(toRequestError));
        yield* runOpenCodeSdk("session.revert.commit", () =>
          context.client.session.revert.commit({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing - SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
