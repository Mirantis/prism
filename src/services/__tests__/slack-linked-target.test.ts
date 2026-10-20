/**
 * Slack Adapter Service Tests — posting to a linked target
 *
 * Covers listLinkedTargets (the agent's linked channels and DMs) and
 * postToTarget (the agent-initiated post): mention validation, the
 * membership refusal that names the person, and the post itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetSlackConnection, mockSlackMappingService } = vi.hoisted(() => ({
  mockPrisma: {
    slackMapping: { findMany: vi.fn() },
  },
  mockGetSlackConnection: vi.fn(),
  mockSlackMappingService: {
    getActiveUserMappingsWithDmChannel: vi.fn(),
    findByChannelId: vi.fn(),
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../lib/slack-source', () => ({
  getSlackConnection: mockGetSlackConnection,
  getActiveSlackConnections: vi.fn(),
}));
vi.mock('../slack-mapping.service', () => ({ slackMappingService: mockSlackMappingService }));
vi.mock('../slack-heartbeat-trigger.service', () => ({ slackHeartbeatTriggerService: {} }));
vi.mock('../slack-message-queue.service', () => ({ slackMessageQueueService: {} }));
vi.mock('../heartbeat.service', () => ({ heartbeatService: {} }));
vi.mock('../conversation.service', () => ({ conversationService: { setExternalId: vi.fn() } }));
vi.mock('../conversation-engine.service', () => ({ conversationEngineService: {} }));
vi.mock('../../queues/slack-heartbeat-throttle-queue', () => ({
  getSlackHeartbeatThrottleQueue: vi.fn(),
}));
vi.mock('../../lib/llm-providers/bedrock/bedrock-provider', () => ({}));
vi.mock('@slack/bolt', () => ({
  App: class {},
  LogLevel: { INFO: 'info', WARN: 'warn' },
}));
vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: vi.fn(),
  isTelemetryEnabled: () => false,
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({ config: {} }));

import { slackAdapterService } from '../slack-adapter.service';
import { conversationService } from '../conversation.service';
import { LinkedTarget, SendRefusedError } from '../channel-adapter.interface';

const RELEASE: LinkedTarget = {
  key: 'slack:C0RELEASE',
  platform: 'slack',
  kind: 'channel',
  conversationId: 'C0RELEASE',
  name: 'release',
  isMain: false,
};

function mapping(fields: Record<string, unknown>) {
  return {
    slackChannelId: null,
    slackChannelName: null,
    dmChannelId: null,
    isMainChannel: false,
    ...fields,
  };
}

describe('Requirement: the agent posts only to its linked Slack targets', () => {
  const client = {
    chat: { postMessage: vi.fn() },
    conversations: { members: vi.fn() },
    users: { info: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSlackConnection.mockResolvedValue({ id: 'conn-1', teamId: 'T1', teamName: 'Test', isActive: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (slackAdapterService as any).apps = new Map([
      ['T1', { app: { client }, teamId: 'T1', teamName: 'Test', isSocketMode: true, botUserId: 'UBOT' }],
    ]);
    client.chat.postMessage.mockResolvedValue({ ok: true, ts: '1712345678.000100' });
    client.conversations.members.mockResolvedValue({ members: ['UBOT', 'U0ALICE'] });
    client.users.info.mockResolvedValue({ user: { real_name: 'Bob Example' } });
  });

  describe('Scenario: listing the linked targets', () => {
    it('lists each linked channel and DM of this agent, and marks the main channel', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        mapping({ slackChannelId: 'C0GENERAL', slackChannelName: 'general' }),
        mapping({ slackChannelId: 'C0RELEASE', slackChannelName: 'release' }),
        mapping({ dmChannelId: 'D0OWNER', slackUserId: 'U0OWNER', lensUserId: 'user-1' }),
      ]);

      const targets = await slackAdapterService.listLinkedTargets('agent-1');

      expect(mockPrisma.slackMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agentId: 'agent-1' } }),
      );
      expect(targets).toEqual([
        { key: 'slack:C0GENERAL', platform: 'slack', kind: 'channel', conversationId: 'C0GENERAL', name: 'general', isMain: true },
        { key: 'slack:C0RELEASE', platform: 'slack', kind: 'channel', conversationId: 'C0RELEASE', name: 'release', isMain: false },
        { key: 'slack:D0OWNER', platform: 'slack', kind: 'dm', conversationId: 'D0OWNER', name: '<@U0OWNER>', isMain: false, dmUserId: 'user-1' },
      ]);
    });

    it('marks the flagged channel as main instead of the oldest', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        mapping({ slackChannelId: 'C0GENERAL', slackChannelName: 'general' }),
        mapping({ slackChannelId: 'C0RELEASE', slackChannelName: 'release', isMainChannel: true }),
      ]);

      const targets = await slackAdapterService.listLinkedTargets('agent-1');

      expect(targets.map((t) => [t.conversationId, t.isMain])).toEqual([
        ['C0GENERAL', false],
        ['C0RELEASE', true],
      ]);
    });
  });

  describe('Scenario: the posted message in the stored history', () => {
    const DM: LinkedTarget = {
      key: 'slack:D0OWNER',
      platform: 'slack',
      kind: 'dm',
      conversationId: 'D0OWNER',
      name: '<@U0OWNER>',
      isMain: false,
      dmUserId: 'user-1',
    };

    it('names the DM thread for a top-level DM post, keyed as the inbound DM path keys it', async () => {
      const result = await slackAdapterService.postToTarget(DM, 'The deploy failed. Shall I roll back?');

      expect(result).toEqual({ messageId: '1712345678.000100', history: { userId: 'user-1', threadKey: 'D0OWNER' } });
    });

    it('names no stored thread for a channel post or a DM thread post, which Slack holds', async () => {
      expect(await slackAdapterService.postToTarget(RELEASE, 'Hi')).toEqual({ messageId: '1712345678.000100' });
      expect(await slackAdapterService.postToTarget(DM, 'Hi', '1712345678.000001')).toEqual({
        messageId: '1712345678.000100',
      });
    });
  });

  describe('Scenario: posting a message with a mention', () => {
    it('posts into the channel with the mention rewritten to the bare form, and returns the ts', async () => {
      const result = await slackAdapterService.postToTarget(
        RELEASE,
        'Release v2 is out. <@U0ALICE:Alice Example> please announce it.',
      );

      expect(result).toEqual({ messageId: '1712345678.000100' });
      const call = client.chat.postMessage.mock.calls[0][0];
      expect(call.channel).toBe('C0RELEASE');
      expect(call.thread_ts).toBeUndefined();
      expect(call.text).toBe('Release v2 is out. <@U0ALICE> please announce it.');
      expect(JSON.stringify(call.blocks)).toContain('<@U0ALICE>');
    });

    it('posts into a thread of the channel', async () => {
      await slackAdapterService.postToTarget(RELEASE, 'Follow-up', '1712345678.000100');

      expect(client.chat.postMessage.mock.calls[0][0].thread_ts).toBe('1712345678.000100');
    });

    it('binds no conversation thread to the Slack thread it posts into', async () => {
      await slackAdapterService.postToTarget(RELEASE, 'Follow-up', '1712345678.000100');

      expect(conversationService.setExternalId).not.toHaveBeenCalled();
    });

    it('reads every page of the member list', async () => {
      client.conversations.members
        .mockResolvedValueOnce({ members: ['UBOT'], response_metadata: { next_cursor: 'page-2' } })
        .mockResolvedValueOnce({ members: ['U0ALICE'], response_metadata: { next_cursor: '' } });

      await slackAdapterService.postToTarget(RELEASE, 'Hi <@U0ALICE>');

      expect(client.conversations.members).toHaveBeenCalledTimes(2);
      expect(client.conversations.members.mock.calls[1][0].cursor).toBe('page-2');
      expect(client.chat.postMessage).toHaveBeenCalled();
    });

    it('reads no member list when the text has no mention', async () => {
      await slackAdapterService.postToTarget(RELEASE, 'Plain note');

      expect(client.conversations.members).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: reply delivery shares the mention pattern', () => {
    it('rewrites a Slack user mention and leaves a token with another id as written', async () => {
      mockSlackMappingService.findByChannelId.mockResolvedValue({ connection: { teamId: 'T1' } });
      client.users.info.mockResolvedValue({ user: { real_name: 'Alice Example' } });

      await slackAdapterService.deliverToChannel('C0RELEASE', 'Hi <@U0ALICE:Alice>, see <@ the docs> later', 'thread-1');

      expect(client.chat.postMessage.mock.calls[0][0].text).toBe('Hi <@U0ALICE>, see <@ the docs> later');
      expect(client.users.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scenario: refusals', () => {
    it('refuses a mention of a person outside the channel and names the person', async () => {
      const send = slackAdapterService.postToTarget(RELEASE, 'Ping <@U0BOB>');

      await expect(send).rejects.toBeInstanceOf(SendRefusedError);
      await expect(send).rejects.toThrow('Bob Example (<@U0BOB>) is not a member of #release');
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('names the person by the name in the token when Slack does not know the id', async () => {
      client.users.info.mockRejectedValue(new Error('user_not_found'));

      await expect(slackAdapterService.postToTarget(RELEASE, 'Ping <@U0GHOST:Ghost Example>')).rejects.toThrow(
        'Ghost Example (<@U0GHOST>) is not a member of #release',
      );
    });

    it.each([
      ['a labelled mention', '<@U0ALICE|alice>'],
      ['a Teams id', '<@0f8fad5b-d9cb-469f-a165-70867728950e>'],
      ['a lower-case id', '<@u0alice>'],
      ['an empty id', '<@>'],
    ])('refuses %s, which is not a Slack user mention', async (_label, token) => {
      await expect(slackAdapterService.postToTarget(RELEASE, `Ping ${token}`)).rejects.toThrow(
        'is not a Slack user mention',
      );
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['<!channel>', 'Heads up <!channel>'],
      ['<!here> with a label', 'Heads up <!here|here>'],
      ['<!everyone>', 'Hi <!everyone>'],
      ['a user group', 'Heads up <!subteam^S0TEAM|@release-team>'],
    ])('refuses a special mention: %s', async (_label, text) => {
      const send = slackAdapterService.postToTarget(RELEASE, text);

      await expect(send).rejects.toBeInstanceOf(SendRefusedError);
      await expect(send).rejects.toThrow('notifies a whole channel or a user group');
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.conversations.members).not.toHaveBeenCalled();
    });

    it('refuses a thread id that is not a Slack ts', async () => {
      await expect(slackAdapterService.postToTarget(RELEASE, 'Hi', 'not-a-ts')).rejects.toThrow(
        'is not a Slack thread id',
      );
    });

    it('names the missing scope when Slack refuses to list the members', async () => {
      client.conversations.members.mockRejectedValue(
        Object.assign(new Error('An API error occurred: missing_scope'), { data: { error: 'missing_scope' } }),
      );

      await expect(slackAdapterService.postToTarget(RELEASE, 'Ping <@U0ALICE>')).rejects.toThrow(
        'it needs the channels:read scope',
      );
    });

    it('waits for the boot to connect Slack before it sends', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = slackAdapterService as any;
      const connected = adapter.apps;
      adapter.apps = new Map();
      let connect: () => void = () => {};
      adapter.started = new Promise<void>((resolve) => {
        connect = () => {
          adapter.apps = connected;
          resolve();
        };
      });

      const send = slackAdapterService.postToTarget(RELEASE, 'Hi');
      // The send reads the connection and asks for the app before the boot connects.
      await new Promise((resolve) => setTimeout(resolve, 0));
      connect();

      await expect(send).resolves.toEqual({ messageId: '1712345678.000100' });
      adapter.started = Promise.resolve();
    });

    it('refuses when Slack is not connected', async () => {
      mockGetSlackConnection.mockResolvedValue(null);

      await expect(slackAdapterService.postToTarget(RELEASE, 'Hi')).rejects.toThrow('Slack is not connected');
    });

    it('passes a failed post on to the caller', async () => {
      client.chat.postMessage.mockRejectedValue(new Error('An API error occurred: not_in_channel'));

      await expect(slackAdapterService.postToTarget(RELEASE, 'Hi')).rejects.toThrow('not_in_channel');
    });
  });
});
