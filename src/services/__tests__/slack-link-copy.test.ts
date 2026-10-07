/**
 * Slack Linking Copy Tests
 *
 * Pins the text a user reads while linking a Slack account or channel, on the
 * live adapter path: the DM code handler (`handleDmMessage`) and the channel
 * code handler (`handleChannelMessage`). A rename that misses one of these
 * strings fails here instead of shipping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (hoisted)
// ============================================================================

const { mockPrisma, mockSlackMappingService } = vi.hoisted(() => ({
  mockPrisma: {
    slackVerificationCode: { findUnique: vi.fn(), delete: vi.fn() },
    slackMapping: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockSlackMappingService: {
    findUserMapping: vi.fn(),
    findByChannelId: vi.fn(),
  },
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
}));

vi.mock('../slack-mapping.service', () => ({
  slackMappingService: mockSlackMappingService,
}));

vi.mock('../conversation.service', () => ({
  conversationService: { getOrCreateThreadByExternalId: vi.fn() },
}));

vi.mock('../conversation-engine.service', () => ({
  conversationEngineService: { chat: vi.fn() },
}));

vi.mock('../slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: {
    isHeartbeatTriggerChannel: vi.fn().mockResolvedValue({ isTrigger: false }),
  },
}));

vi.mock('../slack-message-queue.service', () => ({
  slackMessageQueueService: { enqueue: vi.fn() },
}));


vi.mock('../../queues/slack-heartbeat-throttle-queue', () => ({
  getSlackHeartbeatThrottleQueue: vi.fn(),
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

// Import after mocks
import { slackAdapterService } from '../slack-adapter.service';

// ============================================================================
// Helpers
// ============================================================================

const CONN_ID = 'conn-001';
const AGENT_ID = 'agent-001';
const LENS_USER = 'lens-user-1';
const SLACK_USER = 'U_HUMAN_123';
const DM_CHANNEL = 'D_DMCHAN_456';
const CHANNEL_ID = 'C_CHAN_789';
const TEAM_ID = 'T_TEAM_001';
const MESSAGE_TS = '1710000001.000000';
const CODE = 'ABC123';

function verificationCode(type: 'DM' | 'CHANNEL', overrides: Record<string, unknown> = {}) {
  return {
    id: 'vc-001',
    code: CODE,
    type,
    lensUserId: LENS_USER,
    connectionId: CONN_ID,
    agentId: AGENT_ID,
    agentName: 'Nova',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

// Access private methods for testing.
function handleDmMessage(say: ReturnType<typeof vi.fn>, text = CODE) {
  return (slackAdapterService as any).handleDmMessage(
    CONN_ID,
    SLACK_USER,
    text,
    DM_CHANNEL,
    say,
    TEAM_ID,
    MESSAGE_TS,
    undefined,
  );
}

function handleChannelMessage(say: ReturnType<typeof vi.fn>, text = CODE) {
  return (slackAdapterService as any).handleChannelMessage(
    CONN_ID,
    CHANNEL_ID,
    SLACK_USER,
    text,
    undefined,
    MESSAGE_TS,
    say,
    'U_BOT_123',
    TEAM_ID,
  );
}

/** The single text posted back by the handler under test. */
function postedText(say: ReturnType<typeof vi.fn>): string {
  expect(say).toHaveBeenCalledTimes(1);
  return say.mock.calls[0][0] as string;
}

// ============================================================================
// Tests
// ============================================================================

describe('Slack DM linking copy', () => {
  let say: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    say = vi.fn().mockResolvedValue(undefined);
    mockPrisma.$transaction.mockResolvedValue([]);
    mockPrisma.slackVerificationCode.delete.mockResolvedValue({});
    mockPrisma.slackMapping.findFirst.mockResolvedValue(null);
    (slackAdapterService as any).rebuildUserCache = vi.fn().mockResolvedValue(undefined);
  });

  it('names the agent on success', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(verificationCode('DM'));

    await handleDmMessage(say);

    expect(postedText(say)).toBe(
      '✅ Your Slack account is now linked. You can chat with Nova here.',
    );
  });

  it('falls back to "your agent" when the code carries no agent name', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(
      verificationCode('DM', { agentName: null }),
    );

    await handleDmMessage(say);

    expect(postedText(say)).toBe(
      '✅ Your Slack account is now linked. You can chat with your agent here.',
    );
  });

  it('reports an invalid code', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(null);

    await handleDmMessage(say);

    expect(postedText(say)).toBe(
      '❌ That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.',
    );
  });

  it('reports an expired code', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(
      verificationCode('DM', { expiresAt: new Date(Date.now() - 60 * 1000) }),
    );

    await handleDmMessage(say);

    expect(postedText(say)).toBe(
      '❌ That code has expired. Generate a new code in Prism Agent, under Settings → Channels.',
    );
  });

  it('reports a Slack account already linked to another user', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(verificationCode('DM'));
    mockPrisma.slackMapping.findFirst.mockResolvedValue({
      id: 'mapping-other',
      connectionId: CONN_ID,
      slackUserId: SLACK_USER,
      lensUserId: 'lens-user-999',
      agentId: AGENT_ID,
    });

    await handleDmMessage(say);

    expect(postedText(say)).toBe(
      '❌ This Slack account is already linked to another Prism Agent user.',
    );
  });

  it('prompts an unlinked user to link a Prism Agent account', async () => {
    mockSlackMappingService.findUserMapping.mockResolvedValue(null);

    await handleDmMessage(say, 'hello there');

    expect(postedText(say)).toBe(
      "👋 Hi! I don't recognize you yet.\n\n" +
        'To link your Prism Agent account:\n' +
        '1. Go to *Settings → Channels* in the web app\n' +
        '2. Click *Link Account* under Slack\n' +
        '3. Send me the 6-character code you receive',
    );
  });
});

describe('Slack channel linking copy', () => {
  let say: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    say = vi.fn().mockResolvedValue(undefined);
    mockPrisma.$transaction.mockResolvedValue([]);
    mockPrisma.slackVerificationCode.delete.mockResolvedValue({});
    mockPrisma.slackMapping.findUnique.mockResolvedValue(null);
    (slackAdapterService as any).getChannelName = vi.fn().mockResolvedValue('general');
  });

  it('confirms the channel link without naming the agent', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(verificationCode('CHANNEL'));

    await handleChannelMessage(say);

    expect(postedText(say)).toBe(
      '✅ Your Slack channel is now linked. Mention me anytime you need help!',
    );
  });

  it('uses the same wording as the DM path for an invalid code', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(null);

    await handleChannelMessage(say);

    expect(postedText(say)).toBe(
      '❌ That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.',
    );
  });

  it('uses the same wording as the DM path for an expired code', async () => {
    mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(
      verificationCode('CHANNEL', { expiresAt: new Date(Date.now() - 60 * 1000) }),
    );

    await handleChannelMessage(say);

    expect(postedText(say)).toBe(
      '❌ That code has expired. Generate a new code in Prism Agent, under Settings → Channels.',
    );
  });
});
