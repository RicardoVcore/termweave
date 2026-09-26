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

/** Mark the head as dispatching. The entry stays queued until its turn
 *  settles, which blocks the pump from firing the next prompt too early. */
export function markQueuedHeadDispatching(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
): QueuedMessage[] {
  return queue.map((entry) =>
    entry.messageId === messageId ? { ...entry, status: "dispatching" as const } : entry,
  );
}

/** Return a dispatching entry to queued state so it can be pumped again. */
export function requeueDispatchingHead(
  queue: ReadonlyArray<QueuedMessage>,
  messageId: string,
): QueuedMessage[] {
  return queue.map((entry) =>
    entry.messageId === messageId ? { ...entry, status: "queued" as const } : entry,
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
    // The barrier holds through the turn lifecycle: a dispatching entry is
    // only cleared once the turn's user message persists in the read model
    // (or the stuck-dispatch safety valve fires).
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

/** Whether a dispatching entry should be released back to the queue: it is
 *  done once its user message persisted, or rescued by the stuck-dispatch
 *  valve when a push was lost. Never deletes an unsent prompt. */
export function shouldReleaseDispatchingEntry(
  entry: QueuedMessage,
  userMessagePersisted: boolean,
  now: number,
): boolean {
  if (!userMessagePersisted) {
    return Date.parse(entry.createdAt) + QUEUED_SEND_STUCK_DISPATCH_MS <= now;
  }
  return true;
}
