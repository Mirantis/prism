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

vi.mock('../../lib/llm-providers/bedrock/bedrock-provider', () => ({}));

vi.mock('../../lib/classification', () => ({
  getClassificationRequest: vi.fn(),
}));

vi.mock('@slack/bolt', () => ({
  App: vi.fn(),
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

// Import after all mocks
import { slackAdapterService } from '../slack-adapter.service';
import { slackChannelLabel } from '../../utils/slack-formatter';
import { SlackThreadProvider } from '../providers/slack-thread.provider';

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
  ...args: [
    string, string, string, string, string | undefined, string, typeof mockSay, string, string,
    Array<{ name?: string }>?,
  ]
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

      expect(mockConversationEngineService.chat).toHaveBeenCalled();
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

      // No mention detected -> top-level message -> not answered
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
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

    it('waits for the triggering message to be visible (Slack eventual consistency) before building context', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      const waitSpy = vi
        .spyOn(SlackThreadProvider.prototype, 'waitForExternalMessage')
        .mockResolvedValue(undefined);
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> what's the status?`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(waitSpy).toHaveBeenCalledWith('thread-001', MESSAGE_TS);
      // The wait must precede the engine call so context is built from a
      // consistent read.
      const waitOrder = waitSpy.mock.invocationCallOrder[0];
      const chatOrder = mockConversationEngineService.chat.mock.invocationCallOrder[0];
      expect(waitOrder).toBeLessThan(chatOrder);
    });

    it('stops with an error (does not build context) when the message never becomes visible', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      vi.spyOn(SlackThreadProvider.prototype, 'waitForExternalMessage').mockRejectedValue(
        new Error('Slack message 111.222 did not become visible'),
      );

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> what's the status?`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // The turn is aborted: the engine is never invoked, and the user is told.
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('did not become visible') }),
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

      // The gate is handed the message that arrived, so it judges that one
      // whatever the eventually-consistent Slack read returns.
      expect(isBotInThread).toHaveBeenCalledWith(CHANNEL_ID, THREAD_TS, TEAM_ID, {
        user: SLACK_USER_ID,
        text: 'just a follow-up',
        ts: MESSAGE_TS,
      });
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
    });

    it('hands the gate the shared-files description when the message carries only a file', async () => {
      const mapping = makeMapping();
      mockSlackMappingService.findByChannelId.mockResolvedValue(mapping);

      const isBotInThread = vi.fn().mockResolvedValue({
        result: { action: 'ignore' },
        messages: [],
      });
      (slackAdapterService as any).isBotInThread = isBotInThread;

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        '',
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID,
        [{ name: 'trace.log' }],
      );

      // An empty transcript line says nothing about the message; the file does.
      expect(isBotInThread).toHaveBeenCalledWith(CHANNEL_ID, THREAD_TS, TEAM_ID, {
        user: SLACK_USER_ID,
        text: '(shared a file: trace.log)',
        ts: MESSAGE_TS,
      });
    });
  });

  describe('Scenario: Thread messages without mention', () => {
    let reactionsAdd: ReturnType<typeof vi.fn>;
    let classifyThreadMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(makeMapping());
      reactionsAdd = vi.fn().mockResolvedValue({ ok: true });
      (slackAdapterService as any).apps = new Map([
        [TEAM_ID, { app: { client: { reactions: { add: reactionsAdd } } }, teamId: TEAM_ID }],
      ]);
      classifyThreadMessage = vi.fn();
      (slackAdapterService as any).classifyThreadMessage = classifyThreadMessage;
    });

    it('posts nothing and adds no reaction when the classifier ignores the reply', async () => {
      (slackAdapterService as any).isBotInThread = vi.fn().mockResolvedValue({
        result: { action: 'respond' },
        messages: [{ user: SLACK_USER_ID, text: 'thanks Dana, all sorted', ts: MESSAGE_TS }],
      });
      classifyThreadMessage.mockResolvedValue({ action: 'ignore' });

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'thanks Dana, all sorted',
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(classifyThreadMessage).toHaveBeenCalledOnce();
      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
    });

    it('reacts with eyes, without the classifier, to a reply that tags another person', async () => {
      (slackAdapterService as any).isBotInThread = vi.fn().mockResolvedValue({
        result: { action: 'react' },
        messages: [],
      });

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'thanks <@U_DANA>',
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(reactionsAdd).toHaveBeenCalledExactlyOnceWith({
        channel: CHANNEL_ID,
        timestamp: MESSAGE_TS,
        name: 'eyes',
      });
      expect(classifyThreadMessage).not.toHaveBeenCalled();
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
          // The channel name is forwarded so the engine can surface it to the LLM.
          metadata: expect.objectContaining({
            channel: 'slack',
            channelLabel: slackChannelLabel('general'),
          }),
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

  describe('Scenario: A six-hex message outside an unlinked channel is not a link code', () => {
    beforeEach(() => {
      (slackAdapterService as any).verifyAndLinkChannel = vi.fn();
    });

    it('answers a six-hex message in a linked channel on the normal path', async () => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(makeMapping());
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> cafe12`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect((slackAdapterService as any).verifyAndLinkChannel).not.toHaveBeenCalled();
      expect(mockSay).not.toHaveBeenCalled();
      expect(mockConversationEngineService.chat).toHaveBeenCalled();
    });

    it('queues a six-hex message in a heartbeat trigger channel for the heartbeat', async () => {
      mockSlackHeartbeatTriggerService.isHeartbeatTriggerChannel.mockResolvedValue({
        isTrigger: true,
        agentId: 'agent-001',
      });
      (slackAdapterService as any).throttledNotify = vi.fn().mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'cafe12',
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect((slackAdapterService as any).verifyAndLinkChannel).not.toHaveBeenCalled();
      expect(mockSay).not.toHaveBeenCalled();
      expect(mockSlackMessageQueueService.enqueue).toHaveBeenCalledWith(
        'agent-001',
        expect.objectContaining({ text: 'cafe12' }),
      );
    });
  });

  describe('Scenario: A rejected link code in an unlinked channel', () => {
    beforeEach(() => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(null);
      (slackAdapterService as any).verifyAndLinkChannel = vi
        .fn()
        .mockResolvedValue({ success: false, message: 'That code is not valid.' });
    });

    it('stays silent without a bot mention', async () => {
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'cafe12',
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect((slackAdapterService as any).verifyAndLinkChannel).toHaveBeenCalled();
      expect(mockSay).not.toHaveBeenCalled();
    });

    it('replies with the rejection when the bot is mentioned', async () => {
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> cafe12`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).toHaveBeenCalledWith('❌ That code is not valid.');
    });

    it('reads a code wrapped in Slack formatting and uppercases it', async () => {
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> *cafe12*`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect((slackAdapterService as any).verifyAndLinkChannel).toHaveBeenCalledWith(
        'CAFE12', CHANNEL_ID, SLACK_USER_ID, TEAM_ID,
      );
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

  describe('Scenario: Working indicator', () => {
    let reactionsAdd: ReturnType<typeof vi.fn>;
    let reactionsRemove: ReturnType<typeof vi.fn>;
    let setStatus: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSlackMappingService.findByChannelId.mockResolvedValue(makeMapping());
      mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
      mockConversationEngineService.chat.mockResolvedValue(undefined);
      vi.spyOn(SlackThreadProvider.prototype, 'waitForExternalMessage').mockResolvedValue(undefined);

      // Fake Bolt client so the indicator's reaction/status calls are observable.
      reactionsAdd = vi.fn().mockResolvedValue({ ok: true });
      reactionsRemove = vi.fn().mockResolvedValue({ ok: true });
      setStatus = vi.fn().mockResolvedValue({ ok: true });
      (slackAdapterService as any).apps = new Map([
        [TEAM_ID, {
          app: {
            client: {
              reactions: { add: reactionsAdd, remove: reactionsRemove },
              assistant: { threads: { setStatus } },
            },
          },
          teamId: TEAM_ID,
        }],
      ]);
    });

    it('sets the status before the consistency wait and never reacts when it renders', async () => {
      const waitSpy = vi
        .spyOn(SlackThreadProvider.prototype, 'waitForExternalMessage')
        .mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      // The immediate cue is the status call, issued before the (possibly
      // slow) read-consistency wait.
      expect(setStatus.mock.invocationCallOrder[0]).toBeLessThan(
        waitSpy.mock.invocationCallOrder[0],
      );
      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(reactionsRemove).not.toHaveBeenCalled();
    });

    it('falls back to the eyes reaction when the status cannot be set; removes it after', async () => {
      setStatus.mockRejectedValue(new Error('feature_not_enabled'));

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(reactionsAdd).toHaveBeenCalledExactlyOnceWith({
        channel: CHANNEL_ID,
        timestamp: MESSAGE_TS,
        name: 'eyes',
      });
      expect(reactionsRemove).toHaveBeenCalledExactlyOnceWith({
        channel: CHANNEL_ID,
        timestamp: MESSAGE_TS,
        name: 'eyes',
      });
      expect(reactionsRemove.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockConversationEngineService.chat.mock.invocationCallOrder[0],
      );
      expect(reactionsRemove.mock.invocationCallOrder[0]).toBeGreaterThan(
        reactionsAdd.mock.invocationCallOrder[0],
      );
    });

    it('attaches the status to the message ts for a top-level mention and clears it after', async () => {
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(setStatus).toHaveBeenCalledWith({
        channel_id: CHANNEL_ID,
        thread_ts: MESSAGE_TS,
        status: 'is thinking…',
      });
      expect(setStatus).toHaveBeenLastCalledWith({
        channel_id: CHANNEL_ID,
        thread_ts: MESSAGE_TS,
        status: '',
      });
    });

    it('attaches the status to the existing thread for a threaded mention', async () => {
      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> thoughts?`,
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: THREAD_TS, status: 'is thinking…' }),
      );
    });

    it('still clears the status when chat() rejects', async () => {
      mockConversationEngineService.chat.mockRejectedValue(new Error('LLM exploded'));

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('I encountered an error') }),
      );
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: '' }),
      );
      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(reactionsRemove).not.toHaveBeenCalled();
    });

    it('still removes the fallback reaction when chat() rejects', async () => {
      mockConversationEngineService.chat.mockRejectedValue(new Error('LLM exploded'));
      setStatus.mockRejectedValue(new Error('feature_not_enabled'));

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> hello`,
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('I encountered an error') }),
      );
      expect(reactionsAdd).toHaveBeenCalledOnce();
      expect(reactionsRemove).toHaveBeenCalledOnce();
    });

    it('shows no indicator on the classifier ignore path', async () => {
      (slackAdapterService as any).isBotInThread = vi.fn().mockResolvedValue({
        result: { action: 'ignore' },
        messages: [],
      });

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        'just a follow-up',
        THREAD_TS, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    });

    it('shows no indicator in a heartbeat trigger channel', async () => {
      mockSlackHeartbeatTriggerService.isHeartbeatTriggerChannel.mockResolvedValue({
        isTrigger: true,
        agentId: 'agent-001',
      });
      (slackAdapterService as any).throttledNotify = vi.fn().mockResolvedValue(undefined);

      await handleChannelMessage(
        CONNECTION_ID, CHANNEL_ID, SLACK_USER_ID,
        `<@${BOT_USER_ID}> heartbeat please`,
        undefined, MESSAGE_TS, mockSay, BOT_USER_ID, TEAM_ID
      );

      expect(mockSlackMessageQueueService.enqueue).toHaveBeenCalled();
      expect(reactionsAdd).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    });
  });
});
