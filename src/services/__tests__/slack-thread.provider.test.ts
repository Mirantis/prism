/**
 * Slack Thread Provider Tests
 *
 * Tests for SlackThreadProvider covering:
 * - Message fetching from Slack API
 * - Message mapping to ConversationMessage format
 * - Role detection (bot vs user)
 * - User name resolution
 * - Pagination handling
 * - Error cases (missing thread metadata, no Slack app, no mapping)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../config', () => ({
  config: {},
}));

const { mockPrisma, mockGetSlackConnection } = vi.hoisted(() => ({
  mockPrisma: {
    conversationThread: {
      findUnique: vi.fn(),
    },
    slackMapping: {
      findFirst: vi.fn(),
    },
    conversationMessage: {
      findMany: vi.fn(),
    },
  },
  mockGetSlackConnection: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
}));

vi.mock('../../lib/slack-source', () => ({
  getSlackConnection: mockGetSlackConnection,
  getActiveSlackConnections: vi.fn(),
}));

const mockConversationsReplies = vi.fn();
const mockUsersInfo = vi.fn();

const mockGetAppForTeam = vi.fn();

vi.mock('../slack-adapter.service', () => ({
  slackAdapterService: {
    getAppForTeam: (...args: unknown[]) => mockGetAppForTeam(...args),
  },
}));

// Import after mocking
import { SlackThreadProvider } from '../providers/slack-thread.provider';

beforeEach(() => {
  mockGetSlackConnection.mockReset();
});

// ============================================================================
// Test Setup
// ============================================================================

const threadId = 'thread-001';
const channelId = 'C12345';
const threadTs = '1710000000.000000';
const teamId = 'T_TEAM1';
const botUserId = 'B001';

function setupMockApp() {
  mockGetAppForTeam.mockReturnValue({
    app: {
      client: {
        conversations: { replies: mockConversationsReplies },
        users: { info: mockUsersInfo },
      },
    },
    botUserId,
    teamId,
    teamName: 'Test Workspace',
    isSocketMode: true,
  });
}

function setupThreadMetadata() {
  mockPrisma.conversationThread.findUnique.mockResolvedValue({
    externalChannelId: channelId,
    externalThreadId: threadTs,
  });

  mockPrisma.slackMapping.findFirst.mockResolvedValue({
    connectionId: 'conn-001',
  });

  mockGetSlackConnection.mockResolvedValue({
    id: 'conn-001',
    teamId,
    botUserId,
    isActive: true,
  });
}

describe('Requirement: Slack Thread Provider', () => {
  let provider: SlackThreadProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SlackThreadProvider();
    setupMockApp();
    setupThreadMetadata();
    mockPrisma.conversationMessage.findMany.mockResolvedValue([]);
  });

  describe('Scenario: Basic message fetching', () => {
    it('should fetch and map Slack thread messages', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Hello bot', ts: '1710000001.000000' },
          { user: botUserId, text: 'Hi there!', ts: '1710000002.000000' },
          { user: 'U100', text: 'Can you help?', ts: '1710000003.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: 'Alice', name: 'alice' },
      });

      const messages = await provider.getMessages(threadId);

      expect(messages).toHaveLength(3);

      // First message: user
      expect(messages[0].role).toBe('USER');
      expect(messages[0].content).toBe('<@U100:Alice>: Hello bot');
      expect(messages[0].senderName).toBe('Alice');
      expect(messages[0].senderExternalId).toBe('U100');

      // Second message: bot
      expect(messages[1].role).toBe('AGENT');
      expect(messages[1].content).toBe('Hi there!');
      expect(messages[1].senderName).toBeNull();

      // Third message: user
      expect(messages[2].role).toBe('USER');
      expect(messages[2].content).toBe('<@U100:Alice>: Can you help?');
    });

    it('should call conversations.replies with correct parameters', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [],
        response_metadata: {},
      });

      await provider.getMessages(threadId);

      expect(mockConversationsReplies).toHaveBeenCalledWith({
        channel: channelId,
        ts: threadTs,
        limit: 200,
      });
    });
  });

  describe('Scenario: Recent messages with limit', () => {
    it('should return only the last N messages', async () => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        user: 'U100',
        text: `Message ${i}`,
        ts: `171000000${i}.000000`,
      }));

      mockConversationsReplies.mockResolvedValue({
        messages,
        response_metadata: {},
      });
      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      const result = await provider.getRecentMessages(threadId, 3);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('<@U100:Alice>: Message 7');
      expect(result[1].content).toBe('<@U100:Alice>: Message 8');
      expect(result[2].content).toBe('<@U100:Alice>: Message 9');
    });
  });

  describe('Scenario: Bot detection', () => {
    it('should treat other bots as USER, not AGENT', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U_OTHER', bot_id: 'B_SOMETHING', text: 'Other bot message', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: 'Some Bot', name: 'somebot' },
      });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].role).toBe('USER');
      expect(messages[0].senderName).toBe('Some Bot');
    });

    it('should detect our bot by matching botUserId', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: botUserId, text: 'Agent message', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].role).toBe('AGENT');
      expect(messages[0].senderName).toBeNull();
    });
  });

  describe('Scenario: Pagination', () => {
    it('should paginate through multiple pages of replies', async () => {
      mockConversationsReplies
        .mockResolvedValueOnce({
          messages: [
            { user: 'U100', text: 'Page 1', ts: '1710000001.000000' },
          ],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          messages: [
            { user: 'U100', text: 'Page 2', ts: '1710000002.000000' },
          ],
          response_metadata: {},
        });

      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      const messages = await provider.getMessages(threadId);

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('<@U100:Alice>: Page 1');
      expect(messages[1].content).toBe('<@U100:Alice>: Page 2');
      expect(mockConversationsReplies).toHaveBeenCalledTimes(2);
      expect(mockConversationsReplies).toHaveBeenNthCalledWith(2, expect.objectContaining({
        cursor: 'cursor_page2',
      }));
    });
  });

  describe('Scenario: Deterministic IDs', () => {
    it('should generate consistent IDs for the same thread+ts', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Hello', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });
      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      const messages1 = await provider.getMessages(threadId);
      const messages2 = await provider.getMessages(threadId);

      expect(messages1[0].id).toBe(messages2[0].id);
    });
  });

  describe('Scenario: User name resolution', () => {
    it('should resolve user names via Slack API', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Hello', ts: '1710000001.000000' },
          { user: 'U200', text: 'World', ts: '1710000002.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo
        .mockResolvedValueOnce({ user: { real_name: 'Alice', name: 'alice' } })
        .mockResolvedValueOnce({ user: { real_name: 'Bob', name: 'bob' } });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].senderName).toBe('Alice');
      expect(messages[1].senderName).toBe('Bob');
    });

    it('should include sender name in message content for LLM context', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Hello bot', ts: '1710000001.000000' },
          { user: botUserId, text: 'Hi there!', ts: '1710000002.000000' },
          { user: 'U200', text: 'Can I join?', ts: '1710000003.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo
        .mockImplementation(async ({ user }: { user: string }) => {
          const users: Record<string, { real_name: string; name: string }> = {
            U100: { real_name: 'Alice', name: 'alice' },
            U200: { real_name: 'Bob', name: 'bob' },
          };
          return { user: users[user] || undefined };
        });

      const messages = await provider.getMessages(threadId);

      // User messages should have sender name prepended (matching conversation engine format)
      expect(messages[0].content).toBe('<@U100:Alice>: Hello bot');
      expect(messages[2].content).toBe('<@U200:Bob>: Can I join?');

      // Agent messages should NOT have sender name prepended
      expect(messages[1].content).toBe('Hi there!');
    });

    it('should not prepend sender name for messages without a user', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { text: 'System message with no user', ts: '1710000001.000000' },
          { user: undefined, text: 'Another system message', ts: '1710000002.000000' },
        ],
        response_metadata: {},
      });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].content).toBe('System message with no user');
      expect(messages[1].content).toBe('Another system message');
    });

    it('should not prepend sender name for messages with empty text', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: '', ts: '1710000001.000000' },
          { user: 'U100', ts: '1710000002.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].content).toBe('');
      expect(messages[1].content).toBe('');
    });

    it('should fall back to user ID when API fails', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Hello', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockRejectedValue(new Error('API error'));

      const messages = await provider.getMessages(threadId);

      expect(messages[0].senderName).toBe('U100');
    });
  });

  describe('Scenario: Mention enrichment in message bodies', () => {
    it('rewrites <@U…> tokens inside message text to the combined <@U…:Name> form', async () => {
      // Alice (the sender) mentions Bob in her message body. The provider
      // should enrich the body's <@U_BOB> token using the same users.info
      // lookup that resolves the sender's name, so the agent sees the
      // canonical marker for everyone referenced in the conversation.
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'hey <@U200> can you take a look?', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockImplementation(async ({ user }: { user: string }) => {
        if (user === 'U100') return { user: { real_name: 'Alice' } };
        if (user === 'U200') return { user: { real_name: 'Bob' } };
        throw new Error(`unexpected user ${user}`);
      });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].content).toBe('<@U100:Alice>: hey <@U200:Bob> can you take a look?');
    });

    it('collects sender and mention IDs in a single batch (one users.info call per unique ID)', async () => {
      // Sender U100 mentions U200 once, then U200 mentions back. There are
      // exactly two unique IDs across senders + mentions; users.info must
      // be called exactly twice — no N+1.
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'ping <@U200>', ts: '1710000001.000000' },
          { user: 'U200', text: 'sup <@U100>', ts: '1710000002.000000' },
          { user: 'U100', text: 'thanks <@U200>', ts: '1710000003.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockImplementation(async ({ user }: { user: string }) => {
        if (user === 'U100') return { user: { real_name: 'Alice' } };
        if (user === 'U200') return { user: { real_name: 'Bob' } };
        throw new Error(`unexpected user ${user}`);
      });

      const messages = await provider.getMessages(threadId);

      expect(mockUsersInfo).toHaveBeenCalledTimes(2);
      const lookedUp = mockUsersInfo.mock.calls.map((c) => c[0].user).sort();
      expect(lookedUp).toEqual(['U100', 'U200']);

      expect(messages[0].content).toBe('<@U100:Alice>: ping <@U200:Bob>');
      expect(messages[1].content).toBe('<@U200:Bob>: sup <@U100:Alice>');
      expect(messages[2].content).toBe('<@U100:Alice>: thanks <@U200:Bob>');
    });

    it('sanitizes display names containing reserved marker characters', async () => {
      // Names with `<`, `>`, `:`, or control chars would break the
      // <@USERID:Name> regex consumers rely on. The provider must strip
      // them before embedding the name in the marker.
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'UEVE', text: 'hello', ts: '1710000001.000000' },
          { user: 'U100', text: 'morning <@UEVE>', ts: '1710000002.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockImplementation(async ({ user }: { user: string }) => {
        if (user === 'UEVE') return { user: { real_name: 'Eve: <evil>' } };
        if (user === 'U100') return { user: { real_name: 'Alice' } };
        throw new Error(`unexpected user ${user}`);
      });

      const messages = await provider.getMessages(threadId);

      // Reserved chars stripped from BOTH the sender prefix and the
      // enriched mention inside the body.
      expect(messages[0].content).toBe('<@UEVE:Eve evil>: hello');
      expect(messages[1].content).toBe('<@U100:Alice>: morning <@UEVE:Eve evil>');
    });

    it('leaves unresolved <@U…> mentions in the body as bare tokens', async () => {
      // If users.info fails for an ID mentioned inside the body, we should
      // NOT emit a malformed `<@U_X:>` marker — just leave the bare
      // `<@U_X>` token in place. The sender's name still resolves; the
      // body mention degrades gracefully.
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'who is <@UUNKNOWN> again?', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      mockUsersInfo.mockImplementation(async ({ user }: { user: string }) => {
        if (user === 'U100') return { user: { real_name: 'Alice' } };
        // UUNKNOWN throws — getUserInfo / resolveUserNames swallows.
        throw new Error('user_not_found');
      });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].content).toBe('<@U100:Alice>: who is <@UUNKNOWN> again?');
    });
  });

  describe('Scenario: Timestamp to Date conversion', () => {
    it('should convert Slack ts to JavaScript Date', async () => {
      const ts = '1710000000.000000'; // 2024-03-09T16:00:00.000Z
      mockConversationsReplies.mockResolvedValue({
        messages: [{ user: 'U100', text: 'Hello', ts }],
        response_metadata: {},
      });
      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      const messages = await provider.getMessages(threadId);

      expect(messages[0].createdAt).toEqual(new Date(1710000000 * 1000));
    });
  });

  describe('Scenario: Error handling', () => {
    it('should throw when thread is missing externalChannelId', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalChannelId: null,
        externalThreadId: threadTs,
      });

      await expect(provider.getMessages(threadId)).rejects.toThrow(
        /missing externalChannelId/
      );
    });

    it('should throw when thread is missing externalThreadId', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalChannelId: channelId,
        externalThreadId: null,
      });

      await expect(provider.getMessages(threadId)).rejects.toThrow(
        /missing externalChannelId or externalThreadId/
      );
    });

    it('should throw when no SlackMapping found for channel', async () => {
      mockPrisma.slackMapping.findFirst.mockResolvedValue(null);

      await expect(provider.getMessages(threadId)).rejects.toThrow(
        /No SlackMapping found/
      );
    });

    it('should throw when no Slack app found for team', async () => {
      mockGetAppForTeam.mockReturnValue(undefined);

      await expect(provider.getMessages(threadId)).rejects.toThrow(
        /No Slack app found/
      );
    });
  });

  describe('Scenario: Tool call enrichment from database', () => {
    const sampleToolCalls = [
      { tool: 'search', input: '{"query":"test"}', output: '{"results":[]}', success: true, timestamp: '2024-03-09T16:00:02Z' },
    ];

    it('should enrich agent messages with tool calls when externalMessageId matches', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Search for test', ts: '1710000001.000000' },
          { user: botUserId, text: 'Here are the results', ts: '1710000002.000000' },
        ],
        response_metadata: {},
      });
      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      mockPrisma.conversationMessage.findMany.mockResolvedValue([
        { externalMessageId: '1710000002.000000', toolCalls: sampleToolCalls },
      ]);

      const messages = await provider.getMessages(threadId);

      expect(messages[1].role).toBe('AGENT');
      expect(messages[1].toolCalls).toEqual(sampleToolCalls);
    });

    it('should leave user messages unchanged', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Hello', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });
      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      mockPrisma.conversationMessage.findMany.mockResolvedValue([
        { externalMessageId: '1710000001.000000', toolCalls: sampleToolCalls },
      ]);

      const messages = await provider.getMessages(threadId);

      expect(messages[0].role).toBe('USER');
      expect(messages[0].toolCalls).toBeNull();
    });

    it('should not enrich when no DB records have tool calls', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: botUserId, text: 'Plain response', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      const messages = await provider.getMessages(threadId);

      expect(messages[0].role).toBe('AGENT');
      expect(messages[0].toolCalls).toBeNull();
    });

    it('should not enrich when externalMessageId does not match', async () => {
      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: botUserId, text: 'Response', ts: '1710000001.000000' },
        ],
        response_metadata: {},
      });

      mockPrisma.conversationMessage.findMany.mockResolvedValue([
        { externalMessageId: '9999999999.000000', toolCalls: sampleToolCalls },
      ]);

      const messages = await provider.getMessages(threadId);

      expect(messages[0].toolCalls).toBeNull();
    });

    it('should handle multiple agent messages with different tool calls', async () => {
      const toolCalls1 = [{ tool: 'search', input: '{}', output: '{}', success: true, timestamp: '2024-03-09T16:00:01Z' }];
      const toolCalls2 = [{ tool: 'deploy', input: '{}', output: '{}', success: true, timestamp: '2024-03-09T16:00:03Z' }];

      mockConversationsReplies.mockResolvedValue({
        messages: [
          { user: 'U100', text: 'Do search', ts: '1710000001.000000' },
          { user: botUserId, text: 'Search results', ts: '1710000002.000000' },
          { user: 'U100', text: 'Now deploy', ts: '1710000003.000000' },
          { user: botUserId, text: 'Deployed', ts: '1710000004.000000' },
        ],
        response_metadata: {},
      });
      mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

      mockPrisma.conversationMessage.findMany.mockResolvedValue([
        { externalMessageId: '1710000002.000000', toolCalls: toolCalls1 },
        { externalMessageId: '1710000004.000000', toolCalls: toolCalls2 },
      ]);

      const messages = await provider.getMessages(threadId);

      expect(messages[1].toolCalls).toEqual(toolCalls1);
      expect(messages[3].toolCalls).toEqual(toolCalls2);
    });
  });
});

