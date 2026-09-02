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
import { IncomingMessage } from 'http';
import { logger } from '../logger';
import { config } from '../config';
import { conversationEngineService } from './conversation-engine.service';
import { threadTitleService, type ThreadTitleChange } from './thread-title.service';
import { contextUsageService, type ContextUsageEvent } from './context-usage.service';
import { compactionService, type CompactionEvent } from './compaction.service';
import {
  voiceChatService,
  type VoiceChatSignal,
  type VoiceListeningMode,
} from './voice/voice-chat.service';
import { VOICE_AUDIO_FORMAT } from './voice/socket-audio';

// ============================================================================
// Types
// ============================================================================

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userToken?: string;
  isAlive?: boolean;
}

interface WebSocketMessage {
  type: 'chat' | 'ping' | 'pong' | 'subscribe' | 'cancel' | 'voice_start' | 'voice_stop';
  mode?: 'followup' | 'collect';
  content?: string;
  threadId?: string;
  // Optional: the runtime substitutes `config.agentId` when omitted.
  agentId?: string;
  // Ids of files already uploaded via POST /agents/attachments.
  attachmentIds?: string[];
  // The voice frames carry their fields here. See docs/voice-chat.md.
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
    | 'voice_state'
    | 'voice_error'
    | 'voice_hello'
    | 'voice_clear';
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
 * Which listening mode the client asked for, or undefined for the service's default.
 *
 * An unrecognized value is treated as unstated rather than refused. The two modes differ
 * in how much the agent says, not in what it is allowed to do, so the cost of ignoring a
 * misspelling is a chattier call — where refusing the session would deny a client a call
 * over a field it could have omitted.
 */
function listeningMode(payload: Record<string, unknown>): VoiceListeningMode | undefined {
  const value = payload['mode'];
  return value === 'open' || value === 'addressed' ? value : undefined;
}

// ============================================================================
// WebSocket Gateway Service
// ============================================================================

class WebSocketGatewayService {
  private wss: WebSocketServer | null = null;
  private connections: Map<string, AuthenticatedWebSocket[]> = new Map();
  private messageQueues: Map<string, Array<{ message: WebSocketMessage; resolve: (response: WebSocketResponse) => void }>> = new Map();
  private processingUsers: Set<string> = new Set();
  // The AbortController for the user's in-flight chat turn. A `cancel` message
  // aborts it, which stops the LLM generation mid-turn (see invokeStream).
  // Single-flight per user, so one controller per userId is sufficient.
  private activeRequests: Map<string, AbortController> = new Map();
  // The socket whose offer opened the voice session that is running, so closing
  // it ends the call. A socket that was refused a session never becomes this
  // one, and so cannot end somebody else's by going away.
  private voiceSocket: AuthenticatedWebSocket | null = null;
  // The socket whose offer is still being answered, and whether its client gave
  // up while it waited. A stop or a disconnect that lands before the answer has
  // no session to end yet, so it is honoured once the start returns.
  private voiceStarting: { ws: AuthenticatedWebSocket; cancelled: boolean } | null = null;

  constructor() {
    // Push thread-title changes (placeholder + LLM upgrade) to the user's web
    // clients. Generation is owned by threadTitleService (channel-agnostic);
    // the gateway is just the WebSocket transport for the notification.
    threadTitleService.events.on('change', ({ userId, threadId, title }: ThreadTitleChange) => {
      this.broadcast(userId, { type: 'thread', payload: { threadId, title } });
    });

    // Push context-window occupancy so clients can show how full the window is.
    contextUsageService.events.on('usage', ({ userId, ...payload }: ContextUsageEvent) => {
      this.broadcast(userId, { type: 'context', payload });
    });

    // Push compaction progress (started/completed/failed) so clients can show
    // a "compacting…" indicator and a completion note. Compaction itself is
    // owned by compactionService (channel-agnostic).
    compactionService.events.on('compaction', ({ userId, ...payload }: CompactionEvent) => {
      this.broadcast(userId, { type: 'compaction', payload });
    });
  }

