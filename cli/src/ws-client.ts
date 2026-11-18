/**
 * The chat socket client for prism-cli, protocol version 2 (`docs/websocket-protocol.md`).
 *
 * - Says `hello` first, with the cursor of the last applied event, so a
 *   reconnect gets back every event it missed.
 * - Numbers events: a gap drops the socket, and the reconnect resumes from the
 *   last event applied.
 * - Keeps every message in an outbox until the runtime confirms it, and sends
 *   the outbox again, under the same message ids, after every `welcome`.
 * - Pings every 25 seconds. A socket that does not answer in 10 seconds is dead.
 * - Reconnects with a backoff of 1 s doubling to 30 s. Only a connection that
 *   stays open for 30 seconds resets it, so a runtime that accepts and then
 *   drops the socket is not hammered.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  CLIENT_PING_INTERVAL_MS,
  CLIENT_PONG_DEADLINE_MS,
  CLOSE_CODES,
  NackCode,
  NackPayload,
  OutgoingMessage,
  PROTOCOL_VERSION,
  SendAckPayload,
  StreamEvent,
  WelcomePayload,
} from './chat-protocol.js';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_AFTER_MS = 30_000;

// A send's request id is its message id with this prefix, so an `ack` or a
// `nack` names the message it answers without a table of requests.
const SEND_PREFIX = 'send-';

/** A message the runtime refused to store. It leaves the outbox and is not sent again. */
export interface SendFailure {
  messageId: string;
  code: NackCode;
  message: string;
}

interface Frame {
  type: string;
  seq?: number;
  re?: string | null;
  payload?: unknown;
}

function parseFrame(data: WebSocket.RawData): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const frame = parsed as Frame;
  return typeof frame.type === 'string' ? frame : null;
}

function sentMessageId(re: string | null | undefined): string | null {
  if (!re?.startsWith(SEND_PREFIX)) return null;
  return re.slice(SEND_PREFIX.length);
}

/**
 * Events: `welcome` (WelcomePayload), `event` (StreamEvent, in order and without
 * gaps), `sent` (SendAckPayload), `sendFailed` (SendFailure), `disconnected`
 * ({ code, reason }), `error` (Error), and `unsupported` (reason), after which
 * the client stops.
 */
export class WsClient {
  readonly events = new EventEmitter();
  private readonly url: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private ws: WebSocket | null = null;
  /** True between `welcome` and the socket closing. Nothing but `hello` is sent before. */
  private live = false;
  private stopped = false;
  private cursor: { streamId: string; seq: number } | null = null;
  private readonly outbox = new Map<string, OutgoingMessage>();
  private backoffMs = INITIAL_BACKOFF_MS;
  private requestCount = 0;
  private pingId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private readonly retryTimers = new Set<NodeJS.Timeout>();

  /** `clientName` is what this client calls itself in `hello`. */
  constructor(opts: { url: string; clientName: string; clientVersion: string }) {
    this.url = opts.url;
    this.clientName = opts.clientName;
    this.clientVersion = opts.clientVersion;
    this.connect();
  }

  /** Send a message now if the socket is live, and after every `welcome` until it is confirmed. */
  send(message: OutgoingMessage): void {
    this.outbox.set(message.id, message);
    if (this.live) this.transmit(message);
  }

  /** Stop a conversation's work. False when there is no live socket to say it on. */
  cancel(threadId: string): boolean {
    return this.request({ type: 'cancel', id: this.nextId('cancel'), payload: { threadId } });
  }

