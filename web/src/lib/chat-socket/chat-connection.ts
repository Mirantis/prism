import type {
  Attachment,
  CompactionEvent,
  ComputerStatus,
  ContextUsage,
  ConversationMessage,
  UpdateEvent,
} from '@/types';
import {
  CLIENT_NAME,
  CLIENT_PING_INTERVAL_MS,
  CLIENT_PONG_DEADLINE_MS,
  CLOSE_CODES,
  MAX_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  STABLE_CONNECTION_MS,
  type ConnectionStatus,
  type DictationEvent,
  type NackPayload,
  type ThreadEvent,
  type TurnEvent,
  type VoiceEvent,
  type VoiceFormat,
  type VoiceStartOptions,
  type WelcomePayload,
} from './protocol';
import type { TranscriptMessage } from './transcript';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** What a consumer hears. Each handler is optional. */
export interface ChatListener {
  message?: (message: ConversationMessage) => void;
  turn?: (event: TurnEvent) => void;
  thread?: (event: ThreadEvent) => void;
  context?: (usage: ContextUsage) => void;
  compaction?: (event: CompactionEvent) => void;
  computer?: (status: ComputerStatus) => void;
  update?: (event: UpdateEvent) => void;
  voice?: (event: VoiceEvent) => void;
  /**
   * A frame of the agent's speech. Called from the socket handler with no await in
   * front of it, so the audio keeps its order against the `voice_clear` that cancels it.
   */
  voiceAudio?: (frame: ArrayBuffer) => void;
  dictation?: (event: DictationEvent) => void;
  /**
   * The runtime could not replay what this tab missed. Reload what is on screen. The
   * stream's events wait until the returned promise settles.
   */
  resync?: () => Promise<unknown> | void;
}

export interface ChatConnectionState {
  status: ConnectionStatus;
  /**
   * The name the Lens Agents sign-in gave this connection, null when it gave
   * none, and undefined until the first `welcome` says which. Until then nobody
   * knows whose messages are whose.
   */
  you: string | null | undefined;
  /** The threads that are working or waiting. A thread that is not listed is idle. */
  turns: Readonly<Record<string, 'queued' | 'running'>>;
  /** Our messages whose stored copy has not arrived, sending or failed, oldest first. */
  pending: readonly TranscriptMessage[];
}

interface InboundFrame {
  type: string;
  seq?: number;
  re?: string | null;
  payload?: unknown;
}

/**
 * One of our messages, from the send until its stored copy is applied. An `ack` only
 * stops the resending: the stored copy can still be held behind a reload, and the row
 * stays on screen until then.
 */
interface OutboxEntry {
  row: TranscriptMessage;
  attachmentIds: string[];
  acked?: boolean;
  /** Set while a `rate_limited` answer makes the message wait. */
  retryTimer?: ReturnType<typeof setTimeout>;
}

type Timer = ReturnType<typeof setTimeout> | undefined;

/**
 * The one chat socket of a browser tab.
 *
 * It keeps the stream cursor and resumes from it after every drop. It keeps each of our
 * messages until the runtime confirms it, and sends it again with the same id after each
 * `welcome`, which the runtime answers as a duplicate when it already has it.
 * See docs/websocket-protocol.md.
 */
export class ChatConnection {
  private readonly url: () => string;
  private ws: WebSocket | null = null;
  /** True between this socket's `welcome` and its close. Nothing but `hello` is sent before. */
  private ready = false;
  private running = false;
  private cursor: { streamId: string; seq: number } | null = null;
  private attempts = 0;
  private reconnectTimer: Timer;
  private stableTimer: Timer;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: Timer;
  private awaitingPong: string | null = null;
  private waitForVisible: (() => void) | null = null;
  private requestSeq = 0;
  /** Send requests on this socket, by request id, to the message each one carries. */
  private readonly sends = new Map<string, string>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private holds = 0;
  private held: InboundFrame[] = [];
  private readonly listeners = new Set<ChatListener>();
  private readonly subscribers = new Set<() => void>();
  private state: ChatConnectionState = { status: 'disconnected', you: undefined, turns: {}, pending: [] };

  constructor(url: () => string) {
    this.url = url;
  }

  start = (): void => {
    if (this.running) return;
    this.running = true;
    this.connect();
  };

  stop = (): void => {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.stopWaitingForVisible();
    this.abandon();
    if (this.state.status !== 'update-required') this.publish({ status: 'disconnected' });
  };

  /** For `useSyncExternalStore`. */
  subscribe = (onChange: () => void): (() => void) => {
    this.subscribers.add(onChange);
    return () => this.subscribers.delete(onChange);
  };

  getState = (): ChatConnectionState => this.state;

