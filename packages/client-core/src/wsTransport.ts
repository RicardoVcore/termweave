import {
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  WebSocketResponse,
  type WsResponse as WsResponseMessage,
  WsResponse as WsResponseSchema,
} from "@termweave/contracts";
import { decodeUnknownJsonResult, formatSchemaError } from "@termweave/shared/schemaJson";
import { Result, Schema } from "effect";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface SubscribeOptions {
  readonly replayLatest?: boolean;
}

interface RequestOptions {
  readonly timeoutMs?: number | null;
}

export type TransportState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "suspended"
  | "disposed";

interface WebSocketLike {
  readonly readyState: number;
  onopen: ((...args: any[]) => unknown) | null;
  onmessage: ((...args: any[]) => unknown) | null;
  onclose: ((...args: any[]) => unknown) | null;
  onerror: ((...args: any[]) => unknown) | null;
  addEventListener?(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; type?: string }) => void,
  ): void;
  close(): void;
  send(data: string): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WsTransportOptions {
  readonly url: string;
  readonly WebSocketCtor?: WebSocketCtor;
  readonly onWarning?: (message: string, details?: unknown) => void;
  /** Fired on every transport state transition, so callers can render connection
   *  status and resync after a reconnect. */
  readonly onStateChange?: (state: TransportState, previous: TransportState) => void;
  /** Fired when the socket opens again after having been open before - i.e. a
   *  reconnect, whether automatic or a manual reconnect() from suspend. Not fired
   *  on the initial connection. Callers use it to resync state missed while gone. */
  readonly onReconnect?: () => void;
}

const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const decodeWsResponse = decodeUnknownJsonResult(WsResponseSchema);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

const isWsPushMessage = (value: WsResponseMessage): value is WsPush =>
  "type" in value && value.type === "push";

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(fallback);
}

function getDefaultWebSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error("Global WebSocket implementation not available.");
  }
  return ctor;
}

export class WsTransport {
  private ws: WebSocketLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private readonly outboundQueue: string[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private hasOpened = false;
  private state: TransportState = "connecting";
  private readonly url: string;
  private readonly WebSocketCtor: WebSocketCtor;
  private readonly onWarning: (message: string, details?: unknown) => void;
  private readonly onStateChange:
    | ((state: TransportState, previous: TransportState) => void)
    | undefined;
  private readonly onReconnect: (() => void) | undefined;

  constructor(options: WsTransportOptions) {
    this.url = options.url;
    this.WebSocketCtor = options.WebSocketCtor ?? getDefaultWebSocketCtor();
    this.onWarning = options.onWarning ?? ((message, details) => console.warn(message, details));
    this.onStateChange = options.onStateChange;
    this.onReconnect = options.onReconnect;
    this.connect();
  }

  /** Single choke point for state writes; notifies listeners only on real change. */
  private setState(next: TransportState) {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    try {
      this.onStateChange?.(next, previous);
    } catch {
      // Never let a listener break the transport.
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }
    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
    const message: WsRequestEnvelope = { id, body };
    const encoded = JSON.stringify(message);

    return await new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Request timed out: ${method}`));
            }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(encoded);
    });
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: SubscribeOptions,
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
    }

    const wrappedListener = (message: WsPush) => {
      listener(message as WsPushMessage<C>);
    };
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) {
        wrappedListener(latest);
      }
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  getState(): TransportState {
    return this.state;
  }

  dispose() {
    this.disposed = true;
    this.setState("disposed");
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      pending.reject(new Error("Transport disposed"));
    }
    this.pending.clear();
    this.outboundQueue.length = 0;
    this.ws?.close();
    this.ws = null;
  }

  /** Stop the auto-reconnect loop but keep the instance alive. The caller can
   *  resume later with reconnect(). Unlike dispose(), this is not terminal. */
  stopReconnecting() {
    if (this.disposed || this.state === "suspended") return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error("Reconnect cancelled."));
    this.outboundQueue.length = 0;
    this.ws?.close();
    this.ws = null;
    this.setState("suspended");
  }

  /** Manually (re)start connecting after a suspend or close. Closes any
   *  in-progress socket first so a stale attempt cannot leak. */
  reconnect() {
    if (this.disposed || this.state === "open" || this.state === "connecting") return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const stale = this.ws;
    this.ws = null;
    stale?.close();
    this.reconnectAttempt = 0;
    this.connect();
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private connect() {
    if (this.disposed) {
      return;
    }
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new this.WebSocketCtor(this.url);
    this.ws = ws;

    const handleOpen = () => {
      if (this.ws !== ws) {
        return;
      }
      this.reconnectAttempt = 0;
      const reopened = this.hasOpened;
      this.hasOpened = true;
      this.setState("open");
      this.flushQueue();
      if (reopened) {
        try {
          this.onReconnect?.();
        } catch {
          // Never let a listener break the transport.
        }
      }
    };
    const handleMessage = (event: { data?: unknown }) => {
      if (this.ws !== ws) {
        return;
      }
      this.handleMessage(event.data);
    };
    const handleClose = () => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      this.outboundQueue.length = 0;
      this.rejectPending(new Error("WebSocket connection closed."));
      if (this.disposed) {
        this.setState("disposed");
        return;
      }
      this.setState("closed");
      this.scheduleReconnect();
    };
    const handleError = (event: { type?: string }) => {
      if (this.ws !== ws) {
        return;
      }
      this.onWarning("WebSocket connection error", { type: event.type, url: this.url });
    };

    if (ws.addEventListener) {
      ws.addEventListener("open", handleOpen);
      ws.addEventListener("message", handleMessage);
      ws.addEventListener("close", handleClose);
      ws.addEventListener("error", handleError);
      return;
    }

    Object.assign(ws, {
      onopen: handleOpen,
      onmessage: handleMessage,
      onclose: handleClose,
      onerror: handleError,
    });
  }

  private handleMessage(raw: unknown) {
    const result = decodeWsResponse(raw);
    if (Result.isFailure(result)) {
      this.onWarning("Dropped inbound WebSocket envelope", formatSchemaError(result.failure));
      return;
    }
    const message = result.success;
    if (isWsPushMessage(message)) {
      this.latestPushByChannel.set(message.channel, message);
      const channelListeners = this.listeners.get(message.channel);
      if (channelListeners) {
        for (const listener of channelListeners) {
          try {
            listener(message);
          } catch {
            // Swallow listener errors
          }
        }
      }
      return;
    }
    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    if (pending.timeout !== null) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private send(encoded: string) {
    if (this.ws?.readyState !== 1) {
      this.outboundQueue.push(encoded);
      return;
    }
    try {
      this.ws.send(encoded);
    } catch (error) {
      throw asError(error, "Failed to send WebSocket request.");
    }
  }

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== 1) {
      return;
    }
    while (this.outboundQueue.length > 0) {
      const next = this.outboundQueue.shift();
      if (!next) {
        continue;
      }
      this.ws.send(next);
    }
  }

  private scheduleReconnect() {
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 8_000;
    this.reconnectAttempt += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
