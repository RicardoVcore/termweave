/**
 * Plain TypeScript types for the Pi RPC JSONL protocol (`pi --mode rpc`).
 * Only the fields Termweave reads are typed; the full protocol is documented in
 * `docs/pi-rpc.md`. Kept free of Effect Schema: these records are parsed as
 * plain JSON and mapped by `PiTurnMapper` / the adapter.
 */

/** A text (or image) entry inside a tool `result`/`partialResult` content list. */
export interface PiContentItem {
  readonly type?: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/** `result` / `partialResult` payload of tool execution events. */
export interface PiToolResult {
  readonly content?: ReadonlyArray<PiContentItem>;
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly terminate?: unknown;
  readonly [key: string]: unknown;
}

/** Assistant message content block metadata carried by `assistantMessageEvent`. */
export interface PiAssistantMessageEvent {
  readonly type: string;
  readonly contentIndex?: number;
  readonly delta?: string;
  readonly content?: string;
  readonly id?: string;
  readonly toolName?: string;
  readonly toolCall?: unknown;
  readonly [key: string]: unknown;
}

interface PiMessage {
  readonly role?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly [key: string]: unknown;
}

interface PiUsage {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly totalTokens?: unknown;
  readonly [key: string]: unknown;
}

/** `message_start` / `message_update` / `message_end` share one shape. */
export interface PiMessageEvent {
  readonly type: "message_start" | "message_update" | "message_end";
  readonly message?: PiMessage;
  readonly usage?: PiUsage;
  readonly assistantMessageEvent?: PiAssistantMessageEvent;
  readonly [key: string]: unknown;
}

export interface PiAgentStartEvent {
  readonly type: "agent_start";
  readonly [key: string]: unknown;
}

export interface PiAgentEndEvent {
  readonly type: "agent_end";
  readonly messages?: ReadonlyArray<unknown>;
  readonly willRetry?: boolean;
  readonly [key: string]: unknown;
}

export interface PiAgentSettledEvent {
  readonly type: "agent_settled";
  readonly aborted?: boolean;
  readonly [key: string]: unknown;
}

export interface PiToolExecutionStartEvent {
  readonly type: "tool_execution_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly parentToolCallId?: string;
  readonly [key: string]: unknown;
}

export interface PiToolExecutionUpdateEvent {
  readonly type: "tool_execution_update";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly partialResult?: PiToolResult;
  readonly [key: string]: unknown;
}

export interface PiToolExecutionEndEvent {
  readonly type: "tool_execution_end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result?: PiToolResult;
  readonly isError?: boolean;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export interface PiAutoRetryStartEvent {
  readonly type: "auto_retry_start";
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly errorMessage?: string;
  readonly [key: string]: unknown;
}

export interface PiAutoRetryEndEvent {
  readonly type: "auto_retry_end";
  readonly success?: boolean;
  readonly attempt?: number;
  readonly finalError?: string;
  readonly [key: string]: unknown;
}

export interface PiCompactionStartEvent {
  readonly type: "compaction_start";
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface PiCompactionEndEvent {
  readonly type: "compaction_end";
  readonly reason?: string;
  readonly errorMessage?: string;
  readonly aborted?: boolean;
  readonly willRetry?: boolean;
  readonly [key: string]: unknown;
}

export interface PiExtensionErrorEvent {
  readonly type: "extension_error";
  readonly extensionPath?: string;
  readonly event?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

/** Any Pi event type Termweave maps deliberately elsewhere or ignores. */
export interface PiUnknownEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A dialog or notification raised by a Pi extension (section 7 of the doc). */
export interface PiExtensionUiRequest {
  readonly type: "extension_ui_request";
  readonly id?: string;
  readonly method?: string;
  readonly title?: string;
  readonly message?: string;
  readonly options?: ReadonlyArray<string>;
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

/** Reply to a command. Correlate on `id` (may be absent for parse failures). */
export interface PiResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly error?: string;
  readonly data?: unknown;
}

export type PiRecord =
  | PiResponse
  | PiExtensionUiRequest
  | PiMessageEvent
  | PiAgentStartEvent
  | PiAgentEndEvent
  | PiAgentSettledEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiAutoRetryStartEvent
  | PiAutoRetryEndEvent
  | PiCompactionStartEvent
  | PiCompactionEndEvent
  | PiExtensionErrorEvent
  | PiUnknownEvent;

export interface PiModel {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly [key: string]: unknown;
}

export interface PiSessionState {
  readonly model?: PiModel;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled?: boolean;
  readonly messageCount?: number;
  readonly pendingMessageCount?: number;
  readonly [key: string]: unknown;
}

export interface PiSessionStats {
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly cost?: number;
  readonly contextUsage?: {
    readonly tokens?: number | null;
    readonly contextWindow?: number | null;
    readonly percent?: number | null;
  } | null;
  readonly [key: string]: unknown;
}

export interface PiForkMessage {
  readonly entryId: string;
  readonly text: string;
}

/** Commands Termweave sends over the RPC channel. */
export type PiCommand =
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<{
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly type: "abort" }
  | { readonly type: "clear_queue" }
  | { readonly type: "get_state" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: string }
  | { readonly type: "get_available_models" }
  | { readonly type: "get_session_stats" }
  | { readonly type: "get_messages" }
  | { readonly type: "get_fork_messages" }
  | { readonly type: "fork"; readonly entryId: string };

/** Response `data` shape per command, keyed on the sent command. */
export type PiResponseData<C extends PiCommand> = C extends { readonly type: "prompt" }
  ? { readonly disposition: "started" | "queued" | "handled" }
  : C extends { readonly type: "clear_queue" }
    ? { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
    : C extends { readonly type: "get_state" }
      ? PiSessionState
      : C extends { readonly type: "set_model" }
        ? PiModel
        : C extends { readonly type: "get_available_models" }
          ? { readonly models: ReadonlyArray<PiModel> }
          : C extends { readonly type: "get_session_stats" }
            ? PiSessionStats
            : C extends { readonly type: "get_messages" }
              ? { readonly messages: ReadonlyArray<unknown> }
              : C extends { readonly type: "get_fork_messages" }
                ? { readonly messages: ReadonlyArray<PiForkMessage> }
                : C extends { readonly type: "fork" }
                  ? { readonly text: string; readonly cancelled: boolean }
                  : void;

/**
 * Parse one JSONL line from Pi's stdout. Returns undefined for blank or
 * non-object lines that are not protocol records.
 */
export function parsePiRecord(line: string): PiRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as PiRecord;
    }
  } catch {
    // Not JSON; Pi only sends protocol records on stdout, so drop the line.
  }
  return undefined;
}
