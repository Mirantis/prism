/**
 * Teams Adapter Service Tests — posting to a linked target
 *
 * Covers listLinkedTargets and postToTarget: the mention entity that makes
 * Teams notify, the membership refusal that names the person, and the
 * threaded send. The SDK is mocked at the module boundary; addMention mirrors
 * the SDK's entity shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetTeamsConfig, mockApp } = vi.hoisted(() => ({
  mockPrisma: { teamsMapping: { findMany: vi.fn() } },
  mockGetTeamsConfig: vi.fn(),
  mockApp: {
    send: vi.fn(),
    reply: vi.fn(),
    api: { conversations: { getMemberById: vi.fn() } },
  },
}));

vi.mock('@microsoft/teams.apps', () => ({ App: class {}, ExpressAdapter: class {} }));
vi.mock('@microsoft/teams.api', () => ({
  MessageActivityInput: class MockMessageActivityInput {
    type = 'message';
    entities: Array<Record<string, unknown>> = [];
    constructor(public readonly text: string) {}
    addMention(account: { name?: string }, options: { addText?: boolean; text?: string } = {}) {
      const text = options.text || account.name;
      this.entities.push({ type: 'mention', mentioned: account, text: `<at>${text}</at>` });
      return this;
    }
  },
  TypingActivityInput: class {},
  stripMentionsText: vi.fn(),
}));
vi.mock('../../../lib/prisma', () => ({ default: mockPrisma, prisma: mockPrisma }));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../../../lib/teams-config', () => ({ getTeamsConfig: mockGetTeamsConfig }));
vi.mock('../teams-mapping.service', () => ({ teamsMappingService: {} }));
vi.mock('../../conversation.service', () => ({ conversationService: {} }));
vi.mock('../../conversation-engine.service', () => ({ conversationEngineService: {} }));
vi.mock('../../thread-reply-classifier.service', () => ({
  threadReplyClassifierService: {},
  THREAD_TRANSCRIPT_LINES: 10,
}));
vi.mock('../../../config', () => ({ config: { agentId: 'agent-1' } }));
vi.mock('../../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { teamsAdapterService } from '../teams-adapter.service';
import { LinkedTarget, SendRefusedError } from '../../channel-adapter.interface';

const ALICE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BOB = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const RELEASE: LinkedTarget = {
  key: 'teams:19:release@thread.tacv2',
  platform: 'teams',
  kind: 'channel',
  conversationId: '19:release@thread.tacv2',
  name: 'Release',
  isMain: false,
};

function notFound(): Error {
  return Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
}

describe('Requirement: the agent posts only to its linked Teams targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    teamsAdapterService.__resetForTests();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (teamsAdapterService as any).app = mockApp;
    mockApp.send.mockResolvedValue({ id: '1712345678901' });
    mockApp.reply.mockResolvedValue({ id: '1712345678999' });
    mockApp.api.conversations.getMemberById.mockImplementation(async (_conversationId: string, id: string) => {
      if (id === ALICE) return { id: '29:alice', name: 'Alice Example', aadObjectId: ALICE };
      throw notFound();
    });
  });

  describe('Scenario: listing the linked targets', () => {
    it("lists each linked channel and DM of this agent, and marks the main channel", async () => {
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { channelConversationId: '19:general@thread.tacv2', channelName: 'General', isMainChannel: false },
        { channelConversationId: '19:release@thread.tacv2', channelName: 'Release', isMainChannel: true },
        { dmConversationId: 'a:personal-chat', teamsUserId: ALICE, lensUserId: 'user-1', isMainChannel: false },
      ]);

      const targets = await teamsAdapterService.listLinkedTargets('agent-1');

      expect(mockPrisma.teamsMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agentId: 'agent-1' } }),
      );
      expect(targets).toEqual([
        { key: 'teams:19:general@thread.tacv2', platform: 'teams', kind: 'channel', conversationId: '19:general@thread.tacv2', name: 'General', isMain: false },
        { key: 'teams:19:release@thread.tacv2', platform: 'teams', kind: 'channel', conversationId: '19:release@thread.tacv2', name: 'Release', isMain: true },
        { key: 'teams:a:personal-chat', platform: 'teams', kind: 'dm', conversationId: 'a:personal-chat', name: `<@${ALICE}>`, isMain: false, dmUserId: 'user-1' },
      ]);
    });
  });

  describe('Scenario: posting a message with a mention', () => {
    it('sends the text with an <at> tag and a matching mention entity, and returns the message id', async () => {
      const result = await teamsAdapterService.postToTarget(
        RELEASE,
        `Release v2 is out. <@${ALICE}:Alice> please announce it.`,
      );

      expect(result).toEqual({ messageId: '1712345678901' });
      expect(mockApp.api.conversations.getMemberById).toHaveBeenCalledWith('19:release@thread.tacv2', ALICE);
      const [conversationId, activity] = mockApp.send.mock.calls[0];
      expect(conversationId).toBe('19:release@thread.tacv2');
      expect(activity.text).toBe('Release v2 is out. <at>Alice Example</at> please announce it.');
      expect(activity.entities).toEqual([
        {
          type: 'mention',
          mentioned: { id: '29:alice', name: 'Alice Example', role: 'user' },
          text: '<at>Alice Example</at>',
        },
      ]);
    });

    it('adds one entity for a person mentioned twice', async () => {
      await teamsAdapterService.postToTarget(RELEASE, `<@${ALICE}> and again <@${ALICE}>`);

      const activity = mockApp.send.mock.calls[0][1];
      expect(activity.text).toBe('<at>Alice Example</at> and again <at>Alice Example</at>');
      expect(activity.entities).toHaveLength(1);
    });

    it('replies into a reply chain of the channel', async () => {
      const result = await teamsAdapterService.postToTarget(RELEASE, 'Follow-up', '1712345678901');

      expect(mockApp.reply).toHaveBeenCalledWith('19:release@thread.tacv2', '1712345678901', expect.anything());
      expect(mockApp.send).not.toHaveBeenCalled();
      expect(result).toEqual({ messageId: '1712345678999' });
    });

    it('removes an <at> tag the agent wrote, which has no entity behind it', async () => {
      await teamsAdapterService.postToTarget(RELEASE, 'Hello <at>General</at> team');

      const activity = mockApp.send.mock.calls[0][1];
      expect(activity.text).toBe('Hello General team');
      expect(activity.entities).toEqual([]);
    });
  });

  describe('Scenario: refusals', () => {
    it('refuses a mention of a person outside the conversation and names the person', async () => {
      const send = teamsAdapterService.postToTarget(RELEASE, `Ping <@${BOB}:Bob Example>`);

      await expect(send).rejects.toBeInstanceOf(SendRefusedError);
      await expect(send).rejects.toThrow(`Bob Example (<@${BOB}>) is not a member of #Release`);
      expect(mockApp.send).not.toHaveBeenCalled();
    });

    it.each([
      ['a Bot Framework id', '<@29:1abc:Bob>'],
      ['a Slack id', '<@U0ALICE>'],
      ['an empty id', '<@>'],
    ])('refuses %s, which is not a Teams user mention', async (_label, token) => {
      await expect(teamsAdapterService.postToTarget(RELEASE, `Ping ${token}`)).rejects.toThrow(
        'is not a Teams user mention',
      );
      expect(mockApp.send).not.toHaveBeenCalled();
    });

    it('passes a member lookup that fails for another reason on to the caller', async () => {
      mockApp.api.conversations.getMemberById.mockRejectedValue(new Error('socket hang up'));

      await expect(teamsAdapterService.postToTarget(RELEASE, `Ping <@${ALICE}>`)).rejects.toThrow('socket hang up');
    });

    it('refuses a thread id that is not a Teams message id', async () => {
      await expect(teamsAdapterService.postToTarget(RELEASE, 'Hi', '1712345678.000100')).rejects.toThrow(
        'is not a Teams thread id',
      );
    });

    it('refuses a thread id on a personal chat, which has no threads', async () => {
      const dm: LinkedTarget = { ...RELEASE, key: 'teams:a:personal-chat', kind: 'dm', conversationId: 'a:personal-chat' };

      await expect(teamsAdapterService.postToTarget(dm, 'Hi', '1712345678901')).rejects.toThrow('has no threads');
      expect(mockApp.reply).not.toHaveBeenCalled();
    });

    it('refuses when Teams is not connected', async () => {
      teamsAdapterService.__resetForTests();

      await expect(teamsAdapterService.postToTarget(RELEASE, 'Hi')).rejects.toThrow('Microsoft Teams is not connected');
    });

    it('passes a failed send on to the caller', async () => {
      mockApp.send.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));

      await expect(teamsAdapterService.postToTarget(RELEASE, 'Hi')).rejects.toThrow('Forbidden');
    });
  });
});
