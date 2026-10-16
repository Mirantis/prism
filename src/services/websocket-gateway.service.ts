/**
 * WebSocket Gateway Service
 *
 * The chat socket, `/api/ws`: protocol version 2, which
 * `docs/websocket-protocol.md` describes for client authors and
 * `protocol/chat-protocol.ts` pins down.
 *
 * A client says `hello` and is answered `welcome`. From then on it reads one
 * numbered stream of events — every message in every conversation, the person's
 * own included, and what each conversation is doing — and a client that was away
 * names where it stopped and is sent the rest. What it sends is a request with an
 * id, answered `ack` or `nack` under that id. A message is confirmed once it is
 * stored, so a client resends anything unconfirmed without fear of a duplicate.
 *
 * The gateway owns connections and nothing else. The stream is
 * `eventStreamService`'s, and what happens to a message is
 * `inboundMessageService`'s.
 */

import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../logger';
import { config } from '../config';
import { isAllowedOrigin } from '../lib/origin-guard';
import { TokenBucket } from '../lib/token-bucket';
import { trackEvent } from '../lib/telemetry';
import { serveUpgrades } from './websocket-upgrades';
import {
  CLOSE_CODES,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  clientFrame,
  helloFrame,
  type ClientFrame,
  type DirectFrame,
  type HelloFrame,
  type NackCode,
} from '../protocol/chat-protocol';
import { eventStreamService, type StreamEntry } from './event-stream.service';
import { inboundMessageService, InboundMessageError } from './inbound-message.service';
import { conversationService, type ThreadCreated } from './conversation.service';
import { threadTitleService, type ThreadTitleChange } from './thread-title.service';
import { contextUsageService, type ContextUsageEvent } from './context-usage.service';
import { compactionService, type CompactionEvent } from './compaction.service';
import { updateService, type UpdateEvent } from './update/update.service';
import { computerService } from './computer/computer.service';
import { computerHelpService } from './computer/computer-help.service';
import {
  voiceChatService,
  type VoiceChatEndStatus,
  type VoiceChatSignal,
  type VoiceListeningMode,
} from './voice/voice-chat.service';
import { VOICE_AUDIO_FORMAT } from './voice/socket-audio';
import { DictationSession } from './voice/dictation-session';
import { isRealtimeConfigured } from './meeting/openai-endpoint';
import { MEETING_SAMPLE_RATE } from './meeting/resampler';

/** Where the Web UI's chat and its voice connect. The screen has its own path; see
 * `services/computer/computer-endpoint.ts`. */
const CHAT_PATH = '/api/ws';

/**
 * How many sockets the agent keeps at once. A newer one replaces the oldest
 * rather than being refused: the oldest is usually a phone's socket that died
 * behind a locked screen and has not been noticed yet, and refusing the phone's
 * fresh one would lock its owner out until the heartbeat caught up.
 */
export const MAX_CONNECTIONS = 16;

/**
 * How much may sit unsent on one socket before the gateway stops trying. A
 * client that far behind is closed and resumes from the replay window, which
 * costs the server nothing, instead of growing a queue in its memory.
 */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** The most code points kept from each ingress header value. */
const MAX_SENDER_CHARS = 128;

/**
 * The headers the Lens Agents ingress names the signed-in caller in. It strips any
 * copy a client sent, and omits the id and the display name when it has none.
 */
const FORWARDED_USER_HEADER = 'x-forwarded-user';
const FORWARDED_USER_ID_HEADER = 'x-forwarded-user-id';
const FORWARDED_USER_DISPLAY_NAME_HEADER = 'x-forwarded-user-display-name';

interface ChatSocket extends WebSocket {
  isAlive?: boolean;
  /** Set once the socket said `hello` and was answered. Nothing else is read before. */
  ready?: boolean;
  /** Set while a `hello` is being answered, so a second one cannot start another. */
  greeting?: boolean;
  /** Who the ingress says is on this connection. Display and attribution only. */
  sender?: { id: string; name: string } | null;
  helloTimer?: NodeJS.Timeout;
  unsubscribe?: () => void;
  /** A send is the expensive request; everything else is cheap. */
  sends?: TokenBucket;
  requests?: TokenBucket;
}

/** One header value, or undefined when the header is absent. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A header value made safe to show: no angle brackets, colons or control characters, and capped. */
function cleanSender(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[<>:\x00-\x1f\x7f]/g, '').trim();
  return Array.from(cleaned).slice(0, MAX_SENDER_CHARS).join('') || undefined;
}

