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

/**
 * How much of the model's context window a thread is using.
 *
 * Computed by the runtime, which owns both inputs: the provider-reported prompt
 * size and the model's context window (from a models.dev catalog this workspace
 * can't import). Absent for a model whose window the runtime doesn't recognize,
 * in which case nothing is shown.
 */
export interface ContextUsage {
  threadId: string;
  /** The model that actually ran — authoritative, unlike the local settings copy. */
  modelId: string;
  usedTokens: number;
  windowTokens: number;
  /** Share of the window consumed, as an integer 0-100. Rendered as-is. */
  usedPercent: number;
}

export interface TuiAdapterEvents {
  message: (msg: TuiMessage) => void;
  status: (status: TuiStatus, detail?: string) => void;
  /**
   * The runtime named the thread this session is on. A backstop for a failed
   * `startNewSession()`: without a threadId a mid-turn message cannot be steered
   * into the running turn.
   */
  thread: (threadId: string) => void;
  contextUsage: (usage: ContextUsage) => void;
}

/** A resumable conversation thread, as listed by the `--resume` picker. */
export interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  workspaceRoot: string | null;
  branch: string | null;
  /**
   * Last recorded context occupancy, so a resumed session shows a percentage
   * immediately instead of waiting for its first turn to be measured.
   */
  contextUsage: ContextUsage | null;
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
    contextUsage?: unknown;
  };
  if (typeof t.id !== 'string') return null;
  return {
    id: t.id,
    title: typeof t.title === 'string' ? t.title : null,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString(),
    workspaceRoot: typeof t.workspaceRoot === 'string' ? t.workspaceRoot : null,
    branch: typeof t.branch === 'string' ? t.branch : null,
    contextUsage: coerceContextUsage(t.contextUsage),
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

function coerceContextUsage(raw: unknown): ContextUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Partial<ContextUsage>;
  // Every field is required: a partial frame would render as "context NaN%".
  if (
    typeof u.threadId !== 'string' ||
    typeof u.modelId !== 'string' ||
    typeof u.usedTokens !== 'number' ||
    typeof u.windowTokens !== 'number' ||
    typeof u.usedPercent !== 'number'
  ) {
    return null;
  }
  return {
    threadId: u.threadId,
    modelId: u.modelId,
    usedTokens: u.usedTokens,
    windowTokens: u.windowTokens,
    usedPercent: u.usedPercent,
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
   * Replay a thread's recent messages on mount. Calls the runtime's
   * `/messages` REST endpoint; with `threadId` set (the --resume flow) it
   * replays that specific thread, otherwise the latest. If it returns non-2xx
   * (e.g. runtime down), we render with an empty history rather than blocking.
   */
  async loadHistory(args: {
    userId: string;
    agentId: string;
    threadId?: string;
    limit?: number;
  }): Promise<TuiMessage[]> {
    const limit = args.limit ?? 50;
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (args.threadId) params.set('threadId', args.threadId);
      const res = await fetch(`${this.httpUrl}/messages?${params.toString()}`);
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
   * runtime's `POST /threads`, which creates a new thread — and since the
   * runtime always uses the latest thread, opening the CLI begins a clean
   * conversation instead of resuming the last one. The CLI's launch directory
   * (`process.cwd()`) is sent as the thread's workspaceRoot so the agent's
   * shell tools operate from where the user opened the CLI. Errors are
   * swallowed (we fall back to whatever thread the runtime resolves) rather
   * than blocking the UI.
   */
  async startNewSession(): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.httpUrl}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: process.cwd() }),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { threadId: string };
      return body.threadId;
    } catch {
      // Runtime down / unreachable — render anyway; first message will still
      // route through the runtime's thread resolution.
      return undefined;
    }
  }

  /**
   * List resumable conversation threads (most-recent first) for the
   * `--resume` picker. Calls `GET /threads`; returns an empty list on any
   * error so the CLI degrades to "no sessions to resume" instead of crashing.
   */
  async listSessions(): Promise<ThreadSummary[]> {
    try {
      const res = await fetch(`${this.httpUrl}/threads`);
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
   * Send a user message. The runtime fills in `agentId`; pass `threadId` to
   * pin the turn to a specific thread (the --resume flow) — otherwise the
   * runtime resolves the latest thread.
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
        ...(_args.threadId ? { threadId: _args.threadId } : {}),
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
          // Deliberately does NOT flip to idle. A turn publishes each of its
          // text steps as it arrives, and after a mid-turn message the exchange
          // runs another turn — so a reply landing is not evidence the work is
          // over. Treating it as such cleared the spinner (and the "esc to stop"
          // affordance) while the agent was still going. `status.processing`
          // brackets the turn and is the only source of truth.
        }
        break;
      }
      case 'status': {
        const payload = env.payload as { connected?: boolean; processing?: boolean } | undefined;
        // `true` when a turn starts; `false` from the gateway's `finally` on every
        // exit — normal end, error and cancel alike. The connect handshake sends
        // `{ connected: true }` with no `processing` key, and the socket's `open`
        // handler already emits idle for that; hence the boolean guard rather
        // than a truthiness test, which would clear the spinner mid-turn if the
        // handshake were ever re-sent.
        if (typeof payload?.processing === 'boolean') {
          this.events.emit('status', payload.processing ? 'thinking' : 'idle');
        }
        break;
      }
      case 'error': {
        const payload = env.payload as { error?: string } | undefined;
        this.events.emit('status', 'error', payload?.error ?? 'unknown error');
        break;
      }
      case 'thread': {
        // Only a backstop for a failed `startNewSession()`: a chat message sent
        // without a threadId cannot be steered into a running turn — the gateway
        // queues it instead — so learn the id from the runtime when we lack one.
        const payload = env.payload as { threadId?: unknown } | undefined;
        if (typeof payload?.threadId === 'string' && payload.threadId) {
          this.events.emit('thread', payload.threadId);
        }
        break;
      }
      case 'context': {
        const usage = coerceContextUsage(env.payload);
        if (usage) this.events.emit('contextUsage', usage);
        break;
      }
      // typing / heartbeat / pong intentionally ignored
    }
  }
}

export const tuiAdapterService = new TuiAdapter();
