/**
 * Browser WebSocket client for the desktop GUI.
 *
 * Port of the prism-cli's ws-client to the browser WebSocket API:
 * - buffered send() that drains on `open`
 * - JSON envelope parsing (non-objects dropped)
 * - auto-reconnect with exponential backoff (1s → 30s)
 * - inbound `ping`/`heartbeat` → `pong` reply for the server's keepalive
 *
 * No auth, no headers, no query params — the GUI talks to the runtime
 * directly, exactly like the CLI.
 */

export interface WsEnvelope {
  type: string;
  payload?: unknown;
}

type WsEvent = 'open' | 'close' | 'error' | 'envelope';
type Listener = (arg?: unknown) => void;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOutbound: WsEnvelope[] = [];
  private closed = false;
  private readonly listeners: Record<WsEvent, Set<Listener>> = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    envelope: new Set(),
  };

  constructor(private readonly url: string) {
    this.connect();
  }

  on(event: WsEvent, fn: Listener): void {
    this.listeners[event].add(fn);
  }

  private emit(event: WsEvent, arg?: unknown): void {
    this.listeners[event].forEach((fn) => fn(arg));
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
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      const queued = this.pendingOutbound;
      this.pendingOutbound = [];
      for (const env of queued) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
      }
      this.emit('open');
    };

    ws.onmessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const env = parsed as WsEnvelope;
      if (typeof env.type !== 'string') return;
      // Reply to server keepalive without surfacing it to the UI.
      if (env.type === 'ping' || env.type === 'heartbeat') {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      this.emit('envelope', env);
    };

    ws.onerror = () => {
      this.emit('error', new Error('websocket error'));
    };

    ws.onclose = () => {
      this.emit('close');
      this.ws = null;
      this.scheduleReconnect();
    };
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