  /**
   * Initialize WebSocket server
   */
  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: '/api/ws',
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
      // The client that was talking is gone, so the call is over: signalling is
      // the only way it could stop the session or hear that it ended.
      if (this.voiceStarting?.ws === ws) this.voiceStarting.cancelled = true;
      if (this.voiceSocket === ws) {
        this.voiceSocket = null;
        void voiceChatService.stop('the client disconnected');
      }
      logger.info('WebSocket disconnected for user %s - code: %d', userId, code);
    });

    // Send initial connection status
    ws.send(JSON.stringify({
      type: 'status',
      payload: { connected: true },
    }));

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
   * broadcast remains as an idempotent safety net.
   */
  private handleCancelMessage(userId: string): void {
    const controller = this.activeRequests.get(userId);
    if (controller) {
      logger.info('Cancel requested by %s', userId);
      controller.abort();
      this.broadcast(userId, { type: 'status', payload: { processing: false } });
    }
    this.messageQueues.delete(userId);
  }

  /**
   * Open a voice chat for the client on this socket.
   *
   * The session belongs to the runtime rather than to the socket, so a second
   * client's request is refused with a `voice_error` and leaves the running call
   * alone. See docs/voice-chat.md for the frames.
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

    // Answering takes a moment, and the client can give up inside it.
    const starting = { ws, cancelled: false };
    this.voiceStarting = starting;
    const started = await voiceChatService.start({
      userId,
      agentId,
      threadId: stringField(payload, 'threadId'),
      mode: listeningMode(payload),
      signal: this.voiceSignal(ws),
    });
    if (this.voiceStarting === starting) this.voiceStarting = null;
    if (!started) return;

    // Nobody is on the other end of the session that just opened. End it here:
    // its peer has no client to connect to, so it would hold the agent's voice
    // until the media path times out, and a peer that never got a candidate may
    // never report a failure at all.
    if (starting.cancelled || ws.readyState !== WebSocket.OPEN) {
      await voiceChatService.stop('the client left before the call started');
      return;
    }

    this.voiceSocket = ws;
    // Sent after the session is the socket's, so a client that was refused never
    // reads a format it cannot use.
    this.sendTo(ws, { type: 'voice_hello', payload: { format: VOICE_AUDIO_FORMAT } });
  }

  /**
   * One frame of the client's microphone.
   *
   * Only from the socket that holds the session: another client's audio is not this
   * call's, and a frame arriving after a call ended is ordinary rather than an error, so
   * both are dropped in silence.
   */
  private handleBinary(ws: AuthenticatedWebSocket, data: Buffer): void {
    if (this.voiceSocket !== ws) return;
    voiceChatService.pushAudio(data);
  }

  /** End the session this socket opened. A stop from any other socket does nothing. */
  private async handleVoiceStop(ws: AuthenticatedWebSocket): Promise<void> {
    if (this.voiceStarting?.ws === ws) this.voiceStarting.cancelled = true;
    if (this.voiceSocket !== ws) return;
    await voiceChatService.stop();
  }

  /** How the voice service answers the client that asked for the session. */
  private voiceSignal(ws: AuthenticatedWebSocket): VoiceChatSignal {
    return {
      sendAudio: (pcm) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(pcm, { binary: true });
      },
      sendClear: () => this.sendTo(ws, { type: 'voice_clear' }),
      state: (state) => {
        if (state === 'ended' && this.voiceSocket === ws) this.voiceSocket = null;
        this.sendTo(ws, { type: 'voice_state', payload: { state } });
      },
      error: (error) => this.sendTo(ws, { type: 'voice_error', payload: { error } }),
    };
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
    this.activeRequests.set(userId, controller);

    try {
      // Send processing indicator
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'status',
          payload: { processing: true },
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

      // Tell every one of the user's connections the turn is done so the
      // STOP button / spinner resets even when a cancel produced no new
      // message to deliver.
      this.broadcast(userId, { type: 'status', payload: { processing: false } });

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
   * Broadcast to all connections for a user
   */
  broadcast(userId: string, message: WebSocketResponse): void {
    const connections = this.connections.get(userId);
    if (!connections) return;

    connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
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