/** The display name header, which the ingress always percent-encodes. */
function decodedDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return cleanSender(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

/**
 * Who is on this connection, from the ingress's headers. The id is the signed-in
 * person's user id. The name is their display name. Each falls back to
 * `x-forwarded-user`, the person's email or user id, when the ingress omits it.
 *
 * **Attribution and display only.** The ingress writes the headers for a private
 * port after it signed the caller in, and strips any copy a client sent. A
 * runtime reached some other way — local development, or bound wider on purpose
 * — would read whatever a client wrote, so nothing is ever decided on them.
 */
function senderOf(req: IncomingMessage): { id: string; name: string } | null {
  const legacy = cleanSender(headerOf(req, FORWARDED_USER_HEADER));
  const id = cleanSender(headerOf(req, FORWARDED_USER_ID_HEADER)) ?? legacy;
  if (!id) return null;
  const name = decodedDisplayName(headerOf(req, FORWARDED_USER_DISPLAY_NAME_HEADER)) ?? legacy ?? id;
  return { id, name };
}

/** A payload field, when the client sent it as a string with something in it. */
function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The rectangle the client will show the agent's screen in, in its own device pixels.
 *
 * Read off the start request rather than sent later, so the desktop comes up at the size
 * it will be watched at instead of laying itself out twice. A client that leaves it off
 * takes the default and can resize afterwards.
 */
function screenOf(payload: Record<string, unknown>): { width: number; height: number } | undefined {
  const screen = payload['screen'];
  if (typeof screen !== 'object' || screen === null) return undefined;
  const { width, height } = screen as Record<string, unknown>;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/**
 * Which listening mode the client asked for: the mode, `undefined` when it said nothing,
 * or `null` when it asked for something this does not serve.
 *
 * `null` is refused rather than defaulted, which is the opposite of how the rest of this
 * payload is read. The modes do not differ only in how much the agent says: in `open` it
 * answers every utterance, and an answer can be a tool call the runtime executes for
 * real. So a client that means `addressed` and misspells it would get an agent that talks
 * over a room and acts on what it hears there, with nothing in the frames to say why. A
 * client that sent the field asked for something specific, and it is cheaper to be told
 * than to find out from the room.
 */
function listeningMode(payload: Record<string, unknown>): VoiceListeningMode | undefined | null {
  const value = payload['mode'];
  // Said nothing, which takes the default. `null` is something the client sent, so it
  // goes to the refusal below with every other value this does not serve.
  if (value === undefined) return undefined;
  return value === 'open' || value === 'addressed' ? value : null;
}

/**
 * How much of the agent's speech may sit unsent on a socket before frames are dropped.
 *
 * Two seconds at the one rate the protocol carries. A client that cannot keep up is
 * behind on the conversation, not merely behind on the audio: what is queued is already
 * stale by the time it plays, and the queue grows for as long as the call runs. Dropping
 * keeps the delay bounded, which is what a media transport would have done here.
 */
const MAX_BUFFERED_AUDIO_BYTES = VOICE_AUDIO_FORMAT.sampleRate * 2 * 2;

/** The request id of a frame that failed to parse, when it had a readable one. */
function requestIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

// ============================================================================
// WebSocket Gateway Service
// ============================================================================

class WebSocketGatewayService {
  private wss: WebSocketServer | null = null;
  /** Every socket, oldest first, whether or not it has said `hello` yet. */
  private connections: ChatSocket[] = [];
  // The socket whose request holds the voice session, from the moment the gateway
  // decides to open one until it is over — so closing it ends the call. Taken
  // before the service is asked, because the service reports `live` from inside
  // that call and the client's first frames are dropped while this is unset. Every
  // other request is refused while it is taken, which is also what keeps it
  // truthful: a request that was refused never becomes this socket, and so cannot
  // end somebody else's call by going away.
  private voiceSocket: ChatSocket | null = null;
  // Whether the client of the request being answered gave up while it waited, and
  // which way. A stop or a disconnect that lands before the answer has no session
  // to end yet, so it is honoured once the start returns. One record, because
  // `voiceSocket` above refuses a second request while this one is outstanding.
  private voiceStarting: {
    ws: ChatSocket;
    cancelled: VoiceChatEndStatus | null;
  } | null = null;
  // Whether a computer-state event is being built, and whether the desktop changed
  // again while it was. One build at a time keeps a burst of changes to one database
  // read, and the flag makes the last event published the newest state.
  private computerPublishing = false;
  private computerChangedAgain = false;
  // The dictation each socket is recording, from `dictation_start` until it ends. One per
  // socket and any number per runtime, since a dictation never takes the agent's voice.
  private dictations: Map<ChatSocket, DictationSession> = new Map();

  constructor() {
    // Everything below is owned by a channel-agnostic service; the gateway only
    // puts it on the stream.
    threadTitleService.events.on('change', ({ threadId, title }: ThreadTitleChange) => {
      eventStreamService.publish({ type: 'thread', payload: { threadId, title } });
    });

    // A conversation started on one device appears in every other device's list.
    conversationService.events.on('thread', ({ threadId, title, createdAt }: ThreadCreated) => {
      eventStreamService.publish({
        type: 'thread',
        payload: { threadId, title, createdAt: createdAt.toISOString() },
      });
    });

    contextUsageService.events.on('usage', ({ userId: _userId, ...payload }: ContextUsageEvent) => {
      eventStreamService.publish({ type: 'context', payload });
    });

    compactionService.events.on('compaction', ({ userId: _userId, ...payload }: CompactionEvent) => {
      eventStreamService.publish({ type: 'compaction', payload });
    });

    updateService.events.on('update', (payload: UpdateEvent) => {
      eventStreamService.publish({ type: 'update', payload: { ...payload } });
    });

    // The state of the computers: which threads wait for them, who holds them, which
    // are connected, and the open help requests. Every computer's access gate feeds
    // this emitter, so every caller that queues for one reaches the clients.
    computerService.on('change', () => {
      void this.publishComputer();
    });
  }

  /**
   * Publish the state of the desktop, coalescing a burst of changes into one event.
   *
   * The payload needs a database read, and one call on the access gate emits twice —
   * a turn taking a free desktop is queued and then holds it — so the first build
   * waits for the current tick to finish, and a change that lands during a build
   * schedules exactly one more.
   */
  private async publishComputer(): Promise<void> {
    if (this.computerPublishing) {
      this.computerChangedAgain = true;
      return;
    }
    this.computerPublishing = true;
    try {
      let again = true;
      while (again) {
        // Let the rest of this tick emit before the state is read, so changes made
        // together are read together.
        await Promise.resolve();
        this.computerChangedAgain = false;
        const payload = await this.computerState();
        if (payload) eventStreamService.publish({ type: 'computer', payload });
        again = this.computerChangedAgain;
      }
    } finally {
      this.computerPublishing = false;
      this.computerChangedAgain = false;
    }
  }

  /**
   * The runtime's own desktop as `GET /computers/local` reads it, every help request,
   * and the list of computers; or null while no agent is loaded. A failed build is
   * logged and answered with null: the next change corrects every client.
   */
  private async computerState(): Promise<Record<string, unknown> | null> {
    const agentId = config.agentId;
    if (!agentId) return null;
    try {
      return {
        ...computerService.local.status(),
        help: await computerHelpService.list(agentId, config.ownerUserId),
        computers: computerService.summaries(),
      };
    } catch (error) {
      logger.warn({ err: error }, '[Computer] Could not read the computer state');
      return null;
    }
  }

  /**
   * Initialize WebSocket server
   */
  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

    // The handshake is checked here, ahead of `handleUpgrade` — the shape ws
    // supports, rather than `verifyClient`.
    serveUpgrades(server, CHAT_PATH, (req, socket, head) => {
      // A WebSocket handshake is exempt from the same-origin policy, so the
      // same rules the HTTP routes get are applied to it here.
      if (
        !isAllowedOrigin(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])
      ) {
        logger.warn(
          '[OriginGuard] refused a WebSocket handshake (origin %s, host %s, x-forwarded-host %s)',
          req.headers.origin,
          req.headers.host,
          req.headers['x-forwarded-host'],
        );
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: ChatSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Protocol-level heartbeat, which terminates a socket that stopped answering.
    const interval = setInterval(() => {
      this.wss?.clients.forEach((ws: ChatSocket) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(interval);
    });

    logger.info('WebSocket gateway initialized on /api/ws');
  }

  /**
   * A new socket. It may say nothing but `hello` until it is answered, and has
   * `HELLO_TIMEOUT_MS` to say it.
   */
  private handleConnection(ws: ChatSocket, req: IncomingMessage): void {
    ws.isAlive = true;
    ws.sender = senderOf(req);
    ws.sends = new TokenBucket(10, 20);
    ws.requests = new TokenBucket(50, 100);

    while (this.connections.length >= MAX_CONNECTIONS) {
      const oldest = this.connections.shift();
      oldest?.close(CLOSE_CODES.replaced, 'replaced by a newer connection');
    }
    this.connections.push(ws);

    ws.helloTimer = setTimeout(() => {
      if (!ws.ready) ws.close(CLOSE_CODES.helloTimeout, 'no hello');
    }, HELLO_TIMEOUT_MS);

    logger.info('WebSocket connected (%d connections)', this.connections.length);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      void this.handleFrame(ws, data, isBinary);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error: %s', error instanceof Error ? error.message : String(error));
    });

    ws.on('close', (code) => {
      this.removeConnection(ws);
      // The client that was talking is gone, so the call is over: this socket is the
      // only way it could stop the session or hear that it ended.
      if (this.voiceStarting?.ws === ws) {
        // Still opening. `handleVoiceStart` ends it once the start returns, since only it
        // knows whether there is a session to end yet.
        this.voiceStarting.cancelled = 'disconnected';
      } else if (this.voiceSocket === ws) {
        this.voiceSocket = null;
        // Not awaited: a close handler is synchronous. Reported rather than dropped —
        // this is the path that frees the runtime's one voice, and a failure here is a
        // runtime that cannot take another call.
        voiceChatService.stop('the client disconnected', 'disconnected').catch((err: unknown) => {
          logger.error({ err }, 'Failed to end the voice chat of a disconnected client');
        });
      }
      this.dictations.get(ws)?.cancel('disconnected');
      logger.info('WebSocket disconnected - code: %d', code);
    });
  }

  private async handleFrame(ws: ChatSocket, data: Buffer, isBinary: boolean): Promise<void> {
    try {
      // Audio first, and never parsed. A binary frame is one frame of the
      // client's microphone; running it through `JSON.parse` would fail on
      // every one of them fifty times a second and answer each with an error.
      if (isBinary) {
        if (ws.ready) this.handleBinary(ws, data);
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        this.nack(ws, null, 'invalid', 'A frame must be JSON.');
        return;
      }

      if (!ws.ready) {
        // The answer to `hello` reads the database, and a client may send again
        // before it arrives. That frame is refused, not taken as a second `hello`:
        // two would subscribe the socket twice.
        if (ws.greeting) {
          this.nack(ws, requestIdOf(raw), 'invalid', 'Wait for welcome before sending anything else.');
          return;
        }
        await this.handleHello(ws, raw);
        return;
      }

      const parsed = clientFrame.safeParse(raw);
      if (!parsed.success) {
        this.nack(ws, requestIdOf(raw), 'invalid', parsed.error.issues[0]?.message ?? 'Unreadable request.');
        return;
      }
      const frame = parsed.data;

      const wait = (frame.type === 'send' ? ws.sends : ws.requests)?.take() ?? 0;
      if (wait > 0) {
        this.sendTo(ws, {
          type: 'nack',
          re: frame.id,
          payload: { code: 'rate_limited', message: 'Too many requests.', retryAfterMs: wait },
        });
        return;
      }

      await this.dispatch(ws, frame);
    } catch (error: unknown) {
      logger.error('WebSocket frame error: %s', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Answer `hello`: the version check, the resume and the `welcome`.
   *
   * The snapshot is read first, because the desktop's state needs the database.
   * Everything after it — the `welcome`, the replay and joining the live stream —
   * runs without an await, so no event can fall between the replay and the first
   * live one. An event published while the snapshot was read is in the replay, or
   * newer than a `welcome` that did not resume; either way the client applies it
   * after the snapshot, and every event is an upsert or a full state.
   */
  private async handleHello(ws: ChatSocket, raw: unknown): Promise<void> {
    const parsed = helloFrame.safeParse(raw);
    if (!parsed.success || parsed.data.payload.protocol !== PROTOCOL_VERSION) {
      this.nack(
        ws,
        requestIdOf(raw),
        'protocol_unsupported',
        `This runtime speaks chat protocol ${PROTOCOL_VERSION}. Update the app to connect.`,
      );
      ws.close(CLOSE_CODES.protocolUnsupported, 'protocol unsupported');
      return;
    }
    const hello: HelloFrame = parsed.data;
    clearTimeout(ws.helloTimer);
    ws.greeting = true;

    const computer = await this.computerState();
    if (ws.readyState !== WebSocket.OPEN) return;

    const resume = hello.payload.resume;
    const replay = resume ? eventStreamService.replayAfter(resume.streamId, resume.seq) : null;

    this.sendTo(ws, {
      type: 'welcome',
      payload: {
        protocol: PROTOCOL_VERSION,
        streamId: eventStreamService.streamId,
        seq: eventStreamService.seq,
        resumed: replay !== null,
        you: { id: ws.sender?.id ?? null, name: ws.sender?.name ?? null },
        snapshot: { turns: inboundMessageService.turns(), computer },
      },
    });
    for (const entry of replay ?? []) this.sendEntry(ws, entry);
    ws.unsubscribe = eventStreamService.subscribe((entry) => this.sendEntry(ws, entry));
    ws.ready = true;
    ws.greeting = false;

    if (resume) {
      trackEvent('chat socket resumed', config.ownerUserId, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'socket.outcome': replay !== null ? 'resumed' : 'resync',
        'socket.replayed': String(replay?.length ?? 0),
        'socket.client': hello.payload.client.name,
      });
    }
  }

  private async dispatch(ws: ChatSocket, frame: ClientFrame): Promise<void> {
    switch (frame.type) {
      case 'ping':
        this.sendTo(ws, { type: 'pong', re: frame.id });
        return;

      case 'send':
        await this.handleSend(ws, frame.id, frame.payload.message);
        return;

      case 'cancel':
        try {
          await inboundMessageService.cancel(frame.payload.threadId);
          this.sendTo(ws, { type: 'ack', re: frame.id, payload: {} });
        } catch (error) {
          if (!(error instanceof InboundMessageError)) throw error;
          this.nack(ws, frame.id, error.code, error.message);
        }
        return;

      // Voice control. The audio itself rides this socket too, as binary frames
      // handled before the JSON path — see `handleBinary`.
      case 'voice_start':
        await this.handleVoiceStart(ws, config.ownerUserId, frame.payload);
        return;

      case 'voice_stop':
        await this.handleVoiceStop(ws);
        return;

      case 'dictation_start':
        await this.handleDictationStart(ws, config.ownerUserId);
        return;

      case 'dictation_stop':
        this.handleDictationStop(ws, frame.payload.commit);
        return;
    }
  }

  /** Store the message and confirm it, or say why not. */
  private async handleSend(
    ws: ChatSocket,
    re: string,
    message: { id: string; threadId: string; content: string; attachmentIds: string[] },
  ): Promise<void> {
    try {
      const accepted = await inboundMessageService.accept({
        ...message,
        sender: ws.sender ?? null,
      });
      this.sendTo(ws, {
        type: 'ack',
        re,
        payload: {
          messageId: accepted.message.id,
          seq: accepted.seq,
          queued: accepted.queued,
          duplicate: accepted.duplicate,
        },
      });
    } catch (error) {
      if (error instanceof InboundMessageError) {
        this.nack(ws, re, error.code, error.message);
        return;
      }
      logger.error('Could not accept message %s: %s', message.id, error instanceof Error ? error.message : String(error));
      this.nack(ws, re, 'failed', 'The message could not be saved. Try again.');
    }
  }

  private nack(ws: ChatSocket, re: string | null, code: NackCode, message: string): void {
    this.sendTo(ws, { type: 'nack', re, payload: { code, message } });
  }

  /**
   * One stream event, to one socket. A socket that far behind is closed rather
   * than queued to: it resumes from the replay window on reconnect.
   */
  private sendEntry(ws: ChatSocket, entry: StreamEntry): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      logger.warn('Closing a chat socket %d bytes behind', ws.bufferedAmount);
      ws.close(CLOSE_CODES.slowConsumer, 'too far behind');
      return;
    }
    ws.send(entry.frame);
  }

  /**
   * Open a voice chat for the client on this socket.
   *
   * The session belongs to the runtime rather than to the socket, so a request that
   * arrives while one is running is refused with a `voice_error` and leaves the call
   * alone. That refusal is the gateway's own rather than the voice service's, because the
   * socket is claimed before the service is asked — a second request allowed through would
   * take the running call's audio path with it.
   */
  private async handleVoiceStart(
    ws: ChatSocket,
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {

    const agentId = config.agentId;
    if (!agentId) {
      this.sendTo(ws, {
        type: 'voice_error',
        payload: { error: 'Agent runtime is still initializing; retry shortly' },
      });
      return;
    }

    const mode = listeningMode(payload);
    if (mode === null) {
      this.sendTo(ws, {
        type: 'voice_error',
        payload: { error: 'mode must be "open" or "addressed"' },
      });
      return;
    }

    // The socket's binary frames are one microphone, so they can feed one session.
    if (this.dictations.has(ws)) {
      this.sendTo(ws, {
        type: 'voice_error',
        payload: { error: 'A dictation is running on this connection. Finish it first.' },
      });
      return;
    }

    // Two different situations and two different things for the user to do: end the call
    // on this connection, or find whoever is on the other one.
    if (this.voiceSocket !== null) {
      this.sendTo(ws, {
        type: 'voice_error',
        payload: {
          error: this.voiceSocket === ws
            ? 'A voice chat is already running on this connection. Stop it first.'
            : 'There is already a voice chat running. End that one first.',
        },
      });
      return;
    }

    // Claimed before the service is asked, for two reasons. The service reports `live`
    // from inside `start()`, so the client can be sending audio while this is still
    // waiting, and `handleBinary` drops every frame from a socket that is not this one.
    // And it is what refuses a second request above, so only one start is ever
    // outstanding and one cancel record is enough for it.
    this.voiceSocket = ws;
    const starting: { ws: ChatSocket; cancelled: VoiceChatEndStatus | null } = {
      ws,
      cancelled: null,
    };
    this.voiceStarting = starting;
    let started = false;
    try {
      started = await voiceChatService.start({
        userId,
        agentId,
        threadId: stringField(payload, 'threadId'),
        mode,
        // A session with a computer opens a browser and a desktop for the agent, which
        // the client then watches on a transport of its own; see `computer-endpoint.ts`.
        computer: payload['computer'] === true,
        screen: screenOf(payload),
        surface: payload['computer'] === true ? 'computer' : 'chat',
        sampleRate: payload['computer'] === true ? MEETING_SAMPLE_RATE : undefined,
        greeting: stringField(payload, 'greeting'),
        signal: this.voiceSignal(ws),
      });
    } finally {
      if (this.voiceStarting === starting) this.voiceStarting = null;
      // The claim only survives a session this socket still holds. A refused start, a
      // client that gave up and a client that went away all give it back, or the field
      // would name a socket with no session and refuse every later call.
      const holds =
        started && starting.cancelled === null && ws.readyState === WebSocket.OPEN;
      if (!holds && this.voiceSocket === ws) this.voiceSocket = null;
    }

    if (!started) return;

    // Nobody is on the other end of the session that just opened, so end it here: it
    // would otherwise hold the agent's voice, and the runtime's one voice with it, until
    // something else ended the call.
    if (starting.cancelled !== null || ws.readyState !== WebSocket.OPEN) {
      await voiceChatService.stop(
        'the client left before the call started',
        // A socket already gone when the answer arrives dropped, whether or not its close
        // was the thing that cancelled this.
        starting.cancelled ?? 'disconnected',
      );
      return;
    }

    // The rate the session was built at, which a computer raises so the sound of its
    // desktop reaches the client unresampled. The client opens its microphone and its
    // playback at whatever this says.
    this.sendTo(ws, {
      type: 'voice_hello',
      payload: { format: { ...VOICE_AUDIO_FORMAT, sampleRate: voiceChatService.sampleRate } },
    });
  }

  /**
   * One frame of the client's microphone.
   *
   * Only from the socket that holds the session: another client's audio is not this
   * call's, and a frame arriving after a call ended is ordinary rather than an error, so
   * both are dropped in silence.
   */
  private handleBinary(ws: ChatSocket, data: Buffer): void {
    const dictation = this.dictations.get(ws);
    if (dictation) {
      dictation.pushAudio(data);
      return;
    }
    if (this.voiceSocket !== ws) return;
    voiceChatService.pushAudio(data);
  }

  /** End the session this socket opened. A stop from any other socket does nothing. */
  private async handleVoiceStop(ws: ChatSocket): Promise<void> {
    if (this.voiceStarting?.ws === ws) {
      // Still opening, so there is nothing to end yet. `handleVoiceStart` ends it once
      // the start returns, and reads this as the client having asked.
      this.voiceStarting.cancelled = 'completed';
      return;
    }
    if (this.voiceSocket !== ws) return;
    await voiceChatService.stop();
  }

  /** How the voice service answers the client that asked for the session. */
  private voiceSignal(ws: ChatSocket): VoiceChatSignal {
    // Whether the speech is being dropped right now, so a stalled client costs one log
    // line rather than fifty a second. Per signal, which is per session.
    let dropping = false;
    return {
      sendAudio: (pcm) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // A socket that is not draining takes the speech into memory instead, and the
        // agent talks for as long as the call lasts. Drop the frame rather than queue it:
        // what is already queued plays later than it was meant to, and adding to it makes
        // the lag permanent. The client hears a gap, which is what a lost packet sounds
        // like on any other transport.
        if (ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) {
          if (!dropping) {
            dropping = true;
            logger.warn(
              'Dropping voice audio: %d bytes are still unsent on the client socket',
              ws.bufferedAmount,
            );
          }
          return;
        }
        dropping = false;
        ws.send(pcm, { binary: true });
      },
      sendClear: () => this.sendTo(ws, { type: 'voice_clear' }),
      state: (state, info) => {
        if (state === 'ended' && this.voiceSocket === ws) this.voiceSocket = null;
        // `desktop` rides the live state: the client needs it before it decides whether
        // to offer the pointer and the keyboard on the screen it is about to show.
        this.sendTo(ws, { type: 'voice_state', payload: { state, ...(info ?? {}) } });
      },
      error: (error) => this.sendTo(ws, { type: 'voice_error', payload: { error } }),
    };
  }

  /**
   * Start a dictation for the client on this socket.
   *
   * Registered before the upstream answers, so the audio the client streams from the moment
   * the user presses is kept rather than dropped, and a stop that arrives while the session
   * connects is honoured once it is ready.
   */
  private async handleDictationStart(ws: ChatSocket, userId: string): Promise<void> {
    const refusal = this.dictations.has(ws)
      ? 'A dictation is already running on this connection.'
      : this.voiceSocket === ws || this.voiceStarting?.ws === ws
        ? 'A voice chat is running on this connection. End it first.'
        : !isRealtimeConfigured()
          ? 'Dictation needs a managed voice provider for this agent.'
          : null;
    if (refusal) {
      this.sendTo(ws, { type: 'dictation_error', payload: { error: refusal } });
      return;
    }

    const session: DictationSession = new DictationSession({
      userId,
      signal: {
        ready: () => this.sendTo(ws, {
          type: 'dictation_hello',
          payload: { format: VOICE_AUDIO_FORMAT },
        }),
        delta: (text) => this.sendTo(ws, { type: 'dictation_delta', payload: { text } }),
        result: (text) => this.sendTo(ws, { type: 'dictation_result', payload: { text } }),
        error: (error) => this.sendTo(ws, { type: 'dictation_error', payload: { error } }),
      },
      onEnd: () => {
        if (this.dictations.get(ws) === session) this.dictations.delete(ws);
      },
    });
    this.dictations.set(ws, session);
    await session.start();
  }

  /** Transcribe or drop this socket's dictation. A stop with nothing recording does nothing. */
  private handleDictationStop(ws: ChatSocket, commit: boolean | undefined): void {
    const session = this.dictations.get(ws);
    if (!session) return;
    if (commit === false) {
      session.cancel();
      return;
    }
    session.commit();
  }

  /** Send to one socket, which the client may have closed under us. */
  private sendTo(ws: ChatSocket, response: DirectFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(response));
  }
  /** Forget a socket, and stop sending it the stream. */
  private removeConnection(ws: ChatSocket): void {
    clearTimeout(ws.helloTimer);
    ws.unsubscribe?.();
    ws.unsubscribe = undefined;
    const index = this.connections.indexOf(ws);
    if (index > -1) this.connections.splice(index, 1);
  }

  /**
   * Close all connections (for shutdown)
   */
  closeAll(): void {
    this.wss?.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });
    for (const ws of this.connections) ws.unsubscribe?.();
    this.connections = [];
  }
}

// Export singleton instance
export const webSocketGatewayService = new WebSocketGatewayService();
