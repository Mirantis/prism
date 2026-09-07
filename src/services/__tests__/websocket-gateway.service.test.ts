/**
 * WebSocket Gateway Service Tests (Agent-Runtime)
 *
 * Tests for WebSocketGatewayService covering:
 * - Connection management
 * - Message handling (chat, ping)
 * - Message modes (followup, collect)
 * - Notification delivery
 * - Authentication (JWT decode, no verification — backend already verified)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that are available before vi.mock hoisting
const { mockChat, mockConfig, mockTitleEvents, mockVoice } = vi.hoisted(() => {
  const listeners: Array<(payload: unknown) => void> = [];
  return {
    mockChat: vi.fn(),
    // The voice session owner. The gateway carries its control frames and its
    // audio, so what a test asserts here is what goes to which socket.
    mockVoice: {
      start: vi.fn(),
      pushAudio: vi.fn(),
      stop: vi.fn(),
    },
    mockConfig: {
      agentId: undefined as string | undefined,
      codingAgent: 'claude-code',
      availableCodingAgents: ['claude-code'],
      ownerUserId: '00000000-0000-0000-0000-000000000001',
    },
    // Minimal EventEmitter stub. The gateway subscribes via `.on('change', cb)`
    // in its constructor; tests drive broadcasts via `.emit('change', payload)`.
    mockTitleEvents: {
      on: (_event: string, cb: (payload: unknown) => void) => {
        listeners.push(cb);
      },
      emit: (_event: string, payload: unknown) => {
        listeners.forEach((cb) => cb(payload));
      },
    },
  };
});

vi.mock('../conversation-engine.service', () => ({
  conversationEngineService: {
    chat: mockChat,
  },
}));

vi.mock('../thread-title.service', () => ({
  threadTitleService: { events: mockTitleEvents, onFirstUserMessage: vi.fn() },
}));

vi.mock('../../config', () => ({
  CODING_AGENTS: ['claude-code', 'codex'],
  config: mockConfig,
}));

vi.mock('../voice/voice-chat.service', () => ({
  voiceChatService: mockVoice,
}));

// Import after mocking
import { webSocketGatewayService } from '../websocket-gateway.service';

// Access internal state for testing
const service = webSocketGatewayService as any;

function createMockWebSocket() {
  const listeners: Record<string, Function[]> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, callback: Function) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(callback);
    }),
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    readyState: 1, // OPEN
    // What `ws` reports as still unsent. The voice path reads it before every frame of
    // the agent's speech, so a test that stalls a client sets it.
    bufferedAmount: 0,
    isAlive: true,
    userId: 'test-user-id',
  };
}

/** Build a minimal JWT with the given payload (no signature verification needed). */
function buildTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

