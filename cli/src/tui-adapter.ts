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
import { AttachmentMeta } from './attachments.js';

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
  /** Shared-file metadata (no bytes) — set on user messages with uploads. */
  attachments?: AttachmentMeta[] | null;
}

export interface TuiAdapterEvents {
  message: (msg: TuiMessage) => void;
  status: (status: TuiStatus, detail?: string) => void;
}

/** A resumable conversation thread, as listed by the `--resume` picker. */
export interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  workspaceRoot: string | null;
  branch: string | null;
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
  attachments?: unknown;
}

/** Keep only well-formed attachment metadata entries; null when none survive. */
function coerceAttachments(raw: unknown): AttachmentMeta[] | null {
  if (!Array.isArray(raw)) return null;
  const valid = raw.filter(
    (a): a is AttachmentMeta =>
      a !== null &&
      typeof a === 'object' &&
      typeof (a as AttachmentMeta).id === 'string' &&
      typeof (a as AttachmentMeta).filename === 'string' &&
      typeof (a as AttachmentMeta).sizeBytes === 'number',
  );
  return valid.length > 0 ? valid : null;
}

function coerceThreadSummary(raw: unknown): ThreadSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as {
    id?: unknown;
    title?: unknown;
    updatedAt?: unknown;
    workspaceRoot?: unknown;
    branch?: unknown;
  };
  if (typeof t.id !== 'string') return null;
  return {
    id: t.id,
    title: typeof t.title === 'string' ? t.title : null,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString(),
    workspaceRoot: typeof t.workspaceRoot === 'string' ? t.workspaceRoot : null,
    branch: typeof t.branch === 'string' ? t.branch : null,
  };
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
    attachments: coerceAttachments(m.attachments),
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
   * Start a fresh conversation thread for this CLI session. Calls the
   * runtime's `POST /single-agent/threads`, which creates a new thread — and
   * since the runtime always uses the latest thread, opening the CLI begins a
   * clean conversation instead of resuming the last one. The CLI's launch directory
   * (`process.cwd()`) is sent as the thread's workspaceRoot so the agent's
   * shell tools operate from where the user opened the CLI. Errors are
   * swallowed (we fall back to whatever thread the runtime resolves) rather
   * than blocking the UI.
   */
  async startNewSession(): Promise<void> {
    try {
      await fetch(`${this.httpUrl}/single-agent/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: process.cwd() }),
      });
    } catch {
      // Runtime down / unreachable — render anyway; first message will still
      // route through the runtime's thread resolution.
    }
  }

  /**
   * List resumable conversation threads (most-recent first) for the
   * `--resume` picker. Calls `GET /single-agent/threads`; returns an empty
   * list on any error so the CLI degrades to "no sessions to resume" instead
   * of crashing.
   */
  async listSessions(): Promise<ThreadSummary[]> {
    try {
      const res = await fetch(`${this.httpUrl}/single-agent/threads`);
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      return body
        .map(coerceThreadSummary)
        .filter((t): t is ThreadSummary => t !== null);
    } catch {
      return [];
    }
  }

  /**
   * Resume an existing thread: ask the runtime to make it the latest thread so
   * the subsequent chat + history replay route to it. Errors are swallowed —
   * the UI renders regardless, and the first message falls back to the
   * runtime's thread resolution.
   */
  async resumeSession(threadId: string): Promise<void> {
    try {
      await fetch(
        `${this.httpUrl}/single-agent/threads/${encodeURIComponent(threadId)}/resume`,
        { method: 'POST' },
      );
    } catch {
      // Runtime down / unreachable — render anyway.
    }
  }

  /**
   * Send a user message. The runtime fills in `agentId` (and resolves
   * the latest thread), so we only send the content + mode.
   */
  async submitUserMessage(_args: {
    userId: string;
    agentId: string;
    text: string;
    threadId?: string;
    /** Ids of files staged via /attach, linked to this message server-side. */
    attachmentIds?: string[];
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
      payload: {
        mode: 'followup',
        content: _args.text,
        ...(_args.attachmentIds && _args.attachmentIds.length > 0
          ? { attachmentIds: _args.attachmentIds }
          : {}),
      },
    });
  }

  /**
   * Cancel the in-flight turn: tell the runtime to abort the LLM generation
   * and optimistically flip back to idle so the spinner clears immediately
   * (the runtime also broadcasts a terminal `processing: false` status).
   */
  cancel(): void {
    this.client?.send({ type: 'cancel' });
    this.events.emit('status', 'idle');
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
        } else if (payload?.processing === false || payload?.connected) {
          // processing:false is broadcast when a turn ends (completion or
          // cancel) so the spinner clears even when no AGENT message lands.
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
