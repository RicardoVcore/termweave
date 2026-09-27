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
  resolveDispatchingTransition,
  resolveQueuePumpDecision,
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

  it("pump holds the dispatching barrier until the turn fully settles, not merely on persistence", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    queue = enqueueMessage(queue, makeMessage("m2"));
    const dispatchedAt = 1_000;
    queue = markQueuedHeadDispatching(queue, "m1", dispatchedAt);

    // Review case: the user message persisted but the provider turn has not
    // started yet (startup delayed). The barrier MUST hold so the second
    // prompt does not dispatch early.
    const pendingTurn = resolveDispatchingTransition(queue[0]!, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: true,
      turnRunningSeen: false,
      assistantReplyPersisted: false,
      now: dispatchedAt + 10_000,
    });
    expect(pendingTurn).toEqual({ kind: "in-flight", removeEntry: false });

    // The turn settled: message persisted, the turn ran (seen) and the
    // provider is no longer running.
    const settled = resolveDispatchingTransition(queue[0]!, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: false,
      turnRunningSeen: true,
      assistantReplyPersisted: false,
      now: dispatchedAt + 10_000,
    });
    expect(settled).toEqual({ kind: "complete", removeEntry: true });

    // With the entry still in the queue the pump stays blocked.
    expect(resolveQueuePumpDecision("thread-1", queue, false, {}, 10_000)).toEqual({
      action: "block-dispatching",
    });
  });

  it("never deletes an unsent prompt: retries use backoff, not removal", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    for (let attempt = 1; attempt <= 5; attempt++) {
      queue = markQueuedHeadDispatching(queue, "m1", 1_000);
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

  it("stuck-dispatch valve is measured from dispatch start and requeues instead of deleting", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    const queuedAt = 500;
    const dispatchedAt = 60_000; // dispatched long after being queued
    queue = markQueuedHeadDispatching(queue, "m1", dispatchedAt);
    const entry = queue[0]!;

    // A long-running turn that started more than the valve window after
    // queueing must NOT expire the barrier - the valve is keyed off dispatch
    // start, not queue time.
    const duringLongTurn = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: true,
      turnRunningSeen: true,
      assistantReplyPersisted: false,
      now: dispatchedAt + QUEUED_SEND_STUCK_DISPATCH_MS - 1,
    });
    expect(duringLongTurn).toEqual({ kind: "in-flight", removeEntry: false });

    // Valve expiry requeues (removeEntry: false), it never deletes.
    const lost = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: false,
      turnRunning: false,
      turnRunningSeen: false,
      assistantReplyPersisted: false,
      now: dispatchedAt + QUEUED_SEND_STUCK_DISPATCH_MS,
    });
    expect(lost).toEqual({ kind: "lost", removeEntry: false });

    // Before the valve, with nothing persisted, the barrier holds.
    const inFlight = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: false,
      turnRunning: false,
      turnRunningSeen: false,
      assistantReplyPersisted: false,
      now: dispatchedAt + 1_000,
    });
    expect(inFlight).toEqual({ kind: "in-flight", removeEntry: false });

    // Queue-time age is irrelevant: a prompt queued during a 2-minute turn is
    // still recoverable after the turn ends (no deletion, just requeue).
    const afterLongQueueAge = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: false,
      turnRunning: false,
      turnRunningSeen: false,
      assistantReplyPersisted: false,
      now: queuedAt + 200_000,
    });
    expect(afterLongQueueAge.kind).toBe("lost");
    expect(afterLongQueueAge.removeEntry).toBe(false);
  });

  it("distinguishes not-started from settled and never loses a running turn", () => {
    let queue = enqueueMessage([], makeMessage("m1"));
    const dispatchedAt = 1_000;
    queue = markQueuedHeadDispatching(queue, "m1", dispatchedAt);
    const entry = queue[0]!;

    // Review hole 1: direct call returned `complete` for persisted=true,
    // running=false while the provider has not started yet. With the
    // observed-running latch false, the barrier MUST keep holding.
    const notStarted = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: false,
      turnRunningSeen: false,
      assistantReplyPersisted: false,
      now: dispatchedAt + 30_000,
    });
    expect(notStarted).toEqual({ kind: "in-flight", removeEntry: false });

    // Review hole 2: direct call returned `lost` after 120s while the
    // provider is still running, which would requeue a live turn. The valve
    // is suppressed while running.
    const runningPastValve = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: true,
      turnRunningSeen: true,
      assistantReplyPersisted: false,
      now: dispatchedAt + QUEUED_SEND_STUCK_DISPATCH_MS + 1,
    });
    expect(runningPastValve).toEqual({ kind: "in-flight", removeEntry: false });

    // Once the turn was observed running and then stopped, the barrier
    // releases even if the running observation landed after the valve.
    const settledAfterValve = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: false,
      turnRunningSeen: true,
      assistantReplyPersisted: false,
      now: dispatchedAt + QUEUED_SEND_STUCK_DISPATCH_MS + 1,
    });
    expect(settledAfterValve).toEqual({ kind: "complete", removeEntry: true });

    // A missed running push is recovered by the assistant reply evidence:
    // turn ran (reply landed) and stopped -> settled.
    const settledViaReply = resolveDispatchingTransition(entry, {
      dispatchedAt,
      userMessagePersisted: true,
      turnRunning: false,
      turnRunningSeen: false,
      assistantReplyPersisted: true,
      now: dispatchedAt + 2_000,
    });
    expect(settledViaReply).toEqual({ kind: "complete", removeEntry: true });
  });

  it("reports the retry cap constant used for status messaging", () => {
    expect(QUEUED_SEND_MAX_ATTEMPTS).toBe(3);
  });
});