describe('Requirement: WebSocket Gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Most tests use 'agent-123' as the message's agentId; pin AGENT_ID to
    // the same value so the access-control check passes.
    mockConfig.agentId = 'agent-123';

    // Reset service state
    service.connections = new Map();
    service.messageQueues = new Map();
    service.processingUsers = new Set();
    service.activeRequests = new Map();
    service.voiceSocket = null;
    service.voiceStarting = null;

    // Default mock responses. `steered: false` is the engine's answer when no
    // turn is live on the thread, which is what the gateway checks before
    // falling back to its own queue.
    mockChat.mockResolvedValue({ steered: false });
    // The session opens, which is the case every voice test but the refusal wants.
    mockVoice.start.mockResolvedValue(true);
    mockVoice.stop.mockResolvedValue(undefined);
    mockVoice.pushAudio.mockReturnValue(undefined);
  });

  describe('Scenario: Connection tracking', () => {
    it('should track connection for user', () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;

      service.connections.set(userId, [ws]);

      expect(service.isConnected(userId)).toBe(true);
      expect(service.getConnectionCount(userId)).toBe(1);
    });

    it('should support multiple connections per user', () => {
      const userId = 'user-123';
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      service.connections.set(userId, [ws1, ws2]);

      expect(service.getConnectionCount(userId)).toBe(2);
    });

    it('should return false for non-connected user', () => {
      expect(service.isConnected('user-nonexistent')).toBe(false);
      expect(service.getConnectionCount('user-nonexistent')).toBe(0);
    });
  });

  describe('Scenario: JWT decode (no verification)', () => {
    it('should extract userId from a valid JWT token via query param', () => {
      const token = buildTestJwt({ sub: 'user-abc' });
      const req = { url: `/api/ws?token=${token}`, headers: { host: 'localhost:3003' } };
      const result = service.extractUserAuth(req);
      expect(result).toEqual({ userId: 'user-abc', token });
    });

    it('should extract userId from Authorization header', () => {
      const token = buildTestJwt({ sub: 'user-xyz' });
      const req = { url: '/api/ws', headers: { host: 'localhost:3003', authorization: `Bearer ${token}` } };
      const result = service.extractUserAuth(req);
      expect(result).toEqual({ userId: 'user-xyz', token });
    });

    it('falls back to the owner user when no token is provided', () => {
      const req = { url: '/api/ws', headers: { host: 'localhost:3003' } };
      expect(service.extractUserAuth(req)).toEqual({
        userId: mockConfig.ownerUserId,
        token: '',
      });
    });

    it('should return null for a malformed token', () => {
      const req = { url: '/api/ws?token=not-a-jwt', headers: { host: 'localhost:3003' } };
      expect(service.extractUserAuth(req)).toBeNull();
    });

    it('should return null when sub is missing from payload', () => {
      const token = buildTestJwt({ email: 'no-sub@example.com' });
      const req = { url: `/api/ws?token=${token}`, headers: { host: 'localhost:3003' } };
      expect(service.extractUserAuth(req)).toBeNull();
    });
  });

  describe('Scenario: Message handling', () => {
    it('should respond to ping with pong', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;

      await service.handleMessage(ws, userId, { type: 'ping' });

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
    });

    it('should process chat message', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'followup',
        content: 'Hello',
        threadId: 'thread-123',
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          message: 'Hello',
          threadId: 'thread-123',
          agentId: 'agent-123',
          metadata: { channel: 'websocket' },
        })
      );
    });

    it('should reject empty messages', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        content: '   ',
        agentId: 'agent-123',
      });

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'error',
        payload: { error: 'Empty message' },
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('accepts a file-only message (empty text but attachments present) and forwards ids', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;
      service.connections.set(userId, [ws]);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        content: '',
        attachmentIds: ['att-1'],
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ message: '', attachmentIds: ['att-1'], agentId: 'agent-123' }),
      );
    });

    it('forwards attachmentIds alongside text content', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;
      service.connections.set(userId, [ws]);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        content: 'see attached',
        attachmentIds: ['att-1', 'att-2'],
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'see attached', attachmentIds: ['att-1', 'att-2'] }),
      );
    });

    it('still rejects when there is neither text nor attachments', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        content: '',
        attachmentIds: [],
        agentId: 'agent-123',
      });

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'error',
        payload: { error: 'Empty message' },
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('should handle unknown message type', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;

      await service.handleMessage(ws, userId, { type: 'unknown' as any });

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'error',
        payload: { error: 'Unknown message type' },
      }));
    });
  });

  describe('Scenario: Cancellation', () => {
    /** Start a chat turn that blocks on a controllable chat promise. */
    function startBlockingTurn(userId: string) {
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;
      service.connections.set(userId, [ws]);

      let capturedSignal: AbortSignal | undefined;
      let settle!: (action: 'resolve' | 'reject', value?: unknown) => void;
      mockChat.mockImplementation((input: { abortSignal?: AbortSignal }) => {
        capturedSignal = input.abortSignal;
        return new Promise<void>((resolve, reject) => {
          settle = (action, value) =>
            action === 'resolve' ? resolve(undefined) : reject(value);
        });
      });

      // Kick off processing; it stays pending on the blocking chat promise.
      const processing = service.handleChatMessage(ws, userId, {
        type: 'chat', mode: 'followup', content: 'Hello', agentId: 'agent-123',
      });

      return { ws, processing, getSignal: () => capturedSignal, settle: (...a: ['resolve' | 'reject', unknown?]) => settle(...a) };
    }

    it('aborts the in-flight request when a cancel message arrives', async () => {
      const userId = 'user-123';
      const turn = startBlockingTurn(userId);
      await Promise.resolve();

      expect(turn.getSignal()?.aborted).toBe(false);

      await service.handleMessage(turn.ws, userId, { type: 'cancel' });

      expect(turn.getSignal()?.aborted).toBe(true);
      // The terminal status is broadcast immediately on cancel (not only in
      // processMessage's finally) so other tabs reset promptly — assert it
      // before the blocking chat settles.
      expect(turn.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'status', payload: { processing: false } }),
      );

      turn.settle('resolve');
      await turn.processing;
    });

    it('broadcasts a terminal { processing: false } status when the turn ends', async () => {
      const userId = 'user-123';
      const turn = startBlockingTurn(userId);
      await Promise.resolve();

      turn.settle('resolve');
      await turn.processing;

      expect(turn.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'status', payload: { processing: false } }),
      );
    });

    it('does not surface an error envelope when the turn was cancelled', async () => {
      const userId = 'user-123';
      const turn = startBlockingTurn(userId);
      await Promise.resolve();

      await service.handleMessage(turn.ws, userId, { type: 'cancel' });
      // The aborted generation rejects (as the SDK would); the gateway must
      // swallow it rather than show an error bubble.
      turn.settle('reject', Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await turn.processing;

      const sentTypes = turn.ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]).type);
      expect(sentTypes).not.toContain('error');
    });

    it('clears any queued followups on cancel so none auto-start', () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      service.messageQueues.set(userId, [{ message: { type: 'chat' }, resolve: () => {} }]);
      service.activeRequests.set(userId, new AbortController());

      service.handleMessage(ws, userId, { type: 'cancel' });

      expect(service.messageQueues.has(userId)).toBe(false);
    });

    it('cancel is a no-op when nothing is in flight', () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      expect(() => service.handleMessage(ws, userId, { type: 'cancel' })).not.toThrow();
    });
  });

  describe('Scenario: Message modes', () => {
    it('should queue messages if user is processing', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);
      service.processingUsers.add(userId);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'followup',
        content: 'Queued message',
        threadId: 'thread-1',
        agentId: 'agent-123',
      });

      // The live turn is on another thread (the engine reported not-steered), so
      // the message falls back to this queue.
      const queue = service.messageQueues.get(userId);
      expect(queue).toHaveLength(1);
      expect(queue[0].message.content).toBe('Queued message');
    });

    it('queues without offering when the message does not name a thread', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);
      service.processingUsers.add(userId);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'followup',
        content: 'Queued message',
        agentId: 'agent-123',
      });

      // Nothing to steer without a thread id, and probing anyway would have the
      // engine resolve one — creating a thread for a message steer-only mode
      // neither stores nor answers.
      expect(mockChat).not.toHaveBeenCalled();
      expect(service.messageQueues.get(userId)).toHaveLength(1);
    });

    it('hands a message to the live turn instead of queueing it', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);
      service.processingUsers.add(userId);
      // The engine folded the message into the turn already running on its
      // thread, so the user's correction lands mid-work rather than waiting out
      // the turn in this queue.
      mockChat.mockResolvedValue({ steered: true });

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'followup',
        content: 'no need to run tests',
        threadId: 'thread-1',
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ steerOnly: true, threadId: 'thread-1' }),
      );
      expect(service.messageQueues.get(userId)).toBeUndefined();
    });

    it('steers a message that omits agentId, same as one that sends it', async () => {
      // The prism-cli omits `agentId` on the wire. Reading it off the message
      // made those clients queue-only, with no steering at all.
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);
      service.processingUsers.add(userId);
      mockChat.mockResolvedValue({ steered: true });

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'followup',
        content: 'no need to run tests',
        threadId: 'thread-1',
      });

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          steerOnly: true,
          threadId: 'thread-1',
          agentId: mockConfig.agentId,
        }),
      );
      expect(service.messageQueues.get(userId)).toBeUndefined();
    });

    it('should process collect mode messages', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'collect',
        content: 'Collect me',
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalled();
    });

    it('should default to followup mode if not specified', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        content: 'No mode specified',
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalled();
    });
  });

  describe('Scenario: Broadcast', () => {
    it('should broadcast to all user connections', () => {
      const userId = 'user-123';
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      ws1.readyState = 1;
      ws2.readyState = 1;

      service.connections.set(userId, [ws1, ws2]);

      const message = { type: 'status', content: 'Update' };
      service.broadcast(userId, message);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should do nothing if user has no connections', () => {
      service.broadcast('user-nonexistent', { type: 'status' });
      // Should not throw
    });
  });

  describe('Scenario: Thread title broadcast', () => {
    // Title generation is owned by threadTitleService (channel-agnostic) and
    // triggered from the conversation engine. The gateway only translates its
    // 'change' events — wired in the constructor — into 'thread' broadcasts.
    it('broadcasts a thread title change emitted by threadTitleService', () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;
      service.connections.set(userId, [ws]);

      mockTitleEvents.emit('change', {
        userId,
        threadId: 'thread-123',
        title: 'Database Schema Migration',
      });

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'thread',
          payload: { threadId: 'thread-123', title: 'Database Schema Migration' },
        }),
      );
    });

    it('does not throw when the titled thread has no connected client', () => {
      expect(() =>
        mockTitleEvents.emit('change', {
          userId: 'user-without-connection',
          threadId: 'thread-123',
          title: 'Database Schema Migration',
        }),
      ).not.toThrow();
    });
  });

  describe('Scenario: Processing indicator', () => {
    it('should send processing indicator', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);

      await service.processMessage(ws, userId, {
        type: 'chat',
        content: 'Test',
        agentId: 'agent-123',
      });

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'status',
        payload: { processing: true },
      }));
    });
  });

  describe('Scenario: Access control', () => {
    beforeEach(() => {
      mockConfig.agentId = 'agent-bobby';
    });

    it('accepts a message when agentId matches (auth is handled by Lens Agents inbound routing)', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;
      service.connections.set(userId, [ws]);

      await service.processMessage(ws, userId, {
        type: 'chat',
        content: 'hi Bobby',
        agentId: 'agent-bobby',
      });

      expect(mockChat).toHaveBeenCalled();
    });

    it('rejects when agentId does not match AGENT_ID', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;
      service.connections.set(userId, [ws]);

      await service.processMessage(ws, userId, {
        type: 'chat',
        content: 'hi Alice',
        agentId: 'agent-alice',
      });

      expect(mockChat).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'error',
          payload: { error: 'Forbidden: this runtime serves a different agent' },
        })
      );
    });
  });

  describe('Scenario: Queue processing', () => {
    it('should process queued messages after current completes', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);

      // Add a message to queue
      service.messageQueues.set(userId, [{
        message: { type: 'chat', content: 'Queued', agentId: 'agent-123' },
        resolve: vi.fn(),
      }]);

      // Process first message (will then process queue)
      await service.processMessage(ws, userId, {
        type: 'chat',
        content: 'First',
        agentId: 'agent-123',
      });

      // Chat should be called twice (first + queued)
      expect(mockChat).toHaveBeenCalledTimes(2);
    });
  });

  describe('Scenario: Close all connections', () => {
    it('should close all connections on shutdown', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      service.connections.set('user-1', [ws1]);
      service.connections.set('user-2', [ws2]);

      // Mock wss clients
      service.wss = {
        clients: new Set([ws1, ws2]),
      };

      service.closeAll();

      expect(ws1.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(ws2.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(service.connections.size).toBe(0);
    });
  });

  describe('Scenario: Connection removal', () => {
    it('should remove specific connection', () => {
      const userId = 'user-123';
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      service.connections.set(userId, [ws1, ws2]);

      service.removeConnection(userId, ws1);

      const connections = service.connections.get(userId);
      expect(connections).toHaveLength(1);
      expect(connections[0]).toBe(ws2);
    });

    it('should remove user from map when last connection removed', () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();

      service.connections.set(userId, [ws]);

      service.removeConnection(userId, ws);

      expect(service.connections.has(userId)).toBe(false);
    });

    it('should handle removing from non-existent user', () => {
      const ws = createMockWebSocket();

      // Should not throw
      service.removeConnection('user-nonexistent', ws);
    });
  });

  describe('Scenario: Voice over the socket', () => {
    type MockSocket = ReturnType<typeof createMockWebSocket>;

    /** Deliver a control frame the way a client's message does. */
    async function frame(ws: MockSocket, message: unknown): Promise<void> {
      await service.handleMessage(ws, 'user-123', message);
    }

    /** Deliver one binary audio frame, as `ws` reports it. */
    function audio(ws: MockSocket, pcm: Buffer): void {
      service.handleBinary(ws, pcm);
    }

    /** The signal the gateway handed the voice service for its nth request. */
    function signalOf(call = 0) {
      return mockVoice.start.mock.calls[call]![0].signal;
    }

    /** What the socket was sent last, as the object it was sent as. */
    function lastSent(ws: MockSocket): unknown {
      const calls = ws.send.mock.calls;
      return JSON.parse(calls[calls.length - 1]![0] as string);
    }

    it('opens a session and tells the client the audio format', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { threadId: 'thread-1' } });

      expect(mockVoice.start).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', agentId: 'agent-123', threadId: 'thread-1' })
      );
      expect(lastSent(ws)).toEqual({
        type: 'voice_hello',
        payload: { format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } },
      });
    });

    it('passes the listening mode the client asked for', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { mode: 'addressed' } });

      expect(mockVoice.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'addressed' })
      );
    });

    it('leaves the mode unstated when the client omits it', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledWith(expect.objectContaining({ mode: undefined }));
    });

    /**
     * Refused rather than defaulted, unlike every other field in this payload. `open`
     * answers every utterance in the room and an answer can be a tool call, so a client
     * that means `addressed` and misspells it would otherwise get an agent talking over
     * a meeting with nothing in the frames to say why.
     */
    it('refuses a mode it does not serve, and starts nothing', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { mode: 'adressed' } });

      expect(mockVoice.start).not.toHaveBeenCalled();
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'mode must be "open" or "addressed"' },
      });
    });

    /**
     * `null` is a field the client sent, not a field it left out, and the two mean
     * different things here: a client that serialized its state and got `null` asked for
     * something, and `open` answers a whole room.
     */
    it('refuses a null mode rather than taking the default', async () => {
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: { mode: null } });

      expect(mockVoice.start).not.toHaveBeenCalled();
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'mode must be "open" or "addressed"' },
      });
    });

    it('carries the session state, its errors and the clear back', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const signal = signalOf();

      signal.state('live');
      expect(lastSent(ws)).toEqual({ type: 'voice_state', payload: { state: 'live' } });

      signal.sendClear();
      expect(lastSent(ws)).toEqual({ type: 'voice_clear' });

      signal.error('the model closed the socket');
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'the model closed the socket' },
      });

      signal.state('ended');
      expect(lastSent(ws)).toEqual({ type: 'voice_state', payload: { state: 'ended' } });
      // The session is over, so this socket's close no longer ends anything.
      expect(service.voiceSocket).toBeNull();
    });

    /** The agent's speech is binary, and must not be JSON-encoded on the way out. */
    it('sends the agent audio as a binary frame', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const speech = Buffer.alloc(960, 5);

      signalOf().sendAudio(speech);

      const [payload, options] = ws.send.mock.calls[ws.send.mock.calls.length - 1]!;
      expect(payload).toEqual(speech);
      expect(options).toEqual({ binary: true });
    });

    it('says nothing on a socket the client has closed', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const signal = signalOf();
      ws.send.mockClear();
      ws.readyState = 3; // CLOSED

      signal.state('live');
      signal.sendAudio(Buffer.alloc(320));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('refuses a session while the runtime is still starting up', async () => {
      mockConfig.agentId = undefined;
      const ws = createMockWebSocket();

      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).not.toHaveBeenCalled();
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'Agent runtime is still initializing; retry shortly' },
      });
    });

    it("hands the holder's audio to the session", async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });
      const pcm = Buffer.alloc(480, 1);

      audio(owner, pcm);

      expect(mockVoice.pushAudio).toHaveBeenCalledWith(pcm);
    });

    /**
     * A second client refused the session keeps its microphone open, and its frames
     * are not this call's audio.
     */
    it('drops audio from a socket that does not hold the session', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });

      const other = createMockWebSocket();
      await frame(other, { type: 'voice_start', payload: {} });
      audio(other, Buffer.alloc(480));

      expect(mockVoice.pushAudio).not.toHaveBeenCalled();
    });

    /**
     * Refused by the gateway rather than by the voice service, and told apart from a
     * client's own second attempt: one person has a call to end, the other has somebody
     * to go and find.
     */
    it('refuses a second client and leaves the running call alone', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });
      expect(mockVoice.start).toHaveBeenCalledTimes(1);

      const other = createMockWebSocket();
      await frame(other, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(lastSent(other)).toEqual({
        type: 'voice_error',
        payload: { error: 'There is already a voice chat running. End that one first.' },
      });
      // The refused socket did not take the field the audio path reads.
      expect(service.voiceSocket).toBe(owner);
    });

    /**
     * The client's first frames can arrive before `start()` returns: the service reports
     * `live` from inside it. Audio dropped in that window is audio the model never hears.
     */
    it('takes the holder\'s audio from the moment the session reports live', async () => {
      const ws = createMockWebSocket();
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      const pcm = Buffer.alloc(480, 7);
      audio(ws, pcm);

      expect(mockVoice.pushAudio).toHaveBeenCalledWith(pcm);

      answer(true);
      await opening;
    });

    /**
     * A client that is not draining gets a gap rather than a growing queue: what is
     * already buffered plays late, and adding to it makes the lag permanent.
     */
    it('drops the agent speech a stalled client has not taken', async () => {
      const ws = createMockWebSocket();
      await frame(ws, { type: 'voice_start', payload: {} });
      const signal = signalOf();
      ws.send.mockClear();

      ws.bufferedAmount = 200_000;
      signal.sendAudio(Buffer.alloc(960));
      expect(ws.send).not.toHaveBeenCalled();

      ws.bufferedAmount = 0;
      signal.sendAudio(Buffer.alloc(960));
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('drops audio when no session is running', () => {
      const ws = createMockWebSocket();
      expect(() => audio(ws, Buffer.alloc(480))).not.toThrow();
      expect(mockVoice.pushAudio).not.toHaveBeenCalled();
    });

    it('ends a session whose client asked to stop before it opened', async () => {
      const ws = createMockWebSocket();
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      await frame(ws, { type: 'voice_stop' });
      answer(true);
      await opening;

      // The client asked, so the call is completed rather than dropped.
      expect(mockVoice.stop).toHaveBeenCalledWith(
        'the client left before the call started',
        'completed',
      );
      // Nothing to end later, and nothing holding the next caller out: the session never
      // became this socket's.
      expect(service.voiceSocket).toBeNull();
    });

    /**
     * Two starts and a stop, all inside the startup window. The second start is refused
     * before it reaches the service, so the one record the stop cancels is the session
     * this socket is really opening. Held per socket rather than per request, since a
     * record per request would let the stop land on the later one, which has nothing to
     * end, while the earlier one went live behind it.
     */
    it('honours a stop after a second start landed inside the startup window', async () => {
      const ws = createMockWebSocket();
      const answers: Array<(started: boolean) => void> = [];
      mockVoice.start.mockImplementation(
        () => new Promise<boolean>((resolve) => answers.push(resolve)),
      );

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      const second = frame(ws, { type: 'voice_start', payload: {} });
      await frame(ws, { type: 'voice_stop' });
      answers.forEach((resolve) => resolve(true));
      await Promise.all([opening, second]);

      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(mockVoice.stop).toHaveBeenCalledWith(
        'the client left before the call started',
        'completed',
      );
      expect(service.voiceSocket).toBeNull();
    });

    it('refuses a second start on the socket whose session is still opening', async () => {
      const ws = createMockWebSocket();
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledTimes(1);
      expect(lastSent(ws)).toEqual({
        type: 'voice_error',
        payload: { error: 'A voice chat is already running on this connection. Stop it first.' },
      });

      answer(true);
      await opening;
    });

    /**
     * The claim is taken before the service is asked, so a refusal — a meeting holding the
     * agent's voice, say — has to give it back. A claim left standing would refuse every
     * later call for the life of the process, with the gateway's own message rather than
     * the reason the service gave.
     */
    it('gives the claim back when the service refuses the session', async () => {
      const ws = createMockWebSocket();
      mockVoice.start.mockResolvedValue(false);

      await frame(ws, { type: 'voice_start', payload: {} });

      expect(service.voiceSocket).toBeNull();

      mockVoice.start.mockResolvedValue(true);
      await frame(ws, { type: 'voice_start', payload: {} });

      expect(mockVoice.start).toHaveBeenCalledTimes(2);
      expect(service.voiceSocket).toBe(ws);
    });

    it('ends a session whose client went away before it opened', async () => {
      const ws = createMockWebSocket();
      service.handleConnection(ws, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      let answer: (started: boolean) => void = () => {};
      mockVoice.start.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

      const opening = frame(ws, { type: 'voice_start', payload: {} });
      ws.emit('close', 1001);
      answer(true);
      await opening;

      // Nobody asked for this ending, so it is reported as the connection dropping.
      expect(mockVoice.stop).toHaveBeenCalledWith(
        'the client left before the call started',
        'disconnected',
      );
      // Ended once, by whoever knew there was a session to end.
      expect(mockVoice.stop).toHaveBeenCalledTimes(1);
      expect(service.voiceSocket).toBeNull();
    });

    it('ends the session for the socket that opened it, and for no other', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });

      // A second client is refused the session, so its stop is not the owner's.
      const other = createMockWebSocket();
      await frame(other, { type: 'voice_start', payload: {} });
      // And the refusal left the session where it was.
      expect(service.voiceSocket).toBe(owner);

      await frame(other, { type: 'voice_stop' });
      expect(mockVoice.stop).not.toHaveBeenCalled();

      await frame(owner, { type: 'voice_stop' });
      expect(mockVoice.stop).toHaveBeenCalledTimes(1);
    });

    it('ends the session when the socket that opened it goes away', async () => {
      const ws = createMockWebSocket();
      service.handleConnection(ws, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      await frame(ws, { type: 'voice_start', payload: {} });

      ws.emit('close', 1000);

      expect(mockVoice.stop).toHaveBeenCalledWith('the client disconnected', 'disconnected');
      expect(service.voiceSocket).toBeNull();
    });

    it('leaves the session alone when another socket goes away', async () => {
      const owner = createMockWebSocket();
      await frame(owner, { type: 'voice_start', payload: {} });

      const other = createMockWebSocket();
      service.handleConnection(other, { url: '/api/ws', headers: { host: 'localhost:3003' } });
      other.emit('close', 1000);

      expect(mockVoice.stop).not.toHaveBeenCalled();
      expect(service.voiceSocket).toBe(owner);
    });
  });
});
