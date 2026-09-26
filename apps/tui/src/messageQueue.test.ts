import { describe, expect, it } from "vitest";

import {
  createQueuedMessage,
  describeQueueCount,
  editQueuedMessage,
  enqueueMessage,
  markQueuedHeadDispatching,
  moveQueuedMessage,
  queueMessagesForThread,
  requeueDispatchingHead,
  removeQueuedMessage,
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
});
