/**
 * Slack DM Handler Tests
 *
 * Covers handleDmMessage behavior after the DM-isolation fix:
 * - Top-level DM: resolve a ConversationThread keyed by dmChannelId (no
 *   channelId option, so threadSource stays DATABASE); do NOT fall through to
 *   getOrCreateLatestThread (that's webchat's ACTIVE-thread path).
 * - Threaded DM: resolve a ConversationThread keyed by thread_ts and pass
 *   { channelId: dmChannelId } so threadSource flips to SLACK.
 * - chat(...) receives the resolved threadId and slackThreadTs metadata.
 * - Unlinked Slack user: no thread resolved, no chat, link-account prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (hoisted)
// ============================================================================

const {
  mockSlackMappingService,
  mockConversationService,
  mockConversationEngineService,
} = vi.hoisted(() => ({
  mockSlackMappingService: {
    findUserMapping: vi.fn(),
    updateDmChannelId: vi.fn(),
  },
  mockConversationService: {
    getOrCreateThreadByExternalId: vi.fn(),
    getOrCreateLatestThread: vi.fn(),
  },
  mockConversationEngineService: {
    chat: vi.fn(),
  },
}));

vi.mock('../slack-mapping.service', () => ({
  slackMappingService: mockSlackMappingService,
}));

vi.mock('../conversation.service', () => ({
  conversationService: mockConversationService,
}));

vi.mock('../conversation-engine.service', () => ({
  conversationEngineService: mockConversationEngineService,
}));

vi.mock('../slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: { isHeartbeatTriggerChannel: vi.fn() },
}));

vi.mock('../slack-message-queue.service', () => ({
  slackMessageQueueService: { enqueue: vi.fn() },
}));

vi.mock('../../queues/channel-learning.queue', () => ({
  channelLearningQueue: { add: vi.fn() },
}));

vi.mock('../../queues/slack-heartbeat-throttle-queue', () => ({
  getSlackHeartbeatThrottleQueue: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: {
    slackVerificationCode: { findUnique: vi.fn() },
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

// Import after mocks
import { slackAdapterService } from '../slack-adapter.service';

// ============================================================================
// Helpers
// ============================================================================

const SLACK_USER = 'U_HUMAN_123';
const DM_CHANNEL = 'D_DMCHAN_456';
const TEAM_ID = 'T_TEAM_001';
const CONN_ID = 'conn-001';
const LENS_USER = 'lens-user-1';
const AGENT_ID = 'agent-xyz';
const MESSAGE_TS = '1710000002.000000';
const THREAD_TS = '1710000000.000000';

const mockSay = vi.fn();

// Access private method for testing.
function handleDmMessage(threadTs?: string, text = 'hello there') {
  return (slackAdapterService as any).handleDmMessage(
    CONN_ID,
    SLACK_USER,
    text,
    DM_CHANNEL,
    mockSay,
    TEAM_ID,
    MESSAGE_TS,
    threadTs,
  );
}

describe('Slack DM handler (DM isolation + threading)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Slack user is linked to a Lens user + agent, with a stored DM channel.
    mockSlackMappingService.findUserMapping.mockResolvedValue({
      id: 'map-1',
      lensUserId: LENS_USER,
      agentId: AGENT_ID,
      dmChannelId: DM_CHANNEL,
    });

    mockConversationService.getOrCreateThreadByExternalId.mockImplementation(
      async (_userId: string, _agentId: string, externalThreadId: string) => ({
        id: `thread-for-${externalThreadId}`,
      }),
    );

    // Stub adapter internals that would otherwise hit the Slack API.
    (slackAdapterService as any).resolveMentions = vi
      .fn()
      .mockImplementation(async (t: string) => t);
    (slackAdapterService as any).getUserInfo = vi
      .fn()
      .mockResolvedValue({ real_name: 'Alice', name: 'alice' });
    (slackAdapterService as any).downloadSlackFiles = vi
      .fn()
      .mockResolvedValue({ attachmentIds: [], failures: [] });
  });

  it('top-level DM resolves a thread keyed by dmChannelId with NO channelId option (threadSource stays DATABASE)', async () => {
    await handleDmMessage(undefined);

    expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith(
      LENS_USER,
      AGENT_ID,
      DM_CHANNEL,
      undefined,
    );
    // Must NOT fall through to the webchat ACTIVE thread.
    expect(mockConversationService.getOrCreateLatestThread).not.toHaveBeenCalled();
  });

  it('top-level DM forwards threadId to chat() and leaves slackThreadTs undefined', async () => {
    await handleDmMessage(undefined);

    expect(mockConversationEngineService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: LENS_USER,
        agentId: AGENT_ID,
        threadId: `thread-for-${DM_CHANNEL}`,
        metadata: { channel: 'slack', slackThreadTs: undefined },
      }),
    );
  });

  it('threaded DM resolves a thread keyed by thread_ts and passes { channelId: dmChannelId } so threadSource flips to SLACK', async () => {
    await handleDmMessage(THREAD_TS);

    expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith(
      LENS_USER,
      AGENT_ID,
      THREAD_TS,
      { channelId: DM_CHANNEL },
    );
    expect(mockConversationService.getOrCreateLatestThread).not.toHaveBeenCalled();

    expect(mockConversationEngineService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: `thread-for-${THREAD_TS}`,
        metadata: { channel: 'slack', slackThreadTs: THREAD_TS },
      }),
    );
  });

  it('does not resolve a DM thread when the Slack user is unlinked', async () => {
    mockSlackMappingService.findUserMapping.mockResolvedValue(null);

    await handleDmMessage(undefined);

    expect(mockConversationService.getOrCreateThreadByExternalId).not.toHaveBeenCalled();
    expect(mockConversationEngineService.chat).not.toHaveBeenCalled();
    expect(mockSay).toHaveBeenCalled(); // emits the link-account prompt
  });
});
