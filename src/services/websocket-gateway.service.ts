/**
 * WebSocket Gateway Service
 *
 * Provides real-time bidirectional communication for the personal agent.
 * Supports two message modes:
 * - followup: Queued messages, processed in order — or handed to the turn
 *   already running on the thread, so a message sent mid-response steers it
 *   (see `threadTurnService`) instead of waiting out the turn
 * - collect: Batched messages before processing
 */

import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'http';
import { logger } from '../logger';
import { config } from '../config';
import { isAllowedOrigin } from '../lib/origin-guard';
import { serveUpgrades } from './websocket-upgrades';

/** Where the Web UI's chat and its voice connect. The screen has its own path; see
 * `services/computer/computer-endpoint.ts`. */
const CHAT_PATH = '/api/ws';
import { conversationEngineService } from './conversation-engine.service';
import {
  conversationThreadActivityService,
  type ThreadActivityChange,
} from './conversation-thread-activity.service';
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

// ============================================================================
// Types
// ============================================================================

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userToken?: string;
  isAlive?: boolean;
  connectionId?: string;
}

interface WebSocketMessage {
  type:
    | 'chat'
    | 'ping'
    | 'pong'
    | 'subscribe'
    | 'cancel'
    | 'voice_start'
    | 'voice_stop'
    | 'dictation_start'
    | 'dictation_stop';
  mode?: 'followup' | 'collect';
  content?: string;
  threadId?: string;
  // Optional: the runtime substitutes `config.agentId` when omitted.
  agentId?: string;
  // Ids of files already uploaded via POST /agents/attachments.
  attachmentIds?: string[];
  // The connection that sent the message. Set by the gateway, never read from the wire.
  originConnectionId?: string;
  // The voice and dictation frames have their fields here. See docs/voice-chat.md and
  // docs/dictation.md.
  payload?: unknown;
}

/**
 * A chat message whose thread is already known — the only shape that can be
 * offered to a live turn.
 *
 * Steering asks about one specific thread, so the id has to come from the
 * client. Letting the engine resolve a missing one would mean
 * `getOrCreateLatestThread()`, which creates a thread row (and emits
 * `thread created`) for a message that steer-only mode then neither stores nor
 * answers — and in the first-message race can mint a duplicate empty thread.
 */
type ThreadedMessage = WebSocketMessage & { threadId: string };

interface WebSocketResponse {
  type:
    | 'chat'
    | 'pong'
    | 'error'
    | 'status'
    | 'thread'
    | 'context'
    | 'compaction'
    | 'update'
    | 'computer'
    | 'voice_state'
    | 'voice_error'
    | 'voice_hello'
    | 'voice_clear'
    | 'dictation_hello'
    | 'dictation_delta'
    | 'dictation_result'
    | 'dictation_error';
  threadId?: string;
  messageId?: string;
  content?: string;
  toolCalls?: unknown[];
  blocks?: unknown[];
  payload?: unknown;
}

/** Narrow to a message the gateway may offer to a live turn. */
function hasThread(message: WebSocketMessage): message is ThreadedMessage {
  return typeof message.threadId === 'string' && message.threadId.length > 0;
}

