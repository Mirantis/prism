/**
 * WebSocket client for prism-cli.
 *
 * Thin wrapper around the `ws` package with:
 * - buffered send() that drains on `open`
 * - JSON envelope parsing (non-objects dropped)
 * - auto-reconnect with exponential backoff (1s → 30s)
 * - inbound `ping` → `pong` reply for the server's keepalive
 *
 * No auth, no headers, no query params — the CLI talks to the agent
 * runtime directly.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface WsEnvelope {
  type: 'chat' | 'status' | 'error' | 'ping' | 'pong' | 'typing' | 'heartbeat' | string;
  payload?: unknown;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class WsClient {
  readonly events = new EventEmitter();
  private readonly url: string;
  private ws: WebSocket | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingOutbound: WsEnvelope[] = [];
  private closed = false;

  constructor(opts: { url: string }) {
    this.url = opts.url;
    this.connect();
  }

  send(env: WsEnvelope): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
      return;
    }
    this.pendingOutbound.push(env);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  private connect(): void {
    if (this.closed) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      // Drain anything buffered while we were disconnected.
      const queued = this.pendingOutbound;
      this.pendingOutbound = [];
      for (const env of queued) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(env));
        }
      }
      this.events.emit('open');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const env = parsed as WsEnvelope;
      if (typeof env.type !== 'string') return;
      // Reply to server keepalive without surfacing it to the UI.
      if (env.type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }
      this.events.emit('envelope', env);
    });

    ws.on('error', (err: Error) => {
      this.events.emit('error', err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.events.emit('close', { code, message: reason?.toString() ?? '' });
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
