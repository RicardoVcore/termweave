/**
 * Client-side message queue for a thread whose provider turn is still running.
 *
 * A queued message holds everything needed to dispatch `thread.turn.start` once
 * the active turn settles. Queue entries are FIFO; the head is the next prompt
 * to send. Editing and removal operate on stable message ids so the TUI can
 * render order and status.
 */

export type QueuedMessageStatus = "queued" | "dispatching";

/** Narrow structural types so the queue module stays decoupled from ui.tsx. */
export type QueuedMessageMention = {
  type: "path";
  path: string;
};

/** Attachment payload as queued; `dataUrl` must be preserved so the queued
 *  send carries the same image data the composer attached. */
export type QueuedMessageAttachment = {
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
};

export interface QueuedMessage {
  readonly threadId: string;
  readonly messageId: string;
  text: string;
  readonly mentions: ReadonlyArray<QueuedMessageMention>;
  readonly attachments: ReadonlyArray<QueuedMessageAttachment>;
  readonly createdAt: string;
  status: QueuedMessageStatus;
  /** Wall-clock millis when this entry's dispatch command was sent; set by
   *  the pump when it marks the entry dispatching. The stuck-dispatch valve
   *  is measured from this, not from queue time. */
  dispatchedAt: number | null;
  /** True once the provider turn for this dispatch was observed running.
   *  Distinguishes "turn not started yet" from "turn settled": the dispatch
   *  barrier may only release after the turn ran and then stopped, so a user
   *  message that persists before the provider starts cannot let the next
   *  queued prompt dispatch early. */
  turnRunningSeen: boolean;
  /** Dispatch settings captured when the message was queued. */
  readonly dispatch: QueuedMessageDispatch;
}

export interface QueuedMessageDispatch {
  readonly provider?: string;
  readonly model?: string;
  readonly interactionMode?: string;
  readonly runtimeMode?: string;
  readonly assistantDeliveryMode?: "streaming" | "buffered";
}

export interface MessageQueueSnapshot {
  readonly threadId: string;
  readonly headMessageId: string | null;
  readonly count: number;
  readonly entries: ReadonlyArray<QueuedMessage>;
}

export function createQueuedMessage(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly mentions?: ReadonlyArray<QueuedMessageMention>;
  readonly attachments?: ReadonlyArray<QueuedMessageAttachment>;
  readonly createdAt: string;
  readonly dispatch?: QueuedMessageDispatch;
}): QueuedMessage {
  return {
    threadId: input.threadId,
    messageId: input.messageId,
    text: input.text,
    mentions: [...(input.mentions ?? [])],
    attachments: [...(input.attachments ?? [])],
    createdAt: input.createdAt,
    status: "queued",
    dispatchedAt: null,
    turnRunningSeen: false,
    dispatch: { ...input.dispatch },
  };
}

export function enqueueMessage(
  queue: ReadonlyArray<QueuedMessage>,
  message: QueuedMessage,
): QueuedMessage[] {
  return [...queue, message];
}

export function removeQueuedMessage(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
): QueuedMessage[] {
  return queue.filter((entry) => entry.messageId !== messageId);
}

/** Replace the text of a queued message; no-op when the id is not queued. */
export function editQueuedMessage(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
  text: string,
): QueuedMessage[] {
  return queue.map((entry) => (entry.messageId === messageId ? { ...entry, text } : entry));
}

/** Move a queued message by -1 (earlier) or +1 (later) within its queue. */
export function moveQueuedMessage(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
  direction: -1 | 1,
): QueuedMessage[] {
  const index = queue.findIndex((entry) => entry.messageId === messageId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= queue.length) {
    return [...queue];
  }
  const next = [...queue];
  const [entry] = next.splice(index, 1);
  if (!entry) {
    return next;
  }
  next.splice(target, 0, entry);
  return next;
}

/** Pop the head for dispatch; null when the queue is empty. */
export function takeQueuedHead(
  queue: ReadonlyArray<QueuedMessage>,
): { next: QueuedMessage; remaining: QueuedMessage[] } | null {
  const [head] = queue;
  if (!head) {
    return null;
  }
  return { next: head, remaining: queue.slice(1) };
}

/** Mark the head as dispatching and stamp when the dispatch started. The
 *  entry stays in the queue until its turn settles, which blocks the pump
 *  from firing the next prompt too early. */
export function markQueuedHeadDispatching(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
  now: number = Date.now(),
): QueuedMessage[] {
  return queue.map((entry) =>
    entry.messageId === messageId
      ? {
          ...entry,
          status: "dispatching" as const,
          dispatchedAt: now,
          turnRunningSeen: false,
        }
      : entry,
  );
}

/** Return a dispatching entry to queued state so it can be pumped again. */
export function requeueDispatchingHead(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
): QueuedMessage[] {
  return queue.map((entry) =>
    entry.messageId === messageId
      ? { ...entry, status: "queued" as const, dispatchedAt: null, turnRunningSeen: false }
      : entry,
  );
}

export function queueMessagesForThread(
  queue: ReadonlyArray<QueuedMessage>,
  threadId: string,
): QueuedMessage[] {
  return queue.filter((entry) => entry.threadId === threadId);
}

