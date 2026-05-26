/**
 * Slack Channel Message Handler Tests
 *
 * Tests for handleChannelMessage covering:
 * - Mention detection on raw Slack text (before any resolution)
 * - Top-level messages: respond only when mentioned
 * - Thread messages: respond when mentioned, delegate to thread classification otherwise
 * - Bot mention stripping before sending to conversation engine
 * - Unlinked / misconfigured channel error prompts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (hoisted)
// ============================================================================

const {
  mockSlackMappingService,
  mockSlackHeartbeatTriggerService,
  mockSlackMessageQueueService,
  mockConversationService,
  mockConversationEngineService,
  mockChannelLearningQueue,
} = vi.hoisted(() => ({
  mockSlackMappingService: {
    findByChannelId: vi.fn(),
  },
  mockSlackHeartbeatTriggerService: {
    isHeartbeatTriggerChannel: vi.fn(),
  },
  mockSlackMessageQueueService: {
    enqueue: vi.fn(),
  },
  mockConversationService: {
    getOrCreateThreadByExternalId: vi.fn(),
  },
  mockConversationEngineService: {
    chat: vi.fn(),
  },
  mockChannelLearningQueue: {
    add: vi.fn(),
  },
}));

vi.mock('../slack-mapping.service', () => ({
  slackMappingService: mockSlackMappingService,
}));

vi.mock('../slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: mockSlackHeartbeatTriggerService,
}));

vi.mock('../slack-message-queue.service', () => ({
  slackMessageQueueService: mockSlackMessageQueueService,
}));

vi.mock('../conversation.service', () => ({
  conversationService: mockConversationService,
}));

vi.mock('../conversation-engine.service', () => ({
  conversationEngineService: mockConversationEngineService,
}));

vi.mock('../../queues/channel-learning.queue', () => ({
  channelLearningQueue: mockChannelLearningQueue,
}));

vi.mock('../../queues/slack-heartbeat-throttle-queue', () => ({
  getSlackHeartbeatThrottleQueue: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: {
    conversationThread: { findUnique: vi.fn() },
    slackThreadParticipant: { upsert: vi.fn() },
  },
}));

vi.mock('../../lib/backend-client', () => ({
  backendClient: {},
}));

vi.mock('../../lib/bedrock-provider', () => ({
  isBedrockConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('../../lib/classification', () => ({
  getClassificationModel: vi.fn(),
}));

vi.mock('@slack/bolt', () => ({
  App: vi.fn(),
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

// Import after all mocks
import { slackAdapterService } from '../slack-adapter.service';

// ============================================================================
// Test Helpers
// ============================================================================

const BOT_USER_ID = 'U_BOT_123';
const SLACK_USER_ID = 'U_HUMAN_456';
const CHANNEL_ID = 'C_CHAN_789';
const TEAM_ID = 'T_TEAM_001';
const CONNECTION_ID = 'conn-001';
const MESSAGE_TS = '1710000001.000000';
const THREAD_TS = '1710000000.000000';

const mockSay = vi.fn();

function makeMapping(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-001',
    lensUserId: 'lens-user-001',
    slackChannelName: 'general',
    connection: { teamId: TEAM_ID },
    ...overrides,
  };
}

// Access private method for testing
function handleChannelMessage(
  ...args: [string, string, string, string, string | undefined, string, typeof mockSay, string, string]
) {
  return (slackAdapterService as any).handleChannelMessage(...args);
}

// ============================================================================
// Tests
// ============================================================================

describe('Requirement: Channel message mention detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not a heartbeat trigger channel
    mockSlackHeartbeatTriggerService.isHeartbeatTriggerChannel.mockResolvedValue({ isTrigger: false });
    // Stub internal methods that hit Slack API
    (slackAdapterService as any).getUserInfo = vi.fn().mockResolvedValue({ real_name: 'Alice', name: 'alice' });
    (slackAdapterService as any).getChannelName = vi.fn().mockResolvedValue('general');
    (slackAdapterService as any).resolveMentions = vi.fn().mockImplementation(async (text: string) => text);
  });

  describe('Scenario: Mention detection uses raw Slack text', () => {
    it('should detect bot mention in raw <@BOT_ID> format', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      // Raw Slack format: <@U_BOT_123> hello
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // Should have responded (not queued for learning)
      expect(mockConversationEngineService.chat).toHaveBeenCalled();
      expect(mockChannelLearningQueue.add).not.toHaveBeenCalled();
    });

    it('should NOT detect mention if bot ID was already replaced with a display name', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);

      // If someone were to resolve mentions first, the text would look like this:
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        '@PrismBot hello',
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // No mention detected -> top-level message -> queued for learning, not responded
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
      expect(mockChannelLearningQueue.add).toHaveBeenCalled();
    });

    it('should detect mention anywhere in the message text', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `hey <@${BOT_USER_ID}> can you help?`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockConversationEngineService.chat).toHaveBeenCalled();
    });
  });

  describe('Scenario: Top-level messages (no thread)', () => {
    it('should ignore top-level messages without a mention', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'just chatting here',
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
      expect(mockChannelLearningQueue.add).toHaveBeenCalled();
    });

    it('should respond to top-level messages with a mention', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> what's the status?`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockConversationEngineService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-001',
          userId: 'lens-user-001',
          threadId: 'thread-001',
        })
      );
    });
  });

  describe('Scenario: Thread messages with mention bypass thread classification', () => {
    it('should respond immediately to thread messages when mentioned (skip isBotInThread)', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      const isBotInThread = vi.fn();
      (slackAdapterService as any).isBotInThread = isBotInThread;

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> thoughts on this?`,
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // Mentioned -> skips isBotInThread entirely
      expect(isBotInThread).not.toHaveBeenCalled();
      expect(mockConversationEngineService.chat).toHaveBeenCalled();
    });

    it('should check isBotInThread for thread messages without mention', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);

      const isBotInThread = vi.fn().mockResolvedValue({
        result: { action: 'ignore' },
        messages: [],
      });
      (slackAdapterService as any).isBotInThread = isBotInThread;

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'just a follow-up',
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(isBotInThread).toHaveBeenCalledWith(CHANNEL_ID, THREAD_TS, TEAM_ID);
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Bot mention is stripped before sending to LLM', () => {
    it('should strip <@BOT_ID> from the message text sent to conversation engine', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      // resolveMentions passes through for this test
      (slackAdapterService as any).resolveMentions = vi.fn().mockImplementation(async (text: string) => text);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> what's the weather?`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockConversationEngineService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `<@${SLACK_USER_ID}:Alice>: what's the weather?`,
        })
      );
    });

    it('should strip multiple bot mentions', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);
      (slackAdapterService as any).resolveMentions = vi.fn().mockImplementation(async (text: string) => text);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hey <@${BOT_USER_ID}> help`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // Both mentions stripped; interior whitespace preserved (only outer .trim())
      expect(mockConversationEngineService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `<@${SLACK_USER_ID}:Alice>: hey  help`,
        })
      );
    });

    it('should call resolveMentions on the text after bot mention is stripped', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      const resolveMentions = vi.fn().mockResolvedValue('cc @Alice help');
      (slackAdapterService as any).resolveMentions = resolveMentions;

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> cc <@U_ALICE> help`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // resolveMentions receives the text with bot mention already stripped
      expect(resolveMentions).toHaveBeenCalledWith('cc <@U_ALICE> help', TEAM_ID);
      // Final message sent to engine is the resolved output, prefixed with
      // the sender's <@USERID:Name> tag.
      expect(mockConversationEngineService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `<@${SLACK_USER_ID}:Alice>: cc @Alice help`,
        })
      );
    });
  });

  describe('Scenario: Unlinked channel prompts user when mentioned', () => {
    it('should prompt to link when mentioned in an unlinked channel', async () => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(null);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).toHaveBeenCalledWith(expect.stringContaining('not activated'));
    });

    it('should silently ignore unlinked channel messages without mention', async () => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(null);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'hello everyone',
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).not.toHaveBeenCalled();
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Missing lensUserId on mapping', () => {
    it('should warn when mentioned in a channel with incomplete mapping', async () => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(
        makeMapping({ lensUserId: null })
      );

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> help`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).toHaveBeenCalledWith(expect.stringContaining('incomplete configuration'));
    });

    it('should silently ignore when not mentioned in a channel with incomplete mapping', async () => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(
        makeMapping({ lensUserId: null })
      );

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'just chatting',
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).not.toHaveBeenCalled();
    });
  });
});
