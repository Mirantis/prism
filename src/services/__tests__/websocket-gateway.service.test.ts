/**
 * WebSocket Gateway Service Tests (Agent-Runtime)
 *
 * Tests for WebSocketGatewayService covering:
 * - Connection management
 * - Message handling (chat, ping)
 * - Message modes (steer, followup, collect)
 * - Notification delivery
 * - Authentication (JWT decode, no verification — backend already verified)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that are available before vi.mock hoisting
const { mockChat, mockConfig } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockConfig: {
    agentId: undefined as string | undefined,
    ownerUserId: '00000000-0000-0000-0000-000000000001',
  },
}));

vi.mock('../conversation-engine.service', () => ({
  conversationEngineService: {
    chat: mockChat,
  },
}));

vi.mock('../../config', () => ({
  config: mockConfig,
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

    // Default mock responses
    mockChat.mockResolvedValue(undefined);
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
    it('should process steer mode messages', async () => {
      const userId = 'user-123';
      const ws = createMockWebSocket();
      ws.userId = userId;
      ws.readyState = 1;

      service.connections.set(userId, [ws]);

      await service.handleChatMessage(ws, userId, {
        type: 'chat',
        mode: 'steer',
        content: 'Stop!',
        agentId: 'agent-123',
      });

      expect(mockChat).toHaveBeenCalled();
    });

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
        agentId: 'agent-123',
      });

      const queue = service.messageQueues.get(userId);
      expect(queue).toHaveLength(1);
      expect(queue[0].message.content).toBe('Queued message');
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

    it('accepts a message when agentId matches (auth is handled by Nexus inbound routing)', async () => {
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
});
