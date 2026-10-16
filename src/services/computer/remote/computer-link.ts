/**
 * One remote computer's open link: JSON-RPC 2.0 requests and notifications in both
 * directions, and the binary frames of its screen stream.
 *
 * Every request the runtime sends has a deadline, and a link that closes fails every
 * request still waiting, so no tool call outlives the computer it was sent to.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ZodType } from 'zod';
import {
  LINK_CLOSE,
  RPC_ERROR,
  rpcMessage,
  type LinkErrorReason,
} from './link-protocol';

/** Why a request to the computer failed: its own refusal, or the link. */
export class LinkError extends Error {
  constructor(
    message: string,
    readonly reason: LinkErrorReason | 'timeout' | 'closed',
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LinkError';
  }
}

export interface LinkRequest {
  id: number | string;
  method: string;
  params: unknown;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function asBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function reasonOf(data: unknown): LinkErrorReason {
  const reason = (data as { reason?: unknown } | undefined)?.reason;
  return reason === 'permission_denied' ||
    reason === 'unsupported' ||
    reason === 'held' ||
    reason === 'busy' ||
    reason === 'invalid_params'
    ? reason
    : 'internal';
}

/**
 * Emits `request` (a `LinkRequest`), `notification` (method, params), `binary` (a Buffer)
 * and `close` (code, reason).
 */
export class ComputerLink extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly ws: WebSocket) {
    super();
    ws.on('message', (data, binary) => this.receive(asBuffer(data), binary));
    ws.on('close', (code, reason) => this.ended(code, reason.toString()));
  }

  get open(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** Bytes queued on the socket and not yet sent. */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /**
   * `onAnswer` runs as the answer is read, before any frame that follows it on the link,
   * where a promise's callback runs only after the frames that arrived with it.
   */
  request<T>(
    method: string,
    params: unknown,
    schema: ZodType<T>,
    timeoutMs: number,
    onAnswer?: (value: T) => void,
  ): Promise<T> {
    if (!this.open) return Promise.reject(new LinkError('The computer is not connected.', 'closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError('The computer did not answer in time.', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          const parsed = schema.safeParse(value);
          if (!parsed.success) {
            reject(new LinkError('The computer sent an answer this runtime cannot read.', 'internal'));
            return;
          }
          onAnswer?.(parsed.data);
          resolve(parsed.data);
        },
        reject,
        timer,
      });
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  answer(id: number | string, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  fail(id: number | string | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }

  private send(message: object): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private receive(data: Buffer, binary: boolean): void {
    if (this.closed) return;
    if (binary) {
      this.emit('binary', data);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data.toString('utf8'));
    } catch {
      this.close(LINK_CLOSE.protocolError, 'not JSON');
      return;
    }
    const parsed = rpcMessage.safeParse(value);
    if (!parsed.success) {
      this.fail(null, RPC_ERROR.invalidRequest, 'Not a JSON-RPC 2.0 message.');
      this.close(LINK_CLOSE.protocolError, 'not JSON-RPC 2.0');
      return;
    }
    const message = parsed.data;
    if ('method' in message) {
      if ('id' in message) this.emit('request', { id: message.id, method: message.method, params: message.params });
      else this.emit('notification', message.method, message.params);
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if ('error' in message) {
      const data = (message.error.data ?? {}) as Record<string, unknown>;
      pending.reject(new LinkError(message.error.message, reasonOf(data), data));
    } else {
      pending.resolve(message.result);
    }
  }

  private ended(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new LinkError('The computer disconnected.', 'closed'));
    }
    this.pending.clear();
    this.emit('close', code, reason);
  }
}
