/**
 * Client-side message queue for a thread whose provider turn is still running.
 *
 * A queued message holds everything needed to dispatch `thread.turn.start` once
 * the active turn settles. Queue entries are FIFO; the head is the next prompt
 * to send. Editing and removal operate on stable message ids so the TUI can
 * render order and status.
 */

export type QueuedMessageStatus = "queued";

/** Narrow structural types so the queue module stays decoupled from ui.tsx. */
export type QueuedMessageMention = {
  type: "path";
  path: string;
};

export type QueuedMessageAttachment = {
  readonly name: string;
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
