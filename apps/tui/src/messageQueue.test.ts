import { describe, expect, it } from "vitest";

import {
  createQueuedMessage,
  describeQueueCount,
  editQueuedMessage,
  enqueueMessage,
  markQueuedHeadDispatching,
  moveQueuedMessage,
  queueMessagesForThread,
  QUEUED_SEND_MAX_ATTEMPTS,
  QUEUED_SEND_RETRY_BACKOFF_MS,
  QUEUED_SEND_STUCK_DISPATCH_MS,
  queuedSendRetryBackoffMs,
  requeueDispatchingHead,
  removeQueuedMessage,
  resolveQueuePumpDecision,
  shouldReleaseDispatchingEntry,
  takeQueuedHead,
} from "./messageQueue";

function makeMessage(messageId: string, threadId = "thread-1", text = `prompt ${messageId}`) {
  return createQueuedMessage({
    threadId,
    messageId,
    text,
    createdAt: `2026-03-25T10:00:0${messageId.length % 10}.000Z`,
  });
}

describe("messageQueue", () => {
  it("appends in FIFO order and reports queue state", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));

    expect(queue.map((entry) => entry.messageId)).toEqual(["m1", "m2"]);
    expect(takeQueuedHead(queue)?.next.messageId).toBe("m1");
    expect(takeQueuedHead(queue)?.remaining.map((entry) => entry.messageId)).toEqual(["m2"]);
  });

  it("returns null head for an empty queue", () => {
    expect(takeQueuedHead([])).toBeNull();
  });

  it("removes by message id", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = removeQueuedMessage(queue, "m1");

    expect(queue.map((entry) => entry.messageId)).toEqual(["m2"]);
  });

  it("edits text of the targeted message only", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = editQueuedMessage(queue, "m2", "revised");

    expect(queue[0]?.text).toBe("prompt m1");
    expect(queue[1]?.text).toBe("revised");
  });

  it("edit is a no-op for unknown ids", () => {
    const queue = enqueueMessage([], makeMessage("m1"));
    const next = editQueuedMessage(queue, "missing", "revised");

    expect(next).toEqual(queue);
    expect(next).not.toBe(queue);
  });

  it("moves messages up and down and clamps at the edges", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = enqueueMessage(queue, makeMessage("m3"));

    expect(moveQueuedMessage(queue, "m3", -1).map((entry) => entry.messageId)).toEqual([
      "m1",
      "m3",
      "m2",
    ]);
    expect(moveQueuedMessage(queue, "m1", -1).map((entry) => entry.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(moveQueuedMessage(queue, "m3", 1).map((entry) => entry.messageId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("filters queued messages per thread", () => {
    let queue = enqueueMessage([], makeMessage("m1", "thread-1"));
    queue = enqueueMessage(queue, makeMessage("m2", "thread-2"));
    queue = enqueueMessage(queue, makeMessage("m3", "thread-1"));

    expect(queueMessagesForThread(queue, "thread-1").map((entry) => entry.messageId)).toEqual([
      "m1",
      "m3",
    ]);
  });

  it("describes queue counts", () => {
    expect(describeQueueCount(0)).toBe("No queued messages");
    expect(describeQueueCount(1)).toBe("1 queued message");
    expect(describeQueueCount(3)).toBe("3 queued messages");
  });

  it("preserves the full attachment payload through queue operations", () => {
    const message = createQueuedMessage({
      threadId: "thread-1",
      messageId: "m1",
      text: "with image",
      attachments: [
        {
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 42,
          dataUrl: "data:image/png;base64,QUJD",
        },
      ],
      createdAt: "2026-03-25T10:00:00.000Z",
    });

    expect(message.attachments[0]).toEqual({
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 42,
      dataUrl: "data:image/png;base64,QUJD",
    });
  });

  it("marks the head dispatching and blocks the pump from firing the next entry", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = markQueuedHeadDispatching(queue, "m1");

    expect(queue[0]?.status).toBe("dispatching");
    expect(queue[1]?.status).toBe("queued");
    expect(takeQueuedHead(queue.filter((entry) => entry.status === "queued"))?.next.messageId).toBe(
      "m2",
    );
  });

  it("requeues a dispatching entry back to queued for retry", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = markQueuedHeadDispatching(queue, "m1");
    queue = requeueDispatchingHead(queue, "m1");

    expect(queue.map((entry) => entry.status)).toEqual(["queued", "queued"]);
    expect(takeQueuedHead(queue)?.next.messageId).toBe("m1");
  });

  it("requeue leaves unrelated entries untouched", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = markQueuedHeadDispatching(queue, "m1");
    const next = requeueDispatchingHead(queue, "missing");

    expect(next.map((entry) => entry.status)).toEqual(["dispatching", "queued"]);
  });

  it("pump blocks while an entry is dispatching, even with more queued behind it", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    queue = markQueuedHeadDispatching(queue, "m1");

    // The running-state push may be delayed, but the pump decision must not
    // start the second turn while the first is still being established.
    expect(resolveQueuePumpDecision("thread-1", queue, false, {}, 1000)).toEqual({
      action: "block-dispatching",
    });
  });

  it("pump holds the dispatching barrier until the turn persists, then releases it", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));

    // Accepted dispatch: entry stays dispatching, pump blocked.
    queue = markQueuedHeadDispatching(queue, "m1");
    expect(resolveQueuePumpDecision("thread-1", queue, false, {}, 1000).action).toBe(
      "block-dispatching",
    );

    // Turn lifecycle continues: user message persisted -> release the head.
    const persisted = queue.map((entry) =>
      entry.messageId === "m1" ? { ...entry, status: "dispatching" as const } : entry,
    );
    expect(shouldReleaseDispatchingEntry(persisted[0]!, true, 1000)).toBe(true);

    // The second queued prompt still cannot start while the head is in the
    // queue (removal of the persisted head is the pump's own cleanup).
    expect(resolveQueuePumpDecision("thread-1", queue, false, {}, 1000).action).toBe(
      "block-dispatching",
    );
  });

  it("never deletes an unsent prompt: retries use backoff, not removal", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    for (let attempt = 1; attempt <= 5; attempt++) {
      queue = markQueuedHeadDispatching(queue, "m1");
      // Failure: the entry returns to queued with backoff; nothing removes it.
      queue = requeueDispatchingHead(queue, "m1");
      const backoff = queuedSendRetryBackoffMs(attempt);
      const decision = resolveQueuePumpDecision(
        "thread-1",
        queue,
        false,
        { m1: 1000 + backoff },
        1000 + backoff - 1,
      );
      expect(decision).toEqual({ action: "block-backoff", retryInMs: 1 });
    }

    expect(queue).toHaveLength(1);
    expect(queue[0]?.messageId).toBe("m1");

    // After the backoff window the prompt dispatches again.
    const decision = resolveQueuePumpDecision("thread-1", queue, false, { m1: 1000 }, 5000);
    expect(decision.action).toBe("dispatch");
  });

  it("backs off exponentially between failed dispatch attempts", () => {
    expect(queuedSendRetryBackoffMs(1)).toBe(QUEUED_SEND_RETRY_BACKOFF_MS);
    expect(queuedSendRetryBackoffMs(2)).toBe(QUEUED_SEND_RETRY_BACKOFF_MS * 2);
    expect(queuedSendRetryBackoffMs(3)).toBe(QUEUED_SEND_RETRY_BACKOFF_MS * 4);
  });

  it("pump ignores a backoff scheduled for a message that is no longer the head", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    // Backoff entry applies to m1; once m1 is dispatched and removed the pump
    // must not let a stale backoff gate m2.
    const queueWithoutHead = removeQueuedMessage(queue, "m1");
    const decision = resolveQueuePumpDecision(
      "thread-1",
      queueWithoutHead,
      false,
      { m1: Date.now() + 60_000 },
      Date.now(),
    );
    expect(decision).toEqual({ action: "dispatch", head: queueWithoutHead[0] });
  });

  it("stuck-dispatch valve releases only after the deadline and keeps the prompt", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = markQueuedHeadDispatching(queue, "m1");
    const entry = queue[0]!;
    const queuedAt = Date.parse(entry.createdAt);

    // Within the deadline: keep holding the barrier.
    expect(shouldReleaseDispatchingEntry(entry, false, queuedAt + 1000)).toBe(false);
    // Past the deadline: release to queued (not delete).
    expect(
      shouldReleaseDispatchingEntry(entry, false, queuedAt + QUEUED_SEND_STUCK_DISPATCH_MS + 1),
    ).toBe(true);

    // A persisted message releases immediately regardless of deadline.
    expect(shouldReleaseDispatchingEntry(entry, true, queuedAt + 1000)).toBe(true);
  });

  it("reports the retry cap constant used for status messaging", () => {
    expect(QUEUED_SEND_MAX_ATTEMPTS).toBe(3);
  });
});
