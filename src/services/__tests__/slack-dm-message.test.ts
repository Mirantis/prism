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

vi.mock('../../lib/llm-providers/bedrock/bedrock-provider', () => ({
  isBedrockConfigured: vi.fn().mockReturnValue(false),
}));

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

describe('Slack DM working indicator', () => {
  let reactionsAdd: ReturnType<typeof vi.fn>;
  let reactionsRemove: ReturnType<typeof vi.fn>;
  let setStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSlackMappingService.findUserMapping.mockResolvedValue({
      id: 'map-1',
      lensUserId: LENS_USER,
      agentId: AGENT_ID,
      dmChannelId: DM_CHANNEL,
    });
    mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-001' });
    mockConversationEngineService.chat.mockResolvedValue(undefined);

    (slackAdapterService as any).resolveMentions = vi.fn().mockImplementation(async (t: string) => t);
    (slackAdapterService as any).getUserInfo = vi.fn().mockResolvedValue({ real_name: 'Alice', name: 'alice' });
    (slackAdapterService as any).downloadSlackFiles = vi.fn().mockResolvedValue({ attachmentIds: [], failures: [] });

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

  it('adds the eyes reaction before chat() and removes it after; top-level DM never sets a status', async () => {
    await handleDmMessage(undefined);

    expect(reactionsAdd).toHaveBeenCalledExactlyOnceWith({
      channel: DM_CHANNEL,
      timestamp: MESSAGE_TS,
      name: 'eyes',
    });
    expect(reactionsRemove).toHaveBeenCalledExactlyOnceWith({
      channel: DM_CHANNEL,
      timestamp: MESSAGE_TS,
      name: 'eyes',
    });
    expect(reactionsAdd.mock.invocationCallOrder[0]).toBeLessThan(
      mockConversationEngineService.chat.mock.invocationCallOrder[0],
    );
    expect(reactionsRemove.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockConversationEngineService.chat.mock.invocationCallOrder[0],
    );
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('sets the thread status for a threaded DM and clears it after the turn', async () => {
    await handleDmMessage(THREAD_TS);

    expect(setStatus).toHaveBeenCalledWith({
      channel_id: DM_CHANNEL,
      thread_ts: THREAD_TS,
      status: 'is thinking…',
    });
    expect(setStatus).toHaveBeenLastCalledWith({
      channel_id: DM_CHANNEL,
      thread_ts: THREAD_TS,
      status: '',
    });
    // The status rendered, so the fallback reaction never fires.
    expect(reactionsAdd).not.toHaveBeenCalled();
    expect(reactionsRemove).not.toHaveBeenCalled();
  });

  it('falls back to the eyes reaction in a threaded DM when the status cannot be set', async () => {
    setStatus.mockRejectedValue(new Error('feature_not_enabled'));

    await handleDmMessage(THREAD_TS);

    expect(reactionsAdd).toHaveBeenCalledExactlyOnceWith({
      channel: DM_CHANNEL,
      timestamp: MESSAGE_TS,
      name: 'eyes',
    });
    expect(reactionsRemove).toHaveBeenCalledExactlyOnceWith({
      channel: DM_CHANNEL,
      timestamp: MESSAGE_TS,
      name: 'eyes',
    });
  });

  it('still clears the status when chat() rejects', async () => {
    mockConversationEngineService.chat.mockRejectedValue(new Error('LLM exploded'));

    await handleDmMessage(THREAD_TS);

    expect(mockSay).toHaveBeenCalledWith(expect.stringContaining('I encountered an error'));
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: '' }),
    );
    expect(reactionsAdd).not.toHaveBeenCalled();
    expect(reactionsRemove).not.toHaveBeenCalled();
  });

  it('still removes the fallback reaction when chat() rejects', async () => {
    mockConversationEngineService.chat.mockRejectedValue(new Error('LLM exploded'));
    setStatus.mockRejectedValue(new Error('feature_not_enabled'));

    await handleDmMessage(THREAD_TS);

    expect(mockSay).toHaveBeenCalledWith(expect.stringContaining('I encountered an error'));
    expect(reactionsAdd).toHaveBeenCalledOnce();
    expect(reactionsRemove).toHaveBeenCalledOnce();
    // The clear is still attempted, even though setStatus keeps failing.
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: '' }),
    );
  });

  it('removes the reaction when the message is steered into a live turn', async () => {
    mockConversationEngineService.chat.mockResolvedValue({ steered: true });

    await handleDmMessage(undefined);

    expect(reactionsAdd).toHaveBeenCalledOnce();
    expect(reactionsRemove).toHaveBeenCalledOnce();
    expect(mockSay).not.toHaveBeenCalled();
  });

  it('renders the running tool in the status line via onToolEvent', async () => {
    mockConversationEngineService.chat.mockImplementation(async (input: any) => {
      input.onToolEvent({ type: 'started', toolName: 'kubectl' });
      return undefined;
    });

    await handleDmMessage(THREAD_TS);

    expect(setStatus).toHaveBeenCalledWith({
      channel_id: DM_CHANNEL,
      thread_ts: THREAD_TS,
      status: 'is running kubectl…',
    });
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: '' }),
    );
  });

  it('sends no loading_messages — Slack rotates its own default phrases', async () => {
    // Deliberate omission (see setAssistantStatus): with no loading_messages,
    // Slack's Agents & AI Apps surface rotates its built-in phrases
    // ("Gathering information…", …). Write-only on Slack's side, so the
    // payload shape is pinned here.
    await handleDmMessage(THREAD_TS);

    expect(setStatus).toHaveBeenCalled();
    for (const [payload] of setStatus.mock.calls) {
      expect(payload).not.toHaveProperty('loading_messages');
    }
  });

  it('never shows the indicator for a verification code or an unlinked user', async () => {
    (slackAdapterService as any).verifyDmLinkCode = vi
      .fn()
      .mockResolvedValue({ success: true, message: 'linked' });
    (slackAdapterService as any).rebuildUserCache = vi.fn().mockResolvedValue(undefined);
    await handleDmMessage(undefined, 'ABC123');
    expect(reactionsAdd).not.toHaveBeenCalled();

    mockSlackMappingService.findUserMapping.mockResolvedValue(null);
    await handleDmMessage(undefined);
    expect(reactionsAdd).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
