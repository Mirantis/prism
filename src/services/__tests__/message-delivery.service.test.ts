/**
 * Message Delivery Service Tests
 *
 * Tests the unified message delivery system that handles
 * storing messages in the database and delivering to all channels.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationMessage } from '@prisma/client';
import { ChannelAdapter } from '../channel-adapter.interface';
import { MessageDeliveryService } from '../message-delivery.service';

// Mock conversation service
const mockAddMessage = vi.fn();
const mockGetOrCreateLatestThread = vi.fn();

// Mock attachment service (publish links + loads shared-file metadata)
const mockLinkToMessage = vi.fn();
const mockGetMetaByMessageIds = vi.fn();

const { mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

vi.mock('../conversation.service', () => ({
  conversationService: {
    addMessage: (...args: unknown[]) => mockAddMessage(...args),
    getOrCreateLatestThread: (...args: unknown[]) => mockGetOrCreateLatestThread(...args),
  },
}));

vi.mock('../attachment.service', () => ({
  attachmentService: {
    linkToMessage: (...args: unknown[]) => mockLinkToMessage(...args),
    getMetaByMessageIds: (...args: unknown[]) => mockGetMetaByMessageIds(...args),
  },
}));

// Helper to create a mock adapter
function createMockAdapter(name: string): ChannelAdapter & {
  deliver: ReturnType<typeof vi.fn>;
  isUserConnected: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    deliver: vi.fn().mockResolvedValue(undefined),
    isUserConnected: vi.fn().mockResolvedValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

// Sample message returned from DB
const sampleMessage: ConversationMessage = {
  id: 'msg-123',
  threadId: 'thread-456',
  role: 'AGENT',
  content: 'Hello from agent',
  triggeredBy: 'USER_INPUT',
  toolCalls: null,
  blocks: null,
  tokenCount: null,
  senderExternalId: null,
  senderName: null,
  isCompacted: false,
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

describe('MessageDeliveryService', () => {
  let service: MessageDeliveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create fresh service for each test
    service = new MessageDeliveryService();
    mockAddMessage.mockResolvedValue(sampleMessage);
    mockGetOrCreateLatestThread.mockResolvedValue({ id: 'thread-456' });
    mockLinkToMessage.mockResolvedValue(undefined);
    mockGetMetaByMessageIds.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('should register a channel adapter', () => {
      const adapter = createMockAdapter('test-channel');

      service.register(adapter);

      expect(service.getAdapters()).toHaveLength(1);
      expect(service.getAdapters()[0].name).toBe('test-channel');
    });

    it('should register multiple adapters', () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');

      service.register(adapter1);
      service.register(adapter2);

      expect(service.getAdapters()).toHaveLength(2);
    });
  });

  describe('publish', () => {
    it('should store message in database via conversationService', async () => {
      const adapter = createMockAdapter('test');
      service.register(adapter);

      await service.publish('user-123', 'thread-456', 'Hello', 'USER_INPUT');

      expect(mockAddMessage).toHaveBeenCalledWith('thread-456', {
        content: 'Hello',
        role: 'AGENT',
        triggeredBy: 'USER_INPUT',
        toolCalls: undefined,
        blocks: undefined,
      });
    });

    it('should store message with tool calls and blocks', async () => {
      const adapter = createMockAdapter('test');
      service.register(adapter);

      const toolCalls = [
        { tool: 'kubectl', input: 'get pods', output: 'pod list', success: true, timestamp: new Date().toISOString() },
      ];
      const blocks = [{ type: 'text', content: 'test' }];

      await service.publish('user-123', 'thread-456', 'Hello', 'HEARTBEAT', {
        toolCalls,
        blocks,
      });

      expect(mockAddMessage).toHaveBeenCalledWith('thread-456', {
        content: 'Hello',
        role: 'AGENT',
        triggeredBy: 'HEARTBEAT',
        toolCalls,
        blocks,
      });
    });

    it('broadcasts autonomous HEARTBEAT messages to connected adapters (no channelContext)', async () => {
      const adapter = createMockAdapter('test');
      adapter.isUserConnected.mockResolvedValue(true);
      service.register(adapter);

      // HEARTBEAT is the legitimate no-channelContext/broadcast path.
      mockAddMessage.mockResolvedValueOnce({ ...sampleMessage, triggeredBy: 'HEARTBEAT' });

      await service.publish('user-123', 'thread-456', 'Hello', 'HEARTBEAT');

      expect(adapter.isUserConnected).toHaveBeenCalledWith('user-123');
      expect(adapter.deliver).toHaveBeenCalledWith('user-123', expect.objectContaining({ triggeredBy: 'HEARTBEAT' }), undefined);
    });

    it('should not deliver to disconnected adapters', async () => {
      const adapter = createMockAdapter('test');
      adapter.isUserConnected.mockResolvedValue(false);
      service.register(adapter);

      mockAddMessage.mockResolvedValueOnce({ ...sampleMessage, triggeredBy: 'HEARTBEAT' });

      await service.publish('user-123', 'thread-456', 'Hello', 'HEARTBEAT');

      expect(adapter.isUserConnected).toHaveBeenCalledWith('user-123');
      expect(adapter.deliver).not.toHaveBeenCalled();
    });

    it('broadcasts to multiple adapters in parallel on HEARTBEAT', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.isUserConnected.mockResolvedValue(true);
      adapter2.isUserConnected.mockResolvedValue(true);

      service.register(adapter1);
      service.register(adapter2);

      mockAddMessage.mockResolvedValueOnce({ ...sampleMessage, triggeredBy: 'HEARTBEAT' });

      await service.publish('user-123', 'thread-456', 'Hello', 'HEARTBEAT');

      expect(adapter1.deliver).toHaveBeenCalled();
      expect(adapter2.deliver).toHaveBeenCalled();
    });

    it('should continue delivery even if one adapter fails', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.isUserConnected.mockResolvedValue(true);
      adapter1.deliver.mockRejectedValue(new Error('Delivery failed'));
      adapter2.isUserConnected.mockResolvedValue(true);

      service.register(adapter1);
      service.register(adapter2);

      mockAddMessage.mockResolvedValueOnce({ ...sampleMessage, triggeredBy: 'HEARTBEAT' });

      // Should not throw
      await service.publish('user-123', 'thread-456', 'Hello', 'HEARTBEAT');

      // Second adapter should still be called
      expect(adapter2.deliver).toHaveBeenCalled();
    });

    it('scopes USER_INPUT with slack channelContext to the slack adapter only (websocket skipped)', async () => {
      const slack = createMockAdapter('slack');
      const websocket = createMockAdapter('websocket');
      slack.isUserConnected.mockResolvedValue(true);
      websocket.isUserConnected.mockResolvedValue(true);

      service.register(slack);
      service.register(websocket);

      await service.publish('user-123', 'thread-456', 'Hi from Slack DM', 'USER_INPUT', {
        channelContext: {
          channel: 'slack',
          channelId: undefined,
          threadTs: undefined,
          threadId: 'thread-456',
          includeFeedback: true,
        },
      });

      expect(slack.deliver).toHaveBeenCalledWith(
        'user-123',
        sampleMessage,
        expect.objectContaining({ channel: 'slack', includeFeedback: true }),
      );
      expect(websocket.deliver).not.toHaveBeenCalled();
    });

    it('fails closed on USER_INPUT without channelContext (logs error, no adapter called)', async () => {
      const slack = createMockAdapter('slack');
      const websocket = createMockAdapter('websocket');
      slack.isUserConnected.mockResolvedValue(true);
      websocket.isUserConnected.mockResolvedValue(true);

      service.register(slack);
      service.register(websocket);

      await service.publish('user-123', 'thread-456', 'Hello', 'USER_INPUT');

      expect(slack.deliver).not.toHaveBeenCalled();
      expect(websocket.deliver).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('lacks channelContext'),
        expect.any(String),
        expect.any(String),
      );
    });

    it('links agent-shared files and delivers them with metadata', async () => {
      const websocket = createMockAdapter('websocket');
      websocket.isUserConnected.mockResolvedValue(true);
      service.register(websocket);

      const attachments = [
        { id: 'a1', filename: 'report.csv', mediaType: 'text/csv', sizeBytes: 12, category: 'text' as const },
      ];
      mockGetMetaByMessageIds.mockResolvedValue(new Map([['msg-123', attachments]]));

      await service.publish('user-123', 'thread-456', 'Here is your report', 'USER_INPUT', {
        attachmentIds: ['a1'],
        channelContext: { channel: 'websocket', threadId: 'thread-456' },
      });

      expect(mockLinkToMessage).toHaveBeenCalledWith(['a1'], 'msg-123', 'thread-456');
      expect(websocket.deliver).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ id: 'msg-123', attachments }),
        expect.objectContaining({ channel: 'websocket' }),
      );
    });

    it('does not touch the attachment service when no files are shared', async () => {
      const adapter = createMockAdapter('test');
      service.register(adapter);

      await service.publish('user-123', 'thread-456', 'Hello', 'USER_INPUT', {
        channelContext: { channel: 'test', threadId: 'thread-456' } as never,
      });

      expect(mockLinkToMessage).not.toHaveBeenCalled();
      expect(mockGetMetaByMessageIds).not.toHaveBeenCalled();
    });

    it('should return the persisted message', async () => {
      const adapter = createMockAdapter('test');
      service.register(adapter);

      const result = await service.publish('user-123', 'thread-456', 'Hello', 'USER_INPUT');

      expect(result).toEqual(sampleMessage);
    });

    it('should handle no registered adapters gracefully', async () => {
      // No adapters registered
      const result = await service.publish('user-123', 'thread-456', 'Hello', 'USER_INPUT');

      expect(result).toEqual(sampleMessage);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('No channel adapters registered')
      );
    });
  });

  describe('publishToLatestThread', () => {
    it('should get or create active thread and publish', async () => {
      const adapter = createMockAdapter('test');
      service.register(adapter);

      await service.publishToLatestThread('agent-123', 'user-123', 'Heartbeat message', 'HEARTBEAT');

      expect(mockGetOrCreateLatestThread).toHaveBeenCalledWith('agent-123', 'user-123');
      expect(mockAddMessage).toHaveBeenCalledWith('thread-456', expect.objectContaining({
        content: 'Heartbeat message',
        triggeredBy: 'HEARTBEAT',
      }));
    });

    it('should work with CRON_TASK trigger', async () => {
      const adapter = createMockAdapter('test');
      service.register(adapter);

      await service.publishToLatestThread('agent-123', 'user-123', 'Cron result', 'CRON_TASK');

      expect(mockAddMessage).toHaveBeenCalledWith('thread-456', expect.objectContaining({
        triggeredBy: 'CRON_TASK',
      }));
    });
  });

  describe('initializeAll', () => {
    it('should initialize all adapters', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');

      service.register(adapter1);
      service.register(adapter2);

      await service.initializeAll();

      expect(adapter1.initialize).toHaveBeenCalled();
      expect(adapter2.initialize).toHaveBeenCalled();
    });

    it('should continue initializing even if one fails', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.initialize.mockRejectedValue(new Error('Init failed'));

      service.register(adapter1);
      service.register(adapter2);

      await service.initializeAll();

      expect(adapter2.initialize).toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to initialize'),
        'channel-1',
        expect.any(String),
      );
    });
  });

  describe('shutdownAll', () => {
    it('should shutdown all adapters', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');

      service.register(adapter1);
      service.register(adapter2);

      await service.shutdownAll();

      expect(adapter1.shutdown).toHaveBeenCalled();
      expect(adapter2.shutdown).toHaveBeenCalled();
    });

    it('should continue shutting down even if one fails', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.shutdown.mockRejectedValue(new Error('Shutdown failed'));

      service.register(adapter1);
      service.register(adapter2);

      await service.shutdownAll();

      expect(adapter2.shutdown).toHaveBeenCalled();
    });
  });

  describe('isUserConnectedToAny', () => {
    it('should return true if any adapter has connection', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.isUserConnected.mockResolvedValue(false);
      adapter2.isUserConnected.mockResolvedValue(true);

      service.register(adapter1);
      service.register(adapter2);

      const result = await service.isUserConnectedToAny('user-123');

      expect(result).toBe(true);
    });

    it('should return false if no adapter has connection', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.isUserConnected.mockResolvedValue(false);
      adapter2.isUserConnected.mockResolvedValue(false);

      service.register(adapter1);
      service.register(adapter2);

      const result = await service.isUserConnectedToAny('user-123');

      expect(result).toBe(false);
    });

    it('should return false with no adapters', async () => {
      const result = await service.isUserConnectedToAny('user-123');

      expect(result).toBe(false);
    });

    it('should handle adapter errors gracefully', async () => {
      const adapter1 = createMockAdapter('channel-1');
      const adapter2 = createMockAdapter('channel-2');
      adapter1.isUserConnected.mockRejectedValue(new Error('Check failed'));
      adapter2.isUserConnected.mockResolvedValue(true);

      service.register(adapter1);
      service.register(adapter2);

      const result = await service.isUserConnectedToAny('user-123');

      expect(result).toBe(true);
    });
  });
});
