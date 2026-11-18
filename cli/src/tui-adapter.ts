/**
 * TUI Adapter (prism-cli).
 *
 * Bridges the Ink UI to an agent-runtime over the chat socket. The session
 * shows one conversation, and the adapter drops the events of every other one:
 * every client of the agent receives every event. The CLI does not know the
 * agentId or userId; the runtime owns both.
 *
 * The agent-runtime base URL comes from `httpUrl` in ~/.prism/settings.json
 * (override via `PRISM_HTTP_URL`). The WebSocket URL is derived from it.
 */

import { EventEmitter } from 'events';
import { SendFailure, WsClient } from './ws-client.js';
import { loadConfig, wsUrlFromHttpUrl } from './config.js';
import { AttachmentMeta } from './attachments.js';
import type {
  OutgoingMessage,
  StreamEvent,
  ThreadMode,
  TurnEventPayload,
  TurnState,
  Viewer,
  WelcomePayload,
} from './chat-protocol.js';

export type { SendFailure } from './ws-client.js';
export type { TurnEventPayload } from './chat-protocol.js';

/** The connection, for the status bar: connected, or why not. */
export type TuiStatus = 'idle' | 'error';

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
  /**
   * Who wrote a USER message, when the runtime knows: `senderId` tells one person
   * from another, `senderName` is shown.
   */
  senderId?: string | null;
  senderName?: string | null;
  /** For a message from another agent: `message`, `ask`, or a `notice` from the delivery service. */
  agentMessageKind?: 'message' | 'ask' | 'notice' | null;
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

/**
 * Compaction progress frame (WS `compaction` envelope): older history was (or
 * is being) folded into the thread's summary so the model's context shrinks.
 */
export interface CompactionEvent {
  threadId: string;
  /** `skipped` is a benign no-op (nothing to compact), never an error. */
  status: 'started' | 'completed' | 'failed' | 'skipped';
  trigger: 'auto' | 'manual';
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  messagesCompacted?: number;
  /** Failed only — short reason, shown for manual compactions. */
  error?: string;
  /** Skipped only — why there was nothing to do. */
  detail?: string;
  /** Completed only — the conversation was compacted while it sat idle. */
  idle?: boolean;
}

/** Update progress frame (WS `update` envelope). Install-level, not per-thread. */
export interface UpdateEvent {
  status: 'available' | 'updating' | 'failed';
  version: string;
  /** Failed only — machine-readable reason. */
  errorCode?: string;
}

/**
 * A sign-in the agent asked for, taken off a chat message's blocks.
 *
 * Only the kind a username and a password answer reaches here. Every other computer
 * help request is answered in the Web UI, and its message carries the link.
 */
export interface SignInRequest {
  id: string;
  reason: string;
  site?: string;
  fields?: 'both' | 'password';
  /** The conversation it belongs to. A request from another one is not this session's. */
  threadId?: string;
}

/** The sign-in in a message's blocks, when it holds one that is still waiting. */
export function signInRequestIn(blocks: unknown): SignInRequest | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const help = block as {
      type?: unknown;
      id?: unknown;
      reason?: unknown;
      site?: unknown;
      credentials?: unknown;
      credentialFields?: unknown;
      status?: unknown;
    };
    if (help.type !== 'computer_help' || help.credentials !== true) continue;
    if (help.status !== 'waiting') continue;
    if (typeof help.id !== 'string' || typeof help.reason !== 'string') continue;
    return {
      id: help.id,
      reason: help.reason,
      ...(typeof help.site === 'string' ? { site: help.site } : {}),
      ...(help.credentialFields === 'password' ? { fields: 'password' as const } : {}),
    };
  }
  return null;
}

/** The id of a sign-in in a message's blocks that is no longer waiting: answered or dismissed. */
export function endedSignInIn(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const help = block as { type?: unknown; id?: unknown; credentials?: unknown; status?: unknown };
    if (help.type !== 'computer_help' || help.credentials !== true) continue;
    if (help.status !== 'waiting' && typeof help.id === 'string') return help.id;
  }
  return null;
}