/** A frame's payload, as fields the caller can read one at a time. */
function payloadOf(message: WebSocketMessage): Record<string, unknown> {
  const payload = message.payload;
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
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

// ============================================================================
// WebSocket Gateway Service
// ============================================================================

class WebSocketGatewayService {
  private wss: WebSocketServer | null = null;
  private connections: Map<string, AuthenticatedWebSocket[]> = new Map();
  private messageQueues: Map<string, Array<{ message: WebSocketMessage; resolve: (response: WebSocketResponse) => void }>> = new Map();
  private processingUsers: Set<string> = new Set();
  // The user's in-flight chat turn: the AbortController a `cancel` message aborts,
  // which stops the LLM generation mid-turn (see invokeStream), and the thread it
  // runs on. Single-flight per user, so one entry per userId is sufficient.
  private activeRequests: Map<string, { controller: AbortController; threadId?: string }> =
    new Map();
  // The socket whose request holds the voice session, from the moment the gateway
  // decides to open one until it is over — so closing it ends the call. Taken
  // before the service is asked, because the service reports `live` from inside
  // that call and the client's first frames are dropped while this is unset. Every
  // other request is refused while it is taken, which is also what keeps it
  // truthful: a request that was refused never becomes this socket, and so cannot
  // end somebody else's call by going away.
  private voiceSocket: AuthenticatedWebSocket | null = null;
  // Whether the client of the request being answered gave up while it waited, and
  // which way. A stop or a disconnect that lands before the answer has no session
  // to end yet, so it is honoured once the start returns. One record, because
  // `voiceSocket` above refuses a second request while this one is outstanding.
  private voiceStarting: {
    ws: AuthenticatedWebSocket;
    cancelled: VoiceChatEndStatus | null;
  } | null = null;
  // Whether a computer-state frame is being built, and whether the desktop changed
  // again while it was. One build at a time keeps a burst of changes to one database
  // read, and the flag makes the last frame sent the newest state.
  private computerPublishing = false;
  private computerChangedAgain = false;
  // The dictation each socket is recording, from `dictation_start` until it ends. One per
  // socket and any number per runtime, since a dictation never takes the agent's voice.
  private dictations: Map<AuthenticatedWebSocket, DictationSession> = new Map();

  constructor() {
    // Push thread-title changes (placeholder + LLM upgrade) to the user's web
    // clients. Generation is owned by threadTitleService (channel-agnostic);
    // the gateway is just the WebSocket transport for the notification.
    threadTitleService.events.on('change', ({ userId, threadId, title }: ThreadTitleChange) => {
      this.sendToUser(userId, { type: 'thread', payload: { threadId, title } });
    });

    // Push which threads are working. A client shows the spinner for the thread on its
    // screen. `processing` stays the state of one request, which shows STOP on the
    // client that sent it.
    conversationThreadActivityService.events.on('change', (payload: ThreadActivityChange) => {
      this.broadcast({ type: 'status', payload });
    });

    // Push context-window occupancy so clients can show how full the window is.
    contextUsageService.events.on('usage', ({ userId, ...payload }: ContextUsageEvent) => {
      this.sendToUser(userId, { type: 'context', payload });
    });

    // Push compaction progress (started/completed/failed) so clients can show
    // a "compacting…" indicator and a completion note. Compaction itself is
    // owned by compactionService (channel-agnostic).
    compactionService.events.on('compaction', ({ userId, ...payload }: CompactionEvent) => {
      this.sendToUser(userId, { type: 'compaction', payload });
    });

    // Push update progress (available/updating/failed). Updates are owned by
    // updateService (channel-agnostic) and are install-level, so they go to
    // the one owner user every connection is pinned to.
    updateService.events.on('update', (payload: UpdateEvent) => {
      this.sendToUser(config.ownerUserId, { type: 'update', payload });
    });

    // Push the state of the desktop: which threads wait for it, who holds it, and
    // the open help requests. The emitter is the access gate itself, so every caller
    // that queues for the desktop reaches the web client, whichever turn asked.
    // Install-level, like the update frame above.
    computerService.access.on('change', () => {
      void this.publishComputer();
    });

  }

  /**
   * Broadcast the state of the desktop, coalescing a burst of changes into one frame.
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
        await this.sendComputerState((message) => this.sendToUser(config.ownerUserId, message));
        again = this.computerChangedAgain;
      }
    } finally {
      this.computerPublishing = false;
      this.computerChangedAgain = false;
    }
  }

  /**
   * Build the current state of the desktop — the body of `GET /computer` — and hand
   * it to `send`. Nothing is sent while no agent is loaded. A failed build is logged
   * and dropped: the next change, or the next client to connect, corrects the client.
   */
  private async sendComputerState(send: (message: WebSocketResponse) => void): Promise<void> {
    const agentId = config.agentId;
    if (!agentId) return;
    try {
      const payload = {
        ...computerService.status(),
        help: await computerHelpService.list(agentId, config.ownerUserId),
      };
      send({ type: 'computer', payload });
    } catch (error) {
      logger.warn({ err: error }, '[Computer] Could not publish the computer state');
    }
  }

  /**
   * Initialize WebSocket server
   */
  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

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

    this.wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Heartbeat to detect dead connections
    const interval = setInterval(() => {
      this.wss?.clients.forEach((ws: AuthenticatedWebSocket) => {
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
   * Handle new connection
   */
  private handleConnection(ws: AuthenticatedWebSocket, req: IncomingMessage): void {
    ws.isAlive = true;
    ws.connectionId = randomUUID();

    // The runtime is scoped to one agent and trusts the inbound network
    // (Lens Agents routing terminates auth in front of the container). Pin the
    // connection to the configured owner without inspecting a token.
    const userId: string = config.ownerUserId;
    ws.userId = userId;

    // Store connection
    const userConnections = this.connections.get(userId) || [];
    userConnections.push(ws);
    this.connections.set(userId, userConnections);

    logger.info('WebSocket connected for user %s (%d connections)', userId, userConnections.length);

    // Handle messages
    ws.on('message', async (data: Buffer, isBinary: boolean) => {
      try {
        // Audio first, and never parsed. A binary frame is one frame of the
        // client's microphone; running it through `JSON.parse` would fail on
        // every one of them fifty times a second and answer each with an error.
        if (isBinary) {
          this.handleBinary(ws, data);
          return;
        }
        const message: WebSocketMessage = JSON.parse(data.toString());
        await this.handleMessage(ws, userId, message);
      } catch (error: unknown) {
        logger.error('WebSocket message error: %s', error instanceof Error ? error.message : String(error));
        ws.send(JSON.stringify({ type: 'error', payload: { error: error instanceof Error ? error.message : String(error) } }));
      }
    });

    // Handle pong
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error('WebSocket error for user %s: %s', userId, error instanceof Error ? error.message : String(error));
    });

    // Handle close
    ws.on('close', (code, _reason) => {
      this.removeConnection(userId, ws);
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
      logger.info('WebSocket disconnected for user %s - code: %d', userId, code);
    });

    // Send initial connection status
    ws.send(JSON.stringify({
      type: 'status',
      payload: { connected: true },
    }));

    // A client that connects while a thread is working shows that from the start.
    for (const threadId of conversationThreadActivityService.workingThreadIds()) {
      ws.send(JSON.stringify({ type: 'status', payload: { threadId, working: true } }));
    }

    // And the state of the desktop, so a client that opens or reconnects during a wait
    // shows it without asking. The frames sent while the socket was down reached
    // nobody, so this is the reading a reconnecting client starts from. A publish
    // already in flight covers this socket, which is registered above, and its state
    // is read later than one read here, so the send is left to it.
    if (!this.computerPublishing) {
      void this.sendComputerState((message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      });
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    logger.info('WebSocket message received from %s', userId);

    switch (message.type) {
      case 'ping':
      case 'pong':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'chat':
        await this.handleChatMessage(ws, userId, message);
        break;

      case 'cancel':
        this.handleCancelMessage(userId);
        break;

      case 'subscribe':
        // User is subscribing to notifications (already connected)
        break;

      // Voice control. The audio itself rides this socket too, as binary frames
      // handled before the JSON path — see `handleBinary`.
      case 'voice_start':
        await this.handleVoiceStart(ws, userId, message);
        break;

      case 'voice_stop':
        await this.handleVoiceStop(ws);
        break;

      case 'dictation_start':
        await this.handleDictationStart(ws, userId);
        break;

      case 'dictation_stop':
        this.handleDictationStop(ws, message);
        break;

      default:
        logger.warn('Unknown WebSocket message type: %s', message.type);
        ws.send(JSON.stringify({ type: 'error', payload: { error: 'Unknown message type' } }));
    }
  }

  /**
   * Cancel the user's in-flight chat turn. Aborts the active controller —
   * which stops the LLM generation mid-turn — and clears any queued followups
   * so a cancel doesn't immediately auto-start the next message.
   *
   * Broadcasts the terminal `{ processing: false }` status immediately so
   * every one of the user's connections/tabs resets promptly — if the abort
   * is slow to land (e.g. a tool is mid-flight), waiting for processMessage's
   * `finally` would leave the other UIs stuck in "pending". The `finally`
   * broadcast remains as an idempotent safety net. The frame names the cancelled
   * turn's thread, so a turn on another thread keeps showing as running.
   */
  private handleCancelMessage(userId: string): void {
    const active = this.activeRequests.get(userId);
    if (active) {
      logger.info('Cancel requested by %s', userId);
      active.controller.abort();
      const { threadId } = active;
      this.sendToUser(userId, {
        type: 'status',
        payload: { processing: false, ...(threadId ? { threadId } : {}) },
      });
    }
    this.messageQueues.delete(userId);
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
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    const payload = payloadOf(message);

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
    const starting: { ws: AuthenticatedWebSocket; cancelled: VoiceChatEndStatus | null } = {
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
  private handleBinary(ws: AuthenticatedWebSocket, data: Buffer): void {
    const dictation = this.dictations.get(ws);
    if (dictation) {
      dictation.pushAudio(data);
      return;
    }
    if (this.voiceSocket !== ws) return;
    voiceChatService.pushAudio(data);
  }

  /** End the session this socket opened. A stop from any other socket does nothing. */
  private async handleVoiceStop(ws: AuthenticatedWebSocket): Promise<void> {
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
  private voiceSignal(ws: AuthenticatedWebSocket): VoiceChatSignal {
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
  private async handleDictationStart(ws: AuthenticatedWebSocket, userId: string): Promise<void> {
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
  private handleDictationStop(ws: AuthenticatedWebSocket, message: WebSocketMessage): void {
    const session = this.dictations.get(ws);
    if (!session) return;
    if (payloadOf(message)['commit'] === false) {
      session.cancel();
      return;
    }
    session.commit();
  }

  /** Send to one socket, which the client may have closed under us. */
  private sendTo(ws: AuthenticatedWebSocket, response: WebSocketResponse): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(response));
  }

  /**
   * Handle chat message based on mode
   */
  private async handleChatMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    // Handle both flat format and nested payload format (frontend uses payload)
    const payload = (message as any).payload || message;
    const mode = payload.mode || message.mode || 'followup';
    const content = payload.content || message.content || '';
    const threadId = payload.threadId || message.threadId;
    // This container serves exactly one agent, so the agent is ours, not the
    // client's — which is also why the client may omit `agentId` from the wire
    // (the prism-cli does).
    const agentId = config.agentId;
    const attachmentIds: string[] = Array.isArray(payload.attachmentIds)
      ? payload.attachmentIds
      : Array.isArray(message.attachmentIds)
        ? message.attachmentIds
        : [];
    if (!agentId) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { error: 'Agent runtime is still initializing; retry shortly' },
      }));
      return;
    }

    logger.info('Chat message from %s: mode=%s', userId, mode);

    // Allow a file-only message (attachments but no text); reject only when
    // there's neither text nor any attachment.
    if (!content.trim() && attachmentIds.length === 0) {
      logger.warn('Empty message from %s', userId);
      ws.send(JSON.stringify({ type: 'error', payload: { error: 'Empty message' } }));
      return;
    }

    // Update message with extracted values for downstream processing
    message.mode = mode;
    message.content = content;
    message.threadId = threadId;
    message.agentId = agentId;
    message.attachmentIds = attachmentIds;
    message.originConnectionId = ws.connectionId;

    switch (mode) {
      case 'collect':
        // Collect mode: Batch messages (for now, treat as followup)
        // TODO: Implement batching
        await this.queueMessage(ws, userId, message);
        break;

      // 'followup' and anything else: queueMessage hands the message to the turn
      // already running on its thread when there is one (mid-turn steering) and
      // otherwise starts or queues a turn.
      default:
        await this.queueMessage(ws, userId, message);
    }
  }

  /**
   * Queue message for processing
   */
  private async queueMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    // If not processing, process immediately
    if (!this.processingUsers.has(userId)) {
      await this.processMessage(ws, userId, message);
      return;
    }

    // A turn is in flight. Offer the message to it first: if it's running on
    // this message's thread, the engine folds it into that turn so the user's
    // correction lands while the work is still happening, instead of sitting in
    // this queue for the rest of the turn and then being answered against a
    // history that has moved on. A message that doesn't name its thread has
    // nothing to be offered to and falls straight through to the queue.
    //
    // The agent is this container's, never the client's — the client may omit
    // `agentId` (the prism-cli does). Reading it off the message instead left
    // those clients silently queue-only, with no steering at all.
    const agentId = config.agentId;
    if (agentId && hasThread(message)) {
      if (await this.offerToLiveTurn(userId, agentId, message)) return;
    }

    // Otherwise queue it
    const queue = this.messageQueues.get(userId) || [];
    queue.push({
      message,
      resolve: (response) => ws.send(JSON.stringify(response)),
    });
    this.messageQueues.set(userId, queue);
  }

  /**
   * Hand a message to the turn already running on its thread. Returns true when
   * that turn took it — the gateway is then done with the message, the turn
   * stores and answers it — and false when there was no live turn on the thread,
   * in which case steer-only mode stored nothing and the caller queues as usual.
   *
   * Takes a `ThreadedMessage` so the steer-only contract ("nothing is stored")
   * holds by construction: the engine only resolves — and creates — a thread
   * when the caller doesn't name one.
   */
  private async offerToLiveTurn(
    userId: string,
    agentId: string,
    message: ThreadedMessage
  ): Promise<boolean> {
    const attempt = await conversationEngineService.chat({
      userId,
      agentId,
      message: message.content || '',
      threadId: message.threadId,
      attachmentIds: message.attachmentIds,
      originConnectionId: message.originConnectionId,
      metadata: { channel: 'websocket' },
      steerOnly: true,
    });
    return attempt.steered === true;
  }

  /**
   * Process a message through the backend's conversation engine
   */
  private async processMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    const agentId = message.agentId;
    if (!agentId) {
      ws.send(JSON.stringify({ type: 'error', payload: { error: 'Agent ID is required in the message' } }));
      return;
    }

    // Authorization: Lens Agents inbound routing terminates auth in front of the
    // runtime. Once a request reaches the container we trust the connection.
    // Still pin to *this* container's agent so a stray client can't address
    // another runtime.
    if (agentId !== config.agentId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { error: 'Forbidden: this runtime serves a different agent' },
        })
      );
      return;
    }

    logger.info('Processing message for %s', userId);
    this.processingUsers.add(userId);

    // A `cancel` message aborts this controller, which stops the LLM
    // generation mid-turn (signal threaded into generateText).
    const controller = new AbortController();
    this.activeRequests.set(userId, { controller, threadId: message.threadId });

    try {
      // The STOP control on the client that sent the message. The thread lets a
      // client drop the frame of a request on another thread.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'status',
          payload: { processing: true, ...(message.threadId ? { threadId: message.threadId } : {}) },
        }));
      }

      logger.info('Calling conversation engine for %s', userId);

      // Process through local conversation engine (direct call, no HTTP).
      // Response delivery + thread-title updates happen inside the engine.
      await conversationEngineService.chat({
        userId,
        agentId,
        message: message.content || '',
        threadId: message.threadId,
        attachmentIds: message.attachmentIds,
        originConnectionId: message.originConnectionId,
        metadata: { channel: 'websocket' },
        abortSignal: controller.signal,
      });

      logger.info('Conversation engine completed for %s', userId);

      // Thread-title updates (placeholder + LLM upgrade) are emitted by
      // threadTitleService from the conversation engine and broadcast via the
      // 'change' subscription wired in the constructor — nothing to do here.

      // Note: Response delivery is handled by messageDeliveryService.publish()
      // which is called by conversationEngineService.chat() - no manual sending needed
    } catch (error: unknown) {
      // A cancel aborts the turn; invokeStream swallows the AbortError, so this
      // catch shouldn't see it — but guard anyway so a cancel never surfaces a
      // scary error bubble in the UI.
      if (!controller.signal.aborted) {
        logger.error('Error processing message: %s', error instanceof Error ? error.message : String(error));
        ws.send(JSON.stringify({
          type: 'error',
          payload: { error: error instanceof Error ? error.message : String(error) },
        }));
      }
    } finally {
      this.processingUsers.delete(userId);
      this.activeRequests.delete(userId);

      // Tell every one of the user's connections the request is done so the
      // STOP button resets even when a cancel produced no new message to deliver.
      this.sendToUser(userId, {
        type: 'status',
        payload: { processing: false, ...(message.threadId ? { threadId: message.threadId } : {}) },
      });

      // Process queued messages
      await this.processQueue(userId);
    }
  }

  /**
   * Process queued messages
   */
  private async processQueue(userId: string): Promise<void> {
    const queue = this.messageQueues.get(userId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift();
    if (!next) return;

    const connections = this.connections.get(userId);
    const ws = connections?.[0];
    if (ws) {
      await this.processMessage(ws, userId, next.message);
    }
  }

  /**
   * Send to all connections for a user
   */
  sendToUser(userId: string, message: WebSocketResponse): void {
    const connections = this.connections.get(userId);
    if (!connections) return;

    connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
  }

  /**
   * Broadcast to every open connection except `exceptConnectionId`.
   * For frames about a conversation: every connection may open every conversation of
   * the agent.
   */
  broadcast(message: WebSocketResponse, exceptConnectionId?: string): void {
    const frame = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (exceptConnectionId && ws.connectionId === exceptConnectionId) continue;
        ws.send(frame);
      }
    }
  }

  /**
   * Extract user ID from request by decoding the JWT token.
   * Backend already verified the signature — we only decode here.
   */
  private extractUserAuth(req: IncomingMessage): { userId: string; token: string } | null {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    let token = url.searchParams.get('token');

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    // Lens Agents inbound routing terminates auth in front of the runtime, so we
    // trust the connection here. The Web UI talks straight to the runtime
    // over WS without a JWT — fall back to the bootstrap-default owner user
    // (matches the agent's `userId`).
    if (!token) {
      return { userId: config.ownerUserId, token: '' };
    }

    try {
      // Decode only — backend already verified the signature
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (!decoded?.sub) return null;
      return { userId: decoded.sub, token };
    } catch {
      logger.error('Failed to decode JWT token');
      return null;
    }
  }

  /**
   * Remove connection from tracking
   */
  private removeConnection(userId: string, ws: AuthenticatedWebSocket): void {
    const connections = this.connections.get(userId);
    if (!connections) return;

    const index = connections.indexOf(ws);
    if (index > -1) {
      connections.splice(index, 1);
    }

    if (connections.length === 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, connections);
    }
  }

  /**
   * Get connection count for a user
   */
  getConnectionCount(userId: string): number {
    return this.connections.get(userId)?.length || 0;
  }

  /**
   * Check if user is connected
   */
  isConnected(userId: string): boolean {
    return this.getConnectionCount(userId) > 0;
  }

  /** Whether any user has an open connection. */
  hasConnections(): boolean {
    for (const connections of this.connections.values()) {
      if (connections.length > 0) return true;
    }
    return false;
  }

  /**
   * Close all connections (for shutdown)
   */
  closeAll(): void {
    this.wss?.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });
    this.connections.clear();
  }
}

// Export singleton instance
export const webSocketGatewayService = new WebSocketGatewayService();
