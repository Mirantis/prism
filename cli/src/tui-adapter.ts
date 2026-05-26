/**
 * TUI Adapter (prism-cli).
 *
 * Bridges the Ink UI to an agent-runtime over WebSocket. The CLI does
 * not know the agentId or userId — the runtime owns both server-side
 * and substitutes them when our envelopes omit them.
 *
 * The agent-runtime base URL comes from `httpUrl` in ~/.prism/settings.json
 * (override via `PRISM_HTTP_URL`). The WebSocket URL is derived from it.
 */

import { EventEmitter } from 'events';
import { WsClient, WsEnvelope } from './ws-client.js';
import { loadConfig, wsUrlFromHttpUrl } from './config.js';

export type TuiStatus = 'idle' | 'thinking' | 'error';

export interface TuiMessage {
  id: string;
  threadId: string;
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  triggeredBy: string;
  toolCalls: unknown;
  blocks: unknown;
  createdAt: string;
}

export interface TuiAdapterEvents {
  message: (msg: TuiMessage) => void;
  status: (status: TuiStatus, detail?: string) => void;
}

interface RawMessage {
  id?: unknown;
  threadId?: unknown;
  role?: unknown;
  content?: unknown;
  triggeredBy?: unknown;
  toolCalls?: unknown;
  blocks?: unknown;
  createdAt?: unknown;
}

function coerceMessage(raw: unknown): TuiMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as RawMessage;
  if (typeof m.id !== 'string' || typeof m.content !== 'string') return null;
  const role = m.role === 'USER' || m.role === 'AGENT' || m.role === 'SYSTEM'
    ? m.role
    : 'AGENT';
  return {
    id: m.id,
    threadId: typeof m.threadId === 'string' ? m.threadId : '',
    role,
    content: m.content,
    triggeredBy: typeof m.triggeredBy === 'string' ? m.triggeredBy : 'USER_INPUT',
    toolCalls: m.toolCalls ?? null,
    blocks: m.blocks ?? null,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
  };
}

class TuiAdapter {
  readonly events = new EventEmitter();

  private client: WsClient | null = null;
  private readonly httpUrl = loadConfig().httpUrl.replace(/\/$/, '');
  private readonly wsUrl = wsUrlFromHttpUrl(this.httpUrl);

  markConnected(_userId: string): void {
    if (this.client) return;
    this.client = new WsClient({ url: this.wsUrl });

    this.client.events.on('open', () => {
      this.events.emit('status', 'idle');
    });
    this.client.events.on('close', () => {
      this.events.emit('status', 'error', 'disconnected, retrying…');
    });
    this.client.events.on('error', (err: Error) => {
      this.events.emit('status', 'error', err.message);
    });
    this.client.events.on('envelope', (env: WsEnvelope) => this.onEnvelope(env));
  }

  markDisconnected(): void {
    if (!this.client) return;
    this.client.close();
    this.client = null;
  }

  /**
   * Replay the active thread's recent messages on mount. Calls the
   * runtime's `/single-agent/messages` REST endpoint; if it returns
   * non-2xx (e.g. runtime down), we render with an empty history rather
   * than blocking.
   */
  async loadHistory(args: {
    userId: string;
    agentId: string;
    limit?: number;
  }): Promise<TuiMessage[]> {
    const limit = args.limit ?? 50;
    try {
      const res = await fetch(`${this.httpUrl}/single-agent/messages?limit=${limit}`);
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      return body
        .map(coerceMessage)
        .filter((m): m is TuiMessage => m !== null);
    } catch {
      return [];
    }
  }

  /**
   * Send a user message. The runtime fills in `agentId` (and resolves
   * the active thread), so we only send the content + mode.
   */
  async submitUserMessage(_args: {
    userId: string;
    agentId: string;
    text: string;
    threadId?: string;
  }): Promise<void> {
    this.events.emit('status', 'thinking');
    if (!this.client) {
      // markConnected hasn't fired yet (mount race). Buffer by re-emitting
      // an error so the UI doesn't get stuck on the spinner — submitting
      // before mount is exceedingly rare.
      this.events.emit('status', 'error', 'not connected');
      return;
    }
    this.client.send({
      type: 'chat',
      payload: { mode: 'followup', content: _args.text },
    });
  }

  private onEnvelope(env: WsEnvelope): void {
    switch (env.type) {
      case 'chat': {
        const msg = coerceMessage(env.payload);
        if (msg) {
          this.events.emit('message', msg);
          // The runtime doesn't emit a `processing: false` status when it
          // finishes — the agent reply landing is the signal. Flip back to
          // idle so the spinner clears.
          if (msg.role === 'AGENT') this.events.emit('status', 'idle');
        }
        break;
      }
      case 'status': {
        const payload = env.payload as { connected?: boolean; processing?: boolean } | undefined;
        if (payload?.processing) {
          this.events.emit('status', 'thinking');
        } else if (payload?.connected) {
          this.events.emit('status', 'idle');
        }
        break;
      }
      case 'error': {
        const payload = env.payload as { error?: string } | undefined;
        this.events.emit('status', 'error', payload?.error ?? 'unknown error');
        break;
      }
      // typing / heartbeat / pong intentionally ignored
    }
  }
}

export const tuiAdapterService = new TuiAdapter();