export interface TuiAdapterEvents {
  status: (status: TuiStatus, detail?: string) => void;
  /** The runtime answered `hello`, and said who the sign-in says this connection is. */
  welcome: (you: Viewer) => void;
  /** The conversation's stored history, in place of the stored messages on screen. */
  history: (messages: TuiMessage[]) => void;
  /** One message of this conversation, new or changed. Upsert it by id. */
  message: (msg: TuiMessage) => void;
  /** What this conversation is doing. Its work ends only at `idle`. */
  turn: (turn: TurnEventPayload) => void;
  /** The runtime refused a message. It is not sent again. */
  sendFailed: (failure: SendFailure) => void;
  contextUsage: (usage: ContextUsage) => void;
  compaction: (event: CompactionEvent) => void;
  update: (event: UpdateEvent) => void;
  /** The agent is blocked on a sign-in this session can answer. */
  signIn: (request: SignInRequest) => void;
  /** The sign-in with this id is answered or dismissed, in this client or another. */
  signInEnded: (id: string) => void;
  /** The runtime speaks a newer protocol. The client does not reconnect. */
  unsupported: (notice: string) => void;
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
  senderId?: unknown;
  senderName?: unknown;
  agentMessageKind?: unknown;
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

export function coerceThreadSummary(raw: unknown): ThreadSummary | null {
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

export function coerceMessage(raw: unknown): TuiMessage | null {
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
    senderId: typeof m.senderId === 'string' ? m.senderId : null,
    senderName: typeof m.senderName === 'string' ? m.senderName : null,
    agentMessageKind:
      m.agentMessageKind === 'message' || m.agentMessageKind === 'ask' || m.agentMessageKind === 'notice' ? m.agentMessageKind : null,
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

function coerceCompactionEvent(raw: unknown): CompactionEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<CompactionEvent>;
  // Same strictness as coerceContextUsage: a malformed frame must not toggle a
  // "compacting…" indicator it can never clear.
  if (
    typeof e.threadId !== 'string' ||
    (e.status !== 'started' &&
      e.status !== 'completed' &&
      e.status !== 'failed' &&
      e.status !== 'skipped') ||
    (e.trigger !== 'auto' && e.trigger !== 'manual')
  ) {
    return null;
  }
  return {
    threadId: e.threadId,
    status: e.status,
    trigger: e.trigger,
    tokensBefore: typeof e.tokensBefore === 'number' ? e.tokensBefore : null,
    tokensAfter: typeof e.tokensAfter === 'number' ? e.tokensAfter : null,
    ...(e.idle === true ? { idle: true } : {}),
    messagesCompacted: typeof e.messagesCompacted === 'number' ? e.messagesCompacted : undefined,
    error: typeof e.error === 'string' ? e.error : undefined,
    detail: typeof e.detail === 'string' ? e.detail : undefined,
  };
}

function coerceUpdateEvent(raw: unknown): UpdateEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<UpdateEvent>;
  // Same strictness as coerceCompactionEvent: a malformed frame must not raise
  // an update notice nothing can clear.
  if (
    typeof e.version !== 'string' ||
    (e.status !== 'available' && e.status !== 'updating' && e.status !== 'failed')
  ) {
    return null;
  }
  return {
    status: e.status,
    version: e.version,
    errorCode: typeof e.errorCode === 'string' ? e.errorCode : undefined,
  };
}

/** Shown when the runtime closes the socket as too old. Nothing reconnects after it. */
export const UPDATE_REQUIRED_NOTICE =
  'This prism-cli is older than the Prism runtime and cannot connect to it. Update prism-cli, then start it again.';

// Reported in `hello`; the packaged binary sets it at build time.
const CLIENT_VERSION = process.env.PRISM_VERSION ?? '0.0.0-dev';

const HISTORY_LIMIT = 50;

class TuiAdapter {
  readonly events = new EventEmitter();

  private client: WsClient | null = null;
  private readonly httpUrl = loadConfig().httpUrl.replace(/\/$/, '');
  private readonly wsUrl = wsUrlFromHttpUrl(this.httpUrl);
  /** The one conversation this session shows. Events of every other one are dropped. */
  private threadId: string | null = null;
  /** Messages submitted before the conversation existed, sent once it does. */
  private unthreaded: Array<Omit<OutgoingMessage, 'threadId'>> = [];
  /** Events that arrived while history was loading, applied after it. Null while no load runs. */
  private held: StreamEvent[] | null = null;
  private syncGeneration = 0;
  /** Every conversation that is working, from the last `welcome` and the events since. */
  private readonly working = new Map<string, Exclude<TurnState, 'idle'>>();