  close(): void {
    this.stopped = true;
    this.live = false;
    this.clearConnectionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => this.onOpen(ws));
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (ws !== this.ws || isBinary) return;
      const frame = parseFrame(data);
      if (frame) this.onFrame(ws, frame);
    });
    ws.on('error', (err: Error) => this.events.emit('error', err));
    ws.on('close', (code: number, reason: Buffer) => this.onClose(ws, code, reason.toString()));
  }

  private onOpen(ws: WebSocket): void {
    this.stableTimer = setTimeout(() => {
      this.backoffMs = INITIAL_BACKOFF_MS;
    }, STABLE_AFTER_MS);
    this.write(ws, {
      type: 'hello',
      id: this.nextId('hello'),
      payload: {
        protocol: PROTOCOL_VERSION,
        client: { name: this.clientName, version: this.clientVersion },
        ...(this.cursor ? { resume: { ...this.cursor } } : {}),
      },
    });
    // A runtime that takes `hello` and never answers is as dead as one that
    // stops answering pings.
    this.armDeadline(ws);
  }

  private onFrame(ws: WebSocket, frame: Frame): void {
    if (typeof frame.seq === 'number') {
      this.onEvent(ws, frame as StreamEvent);
      return;
    }
    switch (frame.type) {
      case 'welcome':
        this.onWelcome(ws, frame.payload as WelcomePayload);
        return;
      case 'pong':
        if (frame.re === this.pingId) this.clearDeadline();
        return;
      case 'ack':
        this.onAck(frame.re, frame.payload as SendAckPayload);
        return;
      case 'nack':
        this.onNack(frame.re, frame.payload as NackPayload);
        return;
    }
  }

  private onWelcome(ws: WebSocket, welcome: WelcomePayload): void {
    this.clearDeadline();
    // A resumed socket replays from our cursor next. Otherwise the replay is
    // gone, and the stream goes on from the runtime's newest event.
    if (!welcome.resumed) this.cursor = { streamId: welcome.streamId, seq: welcome.seq };
    this.live = true;
    this.heartbeatTimer = setInterval(() => this.ping(ws), CLIENT_PING_INTERVAL_MS);
    this.events.emit('welcome', welcome);
    // Everything unconfirmed goes out now, a message waiting out a rate limit
    // included, so its timer would only send it twice.
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const message of this.outbox.values()) this.transmit(message);
  }

  private onEvent(ws: WebSocket, event: StreamEvent): void {
    const cursor = this.cursor;
    if (!this.live || !cursor) return;
    if (event.seq !== cursor.seq + 1) {
      this.drop(ws);
      return;
    }
    cursor.seq = event.seq;
    this.events.emit('event', event);
  }

  private onAck(re: string | null | undefined, payload: SendAckPayload): void {
    const messageId = sentMessageId(re);
    if (!messageId) return;
    this.outbox.delete(messageId);
    this.events.emit('sent', payload);
  }

  private onNack(re: string | null | undefined, payload: NackPayload): void {
    // Only a refused send needs an answer. A refused `hello` ends in close 4426,
    // an unanswered ping in a reconnect, and a turn's state arrives as events.
    const messageId = sentMessageId(re);
    const message = messageId ? this.outbox.get(messageId) : undefined;
    if (!messageId || !message) return;
    if (payload.code === 'rate_limited') {
      this.retryLater(message, payload.retryAfterMs ?? INITIAL_BACKOFF_MS);
      return;
    }
    this.outbox.delete(messageId);
    const failure: SendFailure = { messageId, code: payload.code, message: payload.message };
    this.events.emit('sendFailed', failure);
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    // `close()` already let go of this socket.
    if (ws !== this.ws) return;
    this.ws = null;
    this.live = false;
    this.clearConnectionTimers();
    if (code === CLOSE_CODES.protocolUnsupported) {
      this.stopped = true;
      this.events.emit('unsupported', reason);
      return;
    }
    // Every other close reconnects, 4001 included: this client is in use for as
    // long as the terminal UI runs.
    this.events.emit('disconnected', { code, reason });
    this.scheduleReconnect();
  }

  /** Give up on a socket that is dead or out of step. Its `close` reconnects and resumes. */
  private drop(ws: WebSocket): void {
    this.live = false;
    ws.terminate();
  }

  private ping(ws: WebSocket): void {
    this.pingId = this.nextId('ping');
    this.write(ws, { type: 'ping', id: this.pingId });
    this.armDeadline(ws);
  }

  private armDeadline(ws: WebSocket): void {
    this.clearDeadline();
    this.deadlineTimer = setTimeout(() => this.drop(ws), CLIENT_PONG_DEADLINE_MS);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private retryLater(message: OutgoingMessage, delayMs: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.live && this.outbox.has(message.id)) this.transmit(message);
    }, delayMs);
    this.retryTimers.add(timer);
  }

  private transmit(message: OutgoingMessage): void {
    this.request({ type: 'send', id: SEND_PREFIX + message.id, payload: { message } });
  }

  private request(frame: { type: string; id: string; payload?: unknown }): boolean {
    const ws = this.ws;
    if (!this.live || !ws) return false;
    this.write(ws, frame);
    return true;
  }

  private write(ws: WebSocket, frame: object): void {
    ws.send(JSON.stringify(frame));
  }

  private nextId(kind: string): string {
    this.requestCount += 1;
    return `${kind}-${this.requestCount}`;
  }

  private clearConnectionTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.heartbeatTimer = null;
    this.stableTimer = null;
    this.pingId = null;
    this.clearDeadline();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
