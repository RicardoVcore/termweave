/**
 * `PiTurnMapper` turns Pi RPC session events into Termweave runtime event
 * drafts. It is a pure, synchronous state machine: no Effect, no I/O, one
 * instance per Termweave turn (the adapter mints a `TurnId` per accepted
 * `prompt` and feeds every non-response stdout record of that turn in order).
 *
 * The adapter (phase A2) stamps `eventId`/`createdAt`/`provider`/`threadId`
 * onto the drafts and handles `extension_ui_request` records itself, which the
 * mapper ignores. Mapping rules: docs/pi-rpc.md sections 4 and 5.
 */
import {
  ProviderItemId,
  RuntimeItemId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@termweave/contracts";

import type {
  PiAgentSettledEvent,
  PiAutoRetryEndEvent,
  PiAutoRetryStartEvent,
  PiCompactionEndEvent,
  PiCompactionStartEvent,
  PiExtensionErrorEvent,
  PiMessageEvent,
  PiRecord,
  PiToolExecutionEndEvent,
  PiToolExecutionStartEvent,
  PiToolExecutionUpdateEvent,
  PiToolResult,
} from "./piRpcProtocol.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** ProviderRuntimeEvent without the fields the adapter stamps in. */
export type PiRuntimeEventDraft = DistributiveOmit<
  ProviderRuntimeEvent,
  "eventId" | "createdAt" | "provider" | "threadId"
>;

type ToolItemType = "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call";

interface ToolItemState {
  readonly itemType: ToolItemType;
  readonly title: string;
  readonly detail?: string;
}

interface AssistantBlock {
  readonly kind: "text" | "thinking";
  accumulated: string;
}

/**
 * Length of the longest prefix of `next` that is a suffix of `prev` (KMP
 * prefix function, O(n)).
 */
export function longestPrefixSuffixOverlap(prev: string, next: string): number {
  const s = `${next}\u0000${prev}`;
  const prefix = Array.from({ length: s.length }, () => 0);
  let k = 0;
  for (let i = 1; i < s.length; i += 1) {
    while (k > 0 && s[i] !== s[k]) {
      k = prefix[k - 1] ?? 0;
    }
    if (s[i] === s[k]) {
      k += 1;
    }
    prefix[i] = k;
  }
  return Math.min(prefix[s.length - 1] ?? 0, prev.length, next.length);
}

const canonicalItemTypeForTool = (toolName: string): ToolItemType => {
  if (toolName === "bash" || toolName === "powershell") {
    return "command_execution";
  }
  if (toolName === "edit" || toolName === "write") {
    return "file_change";
  }
  if (toolName.startsWith("mcp__")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
};

/** `raw` stamp shared by every mapped draft (except content.delta). */
const piEventRaw = (record: PiRecord) => ({
  source: "pi.rpc" as const,
  messageType: record.type,
  payload: record,
});

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const readField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Joins the text entries of a tool `result`/`partialResult` content list. */
const textOfToolResult = (result: PiToolResult | undefined): string =>
  (result?.content ?? [])
    .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
    .join("");

const toolTitle = (itemType: ToolItemType, toolName: string): string => {
  if (itemType === "command_execution") {
    return "Run command";
  }
  if (toolName === "edit") {
    return "Edit file";
  }
  if (toolName === "write") {
    return "Write file";
  }
  return toolName;
};

const toolDetail = (itemType: ToolItemType, args: unknown): string | undefined => {
  if (itemType === "command_execution") {
    return trimNonEmpty(
      typeof readField(args, "command") === "string"
        ? (readField(args, "command") as string)
        : undefined,
    );
  }
  if (itemType === "file_change") {
    return trimNonEmpty(
      typeof readField(args, "path") === "string" ? (readField(args, "path") as string) : undefined,
    );
  }
  return undefined;
};

export function createPiTurnMapper(input: { turnId: TurnId }): {
  /** Map one Pi stdout record (session event) to zero or more runtime event drafts. */
  map(record: PiRecord): ReadonlyArray<PiRuntimeEventDraft>;
  /** Approval toolCallIds the adapter got decline/cancel for (so tool end becomes "declined"). */
  markDeclined(toolCallId: string): void;
  /** Called when the adapter interrupted this turn (doc section 4: aborted flag alone is not enough). */
  markInterruptRequested(): void;
  /** True after agent_settled was mapped. */
  readonly settled: boolean;
} {
  const { turnId } = input;

  let assistantMessageCount = 0;
  let compactionCount = 0;
  let settled = false;
  let interruptRequested = false;
  let lastAssistantStopReason: string | undefined;
  let lastAssistantErrorMessage: string | undefined;
  // Set when a terminal `runtime.error` was already emitted this turn
  // (`auto_retry_end` with `success: false`), so `agent_settled` does not
  // emit a duplicate for the same failure.
  let emittedTerminalRuntimeError = false;
  const blocks = new Map<number, AssistantBlock>();
  // Content indexes of the current assistant message that already produced an
  // `item.completed` (reset on `message_start`); used to reconcile blocks that
  // never streamed when `message_end` arrives.
  const completedBlockIndexes = new Set<number>();
  const tools = new Map<string, ToolItemState>();
  const toolOutputSnapshots = new Map<string, string>();
  const declinedToolCallIds = new Set<string>();

  const raw = piEventRaw;

  const itemEvent = (
    type: "item.started" | "item.completed",
    itemId: string,
    payload: {
      itemType: ToolItemType | "assistant_message" | "reasoning" | "context_compaction";
      status?: "inProgress" | "completed" | "failed" | "declined";
      title?: string;
      detail?: string;
      data?: unknown;
    },
    record: PiRecord,
    withProviderRef: boolean,
  ): PiRuntimeEventDraft => ({
    type,
    turnId,
    itemId: RuntimeItemId.make(itemId),
    ...(withProviderRef ? { providerRefs: { providerItemId: ProviderItemId.make(itemId) } } : {}),
    payload,
    raw: raw(record),
  });

  // Every delta carries the item id it streams into so ingestion groups the
  // stream with the completed item under one runtime item id.
  const contentDelta = (
    streamKind: "assistant_text" | "reasoning_text" | "command_output",
    delta: string,
    itemId: string,
    contentIndex?: number,
  ): PiRuntimeEventDraft => ({
    type: "content.delta",
    turnId,
    itemId: RuntimeItemId.make(itemId),
    payload: {
      streamKind,
      delta,
      ...(contentIndex !== undefined ? { contentIndex } : {}),
    },
  });

  const runtimeError = (message: string, record: PiRecord): PiRuntimeEventDraft => ({
    type: "runtime.error",
    turnId,
    payload: { message, class: "provider_error" },
    raw: raw(record),
  });

  const runtimeWarning = (
    message: string,
    detail: unknown,
    record: PiRecord,
  ): PiRuntimeEventDraft => ({
    type: "runtime.warning",
    turnId,
    payload: { message, ...(detail !== undefined ? { detail } : {}) },
    raw: raw(record),
  });

  // Assistant message n is counted per `message_start` with role assistant;
  // blocks are tracked by contentIndex because `*_end` can arrive after the
  // next block has already started.
  const mapMessage = (record: PiMessageEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    if (record.type === "message_update") {
      // `message_update` carries no `message`, only block streaming events.
      return mapAssistantBlockEvent(record);
    }
    const role = record.message?.role;
    if (role === "assistant") {
      if (record.type === "message_start") {
        assistantMessageCount += 1;
        completedBlockIndexes.clear();
        return [];
      }
      lastAssistantStopReason =
        typeof record.message?.stopReason === "string" ? record.message.stopReason : undefined;
      lastAssistantErrorMessage =
        typeof record.message?.errorMessage === "string" ? record.message.errorMessage : undefined;
      // A recoverable failure (`auto_retry_start` follows) must not surface as
      // `runtime.error` yet; the terminal emission happens at `agent_settled`.
      return mapNeverStreamedBlocks(record);
    }
    // system/user/toolResult messages are ignored (Termweave owns the user
    // message; toolResults duplicate tool_execution_end).
    return [];
  };

  const assistantItemId = (blockKind: "text" | "thinking", contentIndex: number): string => {
    const suffix = blockKind === "text" ? "t" : "r";
    return `${turnId}:a${assistantMessageCount - 1}:${suffix}${contentIndex}`;
  };

  /**
   * `message_end.message` is authoritative, but `*_end` block events are only
   * sent for blocks that actually streamed. Emit `item.started` +
   * `item.completed` for every final content block that never produced an
   * `item.completed` in this message.
   */
  const mapNeverStreamedBlocks = (record: PiMessageEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    const content = record.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const drafts: Array<PiRuntimeEventDraft> = [];
    content.forEach((entry, contentIndex) => {
      if (completedBlockIndexes.has(contentIndex)) {
        return;
      }
      const block = entry as { type?: unknown; text?: unknown; thinking?: unknown };
      const blockKind: "text" | "thinking" | undefined =
        block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : undefined;
      if (blockKind === undefined) {
        return;
      }
      const detail = trimNonEmpty(
        blockKind === "text"
          ? typeof block.text === "string"
            ? block.text
            : undefined
          : typeof block.thinking === "string"
            ? block.thinking
            : undefined,
      );
      if (detail === undefined) {
        return;
      }
      const itemType = blockKind === "text" ? "assistant_message" : "reasoning";
      drafts.push(
        itemEvent(
          "item.started",
          assistantItemId(blockKind, contentIndex),
          { itemType, status: "inProgress" },
          record,
          false,
        ),
        itemEvent(
          "item.completed",
          assistantItemId(blockKind, contentIndex),
          { itemType, status: "completed", detail },
          record,
          false,
        ),
      );
    });
    return drafts;
  };

  const mapAssistantBlockEvent = (record: PiMessageEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    const event = record.assistantMessageEvent;
    if (event === undefined) {
      return [];
    }
    const contentIndex = event.contentIndex ?? 0;
    const blockKind: "text" | "thinking" = event.type.startsWith("thinking_") ? "thinking" : "text";
    switch (event.type) {
      case "text_start":
      case "thinking_start": {
        blocks.set(contentIndex, { kind: blockKind, accumulated: "" });
        const itemType = blockKind === "text" ? "assistant_message" : "reasoning";
        return [
          itemEvent(
            "item.started",
            assistantItemId(blockKind, contentIndex),
            { itemType, status: "inProgress" },
            record,
            false,
          ),
        ];
      }
      case "text_delta":
      case "thinking_delta": {
        const block = blocks.get(contentIndex);
        if (block) {
          block.accumulated += typeof event.delta === "string" ? event.delta : "";
        }
        return [
          contentDelta(
            blockKind === "text" ? "assistant_text" : "reasoning_text",
            typeof event.delta === "string" ? event.delta : "",
            assistantItemId(blockKind, contentIndex),
            contentIndex,
          ),
        ];
      }
      case "text_end":
      case "thinking_end": {
        const block = blocks.get(contentIndex);
        blocks.delete(contentIndex);
        completedBlockIndexes.add(contentIndex);
        const itemType = blockKind === "text" ? "assistant_message" : "reasoning";
        const detail = trimNonEmpty(
          typeof event.content === "string" ? event.content : block?.accumulated,
        );
        return [
          itemEvent(
            "item.completed",
            assistantItemId(blockKind, contentIndex),
            { itemType, status: "completed", ...(detail ? { detail } : {}) },
            record,
            false,
          ),
        ];
      }
      default:
        // toolcall_start/delta/end map to nothing; the tool item starts at
        // tool_execution_start.
        return [];
    }
  };

  const mapToolStart = (record: PiToolExecutionStartEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    const itemType = canonicalItemTypeForTool(record.toolName);
    const title = toolTitle(itemType, record.toolName);
    const detail = toolDetail(itemType, record.args);
    tools.set(record.toolCallId, { itemType, title, ...(detail ? { detail } : {}) });
    return [
      itemEvent(
        "item.started",
        record.toolCallId,
        {
          itemType,
          status: "inProgress",
          title,
          ...(detail ? { detail } : {}),
          data: { toolName: record.toolName, args: record.args },
        },
        record,
        true,
      ),
    ];
  };

  // bash `partialResult` content is cumulative; emit only the part after the
  // previous snapshot. When Pi truncates the head or replaces the snapshot
  // (sliding tail window), anchor on the longest prefix of the new snapshot
  // that is also a suffix of the previous one (KMP, O(n)); a resync that
  // shares no overlap resends the snapshot in full.
  const mapToolUpdate = (
    record: PiToolExecutionUpdateEvent,
  ): ReadonlyArray<PiRuntimeEventDraft> => {
    const state = tools.get(record.toolCallId);
    if (state === undefined || state.itemType !== "command_execution") {
      return [];
    }
    const next = textOfToolResult(record.partialResult);
    const prev = toolOutputSnapshots.get(record.toolCallId) ?? "";
    toolOutputSnapshots.set(record.toolCallId, next);
    const delta = next.startsWith(prev)
      ? next.slice(prev.length)
      : next.slice(longestPrefixSuffixOverlap(prev, next));
    if (delta.length === 0) {
      return [];
    }
    return [contentDelta("command_output", delta, record.toolCallId)];
  };

  const mapToolEnd = (record: PiToolExecutionEndEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    const state = tools.get(record.toolCallId);
    tools.delete(record.toolCallId);
    toolOutputSnapshots.delete(record.toolCallId);
    const itemType = state?.itemType ?? canonicalItemTypeForTool(record.toolName);
    const status = declinedToolCallIds.has(record.toolCallId)
      ? "declined"
      : record.isError === true
        ? "failed"
        : "completed";
    const data: Record<string, unknown> = {
      toolName: record.toolName,
      result: record.result,
      isError: record.isError === true,
    };
    const exitCode = readField(record.result?.structuredContent, "exit_code");
    if (itemType === "command_execution" && typeof exitCode === "number") {
      data.exitCode = exitCode;
    }
    const patch = readField(record.result?.details, "patch");
    if (record.toolName === "edit" && typeof patch === "string") {
      data.patch = patch;
    }
    return [
      itemEvent(
        "item.completed",
        record.toolCallId,
        {
          itemType,
          status,
          ...(state?.title ? { title: state.title } : {}),
          ...(state?.detail ? { detail: state.detail } : {}),
          data,
        },
        record,
        true,
      ),
    ];
  };

  const mapAgentSettled = (record: PiAgentSettledEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    settled = true;
    const errorMessage =
      lastAssistantStopReason === "error"
        ? (trimNonEmpty(lastAssistantErrorMessage) ?? "Pi provider error")
        : undefined;
    const state =
      interruptRequested || record.aborted === true
        ? "interrupted"
        : lastAssistantStopReason === "error"
          ? "failed"
          : lastAssistantStopReason === "aborted"
            ? "interrupted"
            : "completed";
    const drafts: Array<PiRuntimeEventDraft> = [];
    if (state === "failed" && !emittedTerminalRuntimeError) {
      emittedTerminalRuntimeError = true;
      drafts.push(runtimeError(errorMessage ?? "Pi provider error", record));
    }
    drafts.push({
      type: "turn.completed",
      turnId,
      payload: {
        state,
        stopReason: lastAssistantStopReason ?? null,
        ...(errorMessage ? { errorMessage } : {}),
      },
      raw: raw(record),
    } satisfies PiRuntimeEventDraft);
    return drafts;
  };

  const mapAutoRetryStart = (record: PiAutoRetryStartEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    const errorMessage = trimNonEmpty(record.errorMessage);
    return [
      runtimeWarning(
        `Retrying (attempt ${record.attempt ?? 0}/${record.maxAttempts ?? 0})${
          errorMessage ? `: ${errorMessage}` : ""
        }`,
        undefined,
        record,
      ),
    ];
  };

  const mapAutoRetryEnd = (record: PiAutoRetryEndEvent): ReadonlyArray<PiRuntimeEventDraft> => {
    if (record.success !== false) {
      return [];
    }
    // Retries exhausted: the terminal error is emitted here, so
    // `agent_settled` must not repeat it for the same failure.
    emittedTerminalRuntimeError = true;
    return [runtimeError(trimNonEmpty(record.finalError) ?? "Retries exhausted", record)];
  };

  const mapCompactionStart = (
    record: PiCompactionStartEvent,
  ): ReadonlyArray<PiRuntimeEventDraft> => [
    itemEvent(
      "item.started",
      `${turnId}:compaction${compactionCount++}`,
      { itemType: "context_compaction", status: "inProgress" },
      record,
      false,
    ),
  ];

  const mapCompactionEnd = (record: PiCompactionEndEvent): ReadonlyArray<PiRuntimeEventDraft> => [
    itemEvent(
      "item.completed",
      `${turnId}:compaction${compactionCount - 1}`,
      {
        itemType: "context_compaction",
        status: record.errorMessage !== undefined ? "failed" : "completed",
      },
      record,
      false,
    ),
  ];

  const mapExtensionError = (record: PiExtensionErrorEvent): ReadonlyArray<PiRuntimeEventDraft> => [
    runtimeWarning(
      `Pi extension error: ${trimNonEmpty(record.error) ?? "unknown"}`,
      record,
      record,
    ),
  ];

  const map = (record: PiRecord): ReadonlyArray<PiRuntimeEventDraft> => {
    // `PiUnknownEvent` carries a string `type`, so switch narrowing keeps it in
    // every case; the casts assert the concrete record shape per case.
    switch (record.type) {
      case "message_start":
      case "message_update":
      case "message_end":
        return mapMessage(record as PiMessageEvent);
      case "tool_execution_start":
        return mapToolStart(record as PiToolExecutionStartEvent);
      case "tool_execution_update":
        return mapToolUpdate(record as PiToolExecutionUpdateEvent);
      case "tool_execution_end":
        return mapToolEnd(record as PiToolExecutionEndEvent);
      case "agent_settled":
        return mapAgentSettled(record as PiAgentSettledEvent);
      case "auto_retry_start":
        return mapAutoRetryStart(record as PiAutoRetryStartEvent);
      case "auto_retry_end":
        return mapAutoRetryEnd(record as PiAutoRetryEndEvent);
      case "compaction_start":
        return mapCompactionStart(record as PiCompactionStartEvent);
      case "compaction_end":
        return mapCompactionEnd(record as PiCompactionEndEvent);
      case "extension_error":
        return mapExtensionError(record as PiExtensionErrorEvent);
      default:
        // turn_start/turn_end, agent_start/end, queue_update,
        // thinking_level_changed, entry_appended, summarization_retry_*,
        // bash_execution_update, responses and extension_ui_request records.
        return [];
    }
  };

  return {
    map,
    markDeclined: (toolCallId) => declinedToolCallIds.add(toolCallId),
    markInterruptRequested: () => {
      interruptRequested = true;
    },
    get settled() {
      return settled;
    },
  };
}