  markConnected(_userId: string): void {
    if (this.client) return;
    const client = new WsClient({ url: this.wsUrl, clientName: 'prism-cli', clientVersion: CLIENT_VERSION });
    this.client = client;
    client.events.on('welcome', (welcome: WelcomePayload) => this.onWelcome(welcome));
    client.events.on('event', (event: StreamEvent) => this.onEvent(event));
    client.events.on('sendFailed', (failure: SendFailure) => this.events.emit('sendFailed', failure));
    client.events.on('disconnected', () => {
      this.events.emit('status', 'error', 'disconnected, retrying…');
    });
    client.events.on('error', (err: Error) => {
      this.events.emit('status', 'error', err.message);
    });
    client.events.on('unsupported', () => {
      this.events.emit('status', 'error', 'update prism-cli');
      this.events.emit('unsupported', UPDATE_REQUIRED_NOTICE);
    });
  }

  markDisconnected(): void {
    this.client?.close();
    this.client = null;
    this.threadId = null;
    this.unthreaded = [];
    this.held = null;
    this.syncGeneration += 1;
    this.working.clear();
  }

  /**
   * Start a fresh conversation thread for this CLI session with `POST /threads`,
   * and make it the one this session shows. The launch directory
   * (`process.cwd()`) becomes the thread's workspaceRoot, so the agent's shell
   * tools work from where the user opened the CLI. Undefined when the runtime
   * could not create one; the caller tries again.
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
      this.adopt(body.threadId);
      return body.threadId;
    } catch {
      return undefined;
    }
  }

  /**
   * Open this CLI session's conversation and return its id. On an agent in
   * single-thread mode that is the agent's one conversation, shown with its
   * history; otherwise a fresh one (`startNewSession`). Undefined when the
   * runtime did not answer; the caller tries again.
   */
  async openConversation(): Promise<string | undefined> {
    const mode = await this.threadMode();
    if (mode === undefined) return undefined;
    if (mode === 'multi') return this.startNewSession();
    // `GET /threads` lists the one conversation alone, with its context reading.
    const [conversation] = await this.listSessions();
    if (!conversation) return undefined;
    if (conversation.contextUsage) this.events.emit('contextUsage', conversation.contextUsage);
    await this.resumeThread(conversation.id);
    return conversation.id;
  }