  listen = (listener: ChatListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Hold the stream's events while `work` runs. A reload that finishes after an event
   * arrived would otherwise overwrite it with the older copy it read.
   */
  holdEvents = <T>(work: Promise<T>): Promise<T> => {
    this.holds++;
    return work.finally(() => {
      this.holds--;
      // A macrotask, so the reload's result is in the cache before the held events apply.
      if (this.holds === 0) setTimeout(this.flush, 0);
    });
  };

  /**
   * Send a message and draw it at once. The returned id is the message's, the same id
   * the runtime stores it under.
   */
  send = (threadId: string, content: string, attachments: Attachment[]): string => {
    const row: TranscriptMessage = {
      id: uuidV4(),
      threadId,
      role: 'USER',
      content,
      triggeredBy: 'USER_INPUT',
      toolCalls: null,
      blocks: null,
      isCompacted: false,
      createdAt: new Date().toISOString(),
      attachments,
      senderName: this.state.you ?? null,
      delivery: 'sending',
    };
    const entry: OutboxEntry = { row, attachmentIds: attachments.map((a) => a.id) };
    this.outbox.set(row.id, entry);
    if (content.length > MAX_MESSAGE_CHARS) {
      entry.row = {
        ...row,
        delivery: 'failed',
        deliveryError: `A message can be up to ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`,
      };
    } else if (this.ready) {
      this.transmit(entry);
    }
    this.publishPending();
    return row.id;
  };

  /** Send a failed message again, as a new message at the end of the thread. */
  retry = (messageId: string): void => {
    const entry = this.outbox.get(messageId);
    if (entry?.row.delivery !== 'failed') return;
    this.outbox.delete(messageId);
    this.send(entry.row.threadId, entry.row.content, entry.row.attachments ?? []);
  };

  /** Forget a failed message. */
  discard = (messageId: string): void => {
    if (!this.outbox.delete(messageId)) return;
    this.publishPending();
  };

  /** Stop the thread's running turn and drop its queued messages, whoever sent them. */
  cancel = (threadId: string): boolean => this.request('cancel', { threadId });

  voiceStart = (options: VoiceStartOptions = {}): boolean => this.request('voice_start', options);

  voiceStop = (): void => {
    this.request('voice_stop', {});
  };

  dictationStart = (): boolean => this.request('dictation_start', {});

  /** `commit` transcribes the recording; `false` discards it. */
  dictationStop = (commit: boolean): void => {
    this.request('dictation_stop', { commit });
  };

  /**
   * One frame of the microphone. Dropped while the socket is not ready: the client
   * streams continuously, silence included, so a dropped frame is only a gap.
   */
  sendAudio = (frame: ArrayBuffer): void => {
    if (this.ready) this.ws?.send(frame);
  };

  private connect(): void {
    if (!this.running || this.ws || this.state.status === 'update-required') return;
    const ws = new WebSocket(this.url());
    // Speech arrives as binary frames. A Blob needs an asynchronous read, which would
    // let audio overtake the `voice_clear` that cancels it.
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opened();
    ws.onmessage = (event) => this.received(event.data);
    ws.onclose = (event) => this.closed(event.code);
    this.ws = ws;
    this.publish({ status: 'connecting' });
  }

  private opened(): void {
    this.write({
      type: 'hello',
      id: this.nextId('hello'),
      payload: {
        protocol: PROTOCOL_VERSION,
        client: { name: CLIENT_NAME },
        ...(this.cursor ? { resume: this.cursor } : {}),
      },
    });
    this.stableTimer = setTimeout(() => {
      this.attempts = 0;
    }, STABLE_CONNECTION_MS);
  }

  private received(data: unknown): void {
    if (typeof data !== 'string') {
      this.emit('voiceAudio', data as ArrayBuffer);
      return;
    }
    const frame = JSON.parse(data) as InboundFrame;
    if (typeof frame.seq === 'number') {
      this.sequenced(frame as InboundFrame & { seq: number });
      return;
    }
    switch (frame.type) {
      case 'welcome':
        this.welcomed(frame.payload as WelcomePayload);
        return;
      case 'ack':
        this.acked(frame.re ?? null, frame.payload as { duplicate?: boolean });
        return;
      case 'nack':
        this.nacked(frame.re ?? null, frame.payload as NackPayload);
        return;
      case 'pong':
        if (frame.re !== this.awaitingPong) return;
        this.awaitingPong = null;
        clearTimeout(this.pongTimer);
        return;
      default:
        this.direct(frame);
    }
  }

  private welcomed(welcome: WelcomePayload): void {
    this.ready = true;
    // On a resume the cursor stays where it is: the events after it follow this frame.
    if (!welcome.resumed) this.cursor = { streamId: welcome.streamId, seq: welcome.seq };
    const turns = Object.fromEntries(welcome.snapshot.turns.map((t) => [t.threadId, t.state]));
    this.publish({ status: 'connected', you: welcome.you.name, turns });
    if (welcome.snapshot.computer) this.emit('computer', welcome.snapshot.computer as unknown as ComputerStatus);
    if (!welcome.resumed) {
      // Events held from the socket that died are older than the snapshot and the
      // reload that follow. Applied after them, a `turn running` whose `idle` was
      // lost would leave the conversation working for good.
      this.held = [];
      this.resync();
    }
    for (const entry of this.outbox.values()) {
      if (entry.row.delivery === 'sending' && !entry.acked && !entry.retryTimer) this.transmit(entry);
    }
    this.pingTimer = setInterval(this.ping, CLIENT_PING_INTERVAL_MS);
  }

  private resync(): void {
    const work = [...this.listeners].map((listener) => listener.resync?.());
    // A stored message whose copy was lost with the replay is in the reloaded history.
    void this.holdEvents(Promise.allSettled(work).then(() => this.dropStored()));
  }

  private dropStored(): void {
    for (const [id, entry] of this.outbox) if (entry.acked) this.outbox.delete(id);
    this.publishPending();
  }

  private sequenced(frame: InboundFrame & { seq: number }): void {
    // Every event follows `welcome`, which set the cursor.
    const cursor = this.cursor!;
    // A missed event means this view is out of date. The runtime replays from the
    // cursor, which still names the last event applied.
    if (frame.seq !== cursor.seq + 1) {
      this.abandon();
      this.publish({ status: 'disconnected' });
      this.scheduleReconnect();
      return;
    }
    this.cursor = { ...cursor, seq: frame.seq };
    // A turn's state is the latest word on it, with no history to race a reload,
    // so the working indicator and STOP never wait for a fetch.
    if (frame.type === 'turn') this.applyTurn(frame.payload as TurnEvent);
    else if (this.holds > 0 || this.held.length > 0) this.held.push(frame);
    else this.dispatch(frame);
  }

  private flush = (): void => {
    while (this.holds === 0 && this.held.length > 0) this.dispatch(this.held.shift()!);
  };

  private dispatch(frame: InboundFrame): void {
    switch (frame.type) {
      case 'message': {
        const message = frame.payload as ConversationMessage;
        this.emit('message', message);
        if (this.outbox.delete(message.id)) this.publishPending();
        return;
      }
      case 'thread':
        this.emit('thread', frame.payload as ThreadEvent);
        return;
      case 'context':
        this.emit('context', frame.payload as ContextUsage);
        return;
      case 'compaction':
        this.emit('compaction', frame.payload as CompactionEvent);
        return;
      case 'computer':
        this.emit('computer', frame.payload as ComputerStatus);
        return;
      case 'update':
        this.emit('update', frame.payload as UpdateEvent);
        return;
    }
  }

  private applyTurn(event: TurnEvent): void {
    const turns = { ...this.state.turns };
    if (event.state === 'idle') delete turns[event.threadId];
    else turns[event.threadId] = event.state;
    this.publish({ turns });
    this.emit('turn', event);
  }

  private acked(re: string | null, ack: { duplicate?: boolean }): void {
    const messageId = re === null ? undefined : this.sends.get(re);
    if (!messageId) return;
    this.sends.delete(re!);
    const entry = this.outbox.get(messageId);
    if (!entry) return;
    entry.acked = true;
    clearTimeout(entry.retryTimer);
    // Stored before, so its copy is already on screen or in the reload that
    // dropped the other acked entries — and none follows to remove this one.
    if (ack.duplicate && this.holds === 0) {
      this.outbox.delete(messageId);
      this.publishPending();
    }
  }

  private nacked(re: string | null, nack: NackPayload): void {
    if (nack.code === 'protocol_unsupported') {
      this.requireUpdate();
      return;
    }
    const messageId = re === null ? undefined : this.sends.get(re);
    if (!messageId) return;
    this.sends.delete(re!);
    const entry = this.outbox.get(messageId);
    if (!entry) return;
    if (nack.code === 'rate_limited') {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        if (this.ready) this.transmit(entry);
      }, nack.retryAfterMs ?? BACKOFF_BASE_MS);
      return;
    }
    entry.row = { ...entry.row, delivery: 'failed', deliveryError: nackText(nack) };
    this.publishPending();
  }

  private direct(frame: InboundFrame): void {
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    switch (frame.type) {
      case 'voice_hello': {
        const format = readFormat(payload.format);
        if (format) this.emit('voice', { type: 'hello', format });
        return;
      }
      case 'voice_state':
        if (payload.state !== 'live' && payload.state !== 'ended') return;
        this.emit('voice', { type: 'state', state: payload.state, desktop: payload.desktop === true });
        return;
      case 'voice_clear':
        this.emit('voice', { type: 'clear' });
        return;
      case 'voice_error':
        // A refusal with no text still reaches the person as words.
        this.emit('voice', { type: 'error', error: textOr(payload.error, 'The voice chat could not run.') });
        return;
      case 'dictation_hello': {
        const format = readFormat(payload.format);
        if (format) this.emit('dictation', { type: 'hello', format });
        return;
      }
      case 'dictation_delta':
      case 'dictation_result':
        if (typeof payload.text !== 'string') return;
        this.emit('dictation', {
          type: frame.type === 'dictation_delta' ? 'delta' : 'result',
          text: payload.text,
        });
        return;
      case 'dictation_error':
        this.emit('dictation', {
          type: 'error',
          error: textOr(payload.error, 'The dictation could not be transcribed.'),
        });
        return;
    }
  }

  private ping = (): void => {
    const id = this.nextId('ping');
    this.awaitingPong = id;
    this.write({ type: 'ping', id });
    // A browser cannot see protocol pings, and a sleeping laptop keeps a dead socket open.
    this.pongTimer = setTimeout(() => {
      this.abandon();
      this.publish({ status: 'disconnected' });
      this.scheduleReconnect();
    }, CLIENT_PONG_DEADLINE_MS);
  };

  private closed(code: number): void {
    this.detach();
    if (code === CLOSE_CODES.protocolUnsupported) {
      this.requireUpdate();
      return;
    }
    this.publish({ status: 'disconnected' });
    // A newer connection took this one's place. A hidden tab waits until it is looked at,
    // so two tabs do not keep replacing each other.
    if (code === CLOSE_CODES.replaced && document.visibilityState === 'hidden') {
      this.reconnectWhenVisible();
      return;
    }
    this.scheduleReconnect();
  }

  private requireUpdate(): void {
    clearTimeout(this.reconnectTimer);
    this.abandon();
    this.publish({ status: 'update-required' });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    // Jittered, so every tab does not come back at the same moment after a restart.
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts) * (0.5 + Math.random() / 2);
    this.attempts++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private reconnectWhenVisible(): void {
    const onChange = () => {
      if (document.visibilityState !== 'visible') return;
      this.stopWaitingForVisible();
      this.connect();
    };
    this.waitForVisible = onChange;
    document.addEventListener('visibilitychange', onChange);
  }

  private stopWaitingForVisible(): void {
    if (!this.waitForVisible) return;
    document.removeEventListener('visibilitychange', this.waitForVisible);
    this.waitForVisible = null;
  }

  /** Close the socket without hearing about it. */
  private abandon(): void {
    const ws = this.ws;
    this.detach();
    ws?.close(1000);
  }

  /** Forget the socket and everything that belonged to it. Answers arrive only on the socket that asked. */
  private detach(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
    }
    this.ws = null;
    this.ready = false;
    this.awaitingPong = null;
    this.sends.clear();
    clearTimeout(this.stableTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.pingTimer);
  }

  private transmit(entry: OutboxEntry): void {
    const id = this.nextId('send');
    this.sends.set(id, entry.row.id);
    this.write({
      type: 'send',
      id,
      payload: {
        message: {
          id: entry.row.id,
          threadId: entry.row.threadId,
          content: entry.row.content,
          attachmentIds: entry.attachmentIds,
        },
      },
    });
  }

  private request(type: string, payload: object): boolean {
    if (!this.ready) return false;
    this.write({ type, id: this.nextId(type), payload });
    return true;
  }

  private write(frame: object): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private nextId(prefix: string): string {
    this.requestSeq++;
    return `${prefix}-${this.requestSeq}`;
  }

  private emit<K extends Exclude<keyof ChatListener, 'resync'>>(
    name: K,
    value: Parameters<NonNullable<ChatListener[K]>>[0],
  ): void {
    for (const listener of this.listeners) listener[name]?.(value as never);
  }

  private publish(patch: Partial<ChatConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const onChange of this.subscribers) onChange();
  }

  private publishPending(): void {
    this.publish({ pending: [...this.outbox.values()].map((entry) => entry.row) });
  }
}

function nackText(nack: NackPayload): string {
  switch (nack.code) {
    case 'unknown_thread':
      return 'This conversation no longer exists.';
    case 'unavailable':
      return 'The agent is still starting.';
    default:
      return 'The message could not be sent.';
  }
}

function readFormat(value: unknown): VoiceFormat | null {
  const format = value as Partial<VoiceFormat> | undefined;
  // The caller builds its audio around this format, so a half-stated one is dropped.
  if (
    typeof format?.encoding !== 'string' ||
    typeof format.sampleRate !== 'number' ||
    typeof format.channels !== 'number'
  ) {
    return null;
  }
  return { encoding: format.encoding, sampleRate: format.sampleRate, channels: format.channels };
}

function textOr(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim()) || fallback;
}

/**
 * A version-4 uuid. `crypto.randomUUID` exists only in a secure context, and the web UI
 * is also served over plain http on a local network.
 */
function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