export function describeQueueCount(count: number): string {
  if (count <= 0) {
    return "No queued messages";
  }
  return count === 1 ? "1 queued message" : `${count} queued messages`;
}

/** Tunables for the queue pump, mirroring the constants in ui.tsx. */
export const QUEUED_SEND_MAX_ATTEMPTS = 3;
export const QUEUED_SEND_RETRY_BACKOFF_MS = 2_000;
/** Safety valve: how long a dispatch may stay "dispatching" after the
 *  dispatch started before it is considered lost and requeued. Measured from
 *  dispatch start, not from when the message was queued - a long-running turn
 *  must not expire its own barrier. */
export const QUEUED_SEND_STUCK_DISPATCH_MS = 120_000;

export type QueuePumpDecision =
  | { readonly action: "block-dispatching" }
  | { readonly action: "block-backoff"; readonly retryInMs: number }
  | { readonly action: "dispatch"; readonly head: QueuedMessage }
  | { readonly action: "idle" };

/** Decide what the queue pump should do next. Pure so the gating rules -
 *  never start a second turn while one is dispatching, back off between
 *  failed retries - are testable without rendering the TUI.
 *
 * @param threadId active thread id (pump is per-thread)
 * @param queue current queue state
 * @param threadIsRunning whether the provider turn is active for the thread
 * @param nextRetryAtByMessageId scheduled retry timestamps from past failures
 * @param now current wall-clock millis
 */
export function resolveQueuePumpDecision(
  threadId: string,
  queue: ReadonlyArray<QueuedMessage>,
  threadIsRunning: boolean,
  nextRetryAtByMessageId: Readonly<Record<string, number>>,
  now: number,
): QueuePumpDecision {
  if (threadIsRunning) {
    return { action: "idle" };
  }
  const threadQueue = queueMessagesForThread(queue, threadId);
  if (threadQueue.some((entry) => entry.status === "dispatching")) {
    // The barrier holds until the dispatching turn fully settles - the
    // caller passes a queue whose dispatching entries were already released
    // by the turn-lifecycle tracker below. Seeing one here means the turn is
    // still in flight.
    return { action: "block-dispatching" };
  }
  const head = threadQueue.find((entry) => entry.status === "queued");
  if (!head) {
    return { action: "idle" };
  }
  const nextRetryAt = nextRetryAtByMessageId[head.messageId];
  if (nextRetryAt !== undefined && now < nextRetryAt) {
    return { action: "block-backoff", retryInMs: nextRetryAt - now };
  }
  return { action: "dispatch", head };
}

/** Exponential backoff for a failed queued-send attempt. Attempts start at 1. */
export function queuedSendRetryBackoffMs(attempts: number): number {
  return QUEUED_SEND_RETRY_BACKOFF_MS * 2 ** (Math.max(attempts, 1) - 1);
}

/**
 * Lifecycle state for a dispatching entry, derived from what the TUI observes.
 * `dispatchedAt` is when the dispatch command was sent (wall clock) - the
 * stuck valve is measured from this, never from queue time.
 * `turnRunningSeen` is the entry's observed-turn-running flag, already folded
 * with the current `turnRunning` observation by the caller (once true it
 * stays true for the attempt). `assistantReplyPersisted` is fallback evidence
 * that the turn ran when a status push was missed between ticks.
 */
export type DispatchingLifecycleInput = {
  readonly dispatchedAt: number;
  readonly userMessagePersisted: boolean;
  readonly turnRunning: boolean;
  readonly turnRunningSeen: boolean;
  readonly assistantReplyPersisted: boolean;
  readonly now: number;
};

/**
 * Transition a dispatching entry based on observed lifecycle state:
 * - complete (turn settled): the user message persisted, the turn ran
 *   (observed running, or its assistant reply landed) and then stopped -
 *   remove the entry.
 * - lost (valve expired since dispatch start with no evidence the turn ever
 *   ran): requeue for another attempt, never delete.
 * - in flight (otherwise): keep holding the barrier. The valve is suppressed
 *   while the provider turn is running - a long turn is in flight, not lost.
 */
export type DispatchingTransition =
  | { readonly kind: "complete"; readonly removeEntry: true }
  | { readonly kind: "lost"; readonly removeEntry: false }
  | { readonly kind: "in-flight"; readonly removeEntry: false };

export function resolveDispatchingTransition(
  entry: QueuedMessage,
  input: DispatchingLifecycleInput,
): DispatchingTransition {
  const turnHasRun = input.turnRunningSeen || input.assistantReplyPersisted;
  if (input.userMessagePersisted && !input.turnRunning && turnHasRun) {
    return { kind: "complete", removeEntry: true };
  }
  if (input.turnRunning) {
    return { kind: "in-flight", removeEntry: false };
  }
  if (input.dispatchedAt + QUEUED_SEND_STUCK_DISPATCH_MS <= input.now && !turnHasRun) {
    return { kind: "lost", removeEntry: false };
  }
  return { kind: "in-flight", removeEntry: false };
}