  /** How many conversations the agent keeps (`GET /agents/me`). Undefined when the runtime did not answer. */
  async threadMode(): Promise<ThreadMode | undefined> {
    try {
      const res = await fetch(`${this.httpUrl}/agents/me`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { threadMode?: unknown };
      return body.threadMode === 'single' ? 'single' : 'multi';
    } catch {
      return undefined;
    }
  }

  /** Show an existing conversation: its history now (as `history`), and its events from here on. */
  resumeThread(threadId: string): Promise<void> {
    this.adopt(threadId);
    this.emitTurnState(threadId);
    return this.resync();
  }

  /** Make `threadId` the one this session shows, and send what was submitted before it existed. */
  private adopt(threadId: string): void {
    this.threadId = threadId;
    for (const message of this.unthreaded.splice(0)) {
      this.client?.send({ ...message, threadId });
    }
  }

  /**
   * List resumable conversation threads (most-recent first) for the
   * `--resume` picker. Calls `GET /threads`; returns an empty list on any
   * error so the CLI degrades to "no sessions to resume" instead of crashing.
   */
  async listSessions(): Promise<ThreadSummary[]> {
    try {
      // Time-boxed: `--resume` blocks on this before rendering anything at all.
      const res = await fetch(`${this.httpUrl}/threads`, {
        signal: AbortSignal.timeout(15_000),
      });
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
   * Send a message to this session's conversation under the id the caller drew
   * it with. The runtime's copy arrives as a `message` with the same id, or
   * `sendFailed` says why it was refused. A message submitted before the
   * conversation exists waits for it.
   */
  submitUserMessage(args: { id: string; text: string; attachmentIds: string[] }): void {
    const message = { id: args.id, content: args.text, attachmentIds: args.attachmentIds };
    if (!this.threadId) {
      this.unthreaded.push(message);
      return;
    }
    this.client?.send({ ...message, threadId: this.threadId });
  }

  /** Stop this conversation's work, whoever started it. False when it could not be asked. */
  cancel(): boolean {
    if (!this.threadId || !this.client) return false;
    return this.client.cancel(this.threadId);
  }

  private onWelcome(welcome: WelcomePayload): void {
    this.events.emit('status', 'idle');
    this.events.emit('welcome', welcome.you);
    this.working.clear();
    for (const turn of welcome.snapshot.turns) this.working.set(turn.threadId, turn.state);
    const threadId = this.threadId;
    if (!threadId) return;
    this.emitTurnState(threadId);
    if (!welcome.resumed) void this.resync();
  }

  private emitTurnState(threadId: string): void {
    const turn: TurnEventPayload = { threadId, state: this.working.get(threadId) ?? 'idle' };
    this.events.emit('turn', turn);
  }

  private onEvent(event: StreamEvent): void {
    if (this.held) {
      this.held.push(event);
      return;
    }
    this.apply(event);
  }

  private apply(event: StreamEvent): void {
    switch (event.type) {
      case 'message': {
        const msg = coerceMessage(event.payload);
        if (!msg || msg.threadId !== this.threadId) return;
        this.events.emit('message', msg);
        this.emitSignIn(msg);
        return;
      }
      case 'turn': {
        const turn = event.payload as TurnEventPayload;
        if (turn.state === 'idle') this.working.delete(turn.threadId);
        else this.working.set(turn.threadId, turn.state);
        if (turn.threadId === this.threadId) this.events.emit('turn', turn);
        return;
      }
      case 'context': {
        const usage = coerceContextUsage(event.payload);
        if (usage && usage.threadId === this.threadId) this.events.emit('contextUsage', usage);
        return;
      }
      case 'compaction': {
        const compaction = coerceCompactionEvent(event.payload);
        if (!compaction || compaction.threadId !== this.threadId) return;
        this.events.emit('compaction', compaction);
        // Older messages were folded into the summary, so the stored history changed.
        if (compaction.status === 'completed') void this.resync();
        return;
      }
      case 'update': {
        const update = coerceUpdateEvent(event.payload);
        if (update) this.events.emit('update', update);
        return;
      }
      // `thread` and `computer` events have no place in the terminal UI.
    }
  }

  /**
   * Replace the conversation on screen with its stored history. Events that
   * arrive meanwhile are held and applied after it, so none is lost between the
   * read and the live stream. Only the newest load applies.
   */
  private async resync(): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) return;
    this.syncGeneration += 1;
    const generation = this.syncGeneration;
    this.held ??= [];
    const messages = await this.loadHistory(threadId);
    if (generation !== this.syncGeneration) return;
    const held = this.held;
    this.held = null;
    if (messages) {
      this.events.emit('history', messages);
      // A sign-in can be asked for or answered while the stream was away.
      for (const msg of messages) this.emitSignIn(msg);
    } else {
      this.events.emit('status', 'error', 'could not reload the conversation');
    }
    for (const event of held) this.apply(event);
  }

  /** The sign-in this message asks for or ends. */
  private emitSignIn(msg: TuiMessage): void {
    const signIn = signInRequestIn(msg.blocks);
    if (signIn) this.events.emit('signIn', { ...signIn, threadId: msg.threadId });
    const ended = endedSignInIn(msg.blocks);
    if (ended) this.events.emit('signInEnded', ended);
  }

  /** The thread's newest messages, oldest first, from `GET /messages`. Null when the runtime did not answer. */
  private async loadHistory(threadId: string): Promise<TuiMessage[] | null> {
    try {
      const params = new URLSearchParams({ limit: String(HISTORY_LIMIT), threadId });
      // Time-boxed: a runtime that accepts the connection but never answers
      // must not hold the conversation's events forever.
      const res = await fetch(`${this.httpUrl}/messages?${params.toString()}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return null;
      return body.map(coerceMessage).filter((m): m is TuiMessage => m !== null);
    } catch {
      return null;
    }
  }
}

export const tuiAdapterService = new TuiAdapter();
