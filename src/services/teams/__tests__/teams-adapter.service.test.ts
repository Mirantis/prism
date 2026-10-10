/**
 * Teams Adapter Service Tests
 *
 * The Teams SDK is mocked at the module boundary: tests drive the adapter
 * through its public surface (initialize/deliver/shutdown) and through the
 * captured `message` route handler, exactly the way the SDK would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type MessageHandler = (ctx: {
  activity: Record<string, unknown>;
  send: (activity: unknown) => Promise<unknown>;
}) => Promise<void>;

const {
  mockAppState,
  mockPrisma,
  mockTeamsMappingService,
  mockConversationService,
  mockChat,
  mockClassify,
  mockReadInboundFiles,
  mockTrackEvent,
  mockGetTeamsConfig,
} = vi.hoisted(() => {
  const mockAppState: {
    instances: Array<{
      options: Record<string, unknown>;
      handlers: Map<string, MessageHandler>;
      initialize: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      reply: ReturnType<typeof vi.fn>;
      api: { teams: { getConversations: ReturnType<typeof vi.fn> } };
    }>;
    failNextInitialize: boolean;
  } = { instances: [], failNextInitialize: false };
  return {
    mockAppState,
    mockPrisma: {
      conversationThread: { findUnique: vi.fn() },
      teamsMapping: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      teamsVerificationCode: {
        findUnique: vi.fn(),
        delete: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    mockTeamsMappingService: {
      findUserMapping: vi.fn(),
      findByConversationId: vi.fn(),
      updateDmConversationId: vi.fn(),
      countAllMappings: vi.fn(),
      getMainChannel: vi.fn(),
    },
    mockConversationService: {
      getOrCreateThreadByExternalId: vi.fn(),
      findThreadByExternalId: vi.fn(),
      getRecentMessages: vi.fn(),
      addMessage: vi.fn(),
    },
    mockChat: vi.fn(),
    mockClassify: vi.fn(),
    mockReadInboundFiles: vi.fn(),
    mockTrackEvent: vi.fn(),
    mockGetTeamsConfig: vi.fn(),
  };
});

vi.mock('@microsoft/teams.apps', () => ({
  App: class MockApp {
    options: Record<string, unknown>;
    handlers = new Map<string, MessageHandler>();
    initialize = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue({ id: 'sent-1' });
    reply = vi.fn().mockResolvedValue({ id: 'sent-1' });
    api = { teams: { getConversations: vi.fn().mockResolvedValue([]) }, http: { get: vi.fn() } };
    graph = { http: { get: vi.fn() } };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      if (mockAppState.failNextInitialize) {
        mockAppState.failNextInitialize = false;
        this.initialize = vi.fn().mockRejectedValue(new Error('bad credentials'));
      }
      mockAppState.instances.push(this as never);
    }
    on(name: string, cb: MessageHandler) {
      this.handlers.set(name, cb);
      return this;
    }
  },
  ExpressAdapter: class MockExpressAdapter {
    constructor(public readonly appOrServer: unknown) {}
  },
}));

vi.mock('@microsoft/teams.api', () => ({
  MessageActivityInput: class MockMessageActivityInput {
    type = 'message';
    constructor(public readonly text: string) {}
  },
  TypingActivityInput: class MockTypingActivityInput {
    type = 'typing';
  },
  stripMentionsText: vi.fn(
    (activity: { text?: string }) => activity.text?.replace(/<at>[^<]*<\/at>/g, '') ?? ''
  ),
}));

vi.mock('../../../lib/prisma', () => ({ default: mockPrisma, prisma: mockPrisma }));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../../../lib/teams-config', () => ({ getTeamsConfig: mockGetTeamsConfig }));
vi.mock('../teams-mapping.service', () => ({ teamsMappingService: mockTeamsMappingService }));
vi.mock('../../conversation.service', () => ({ conversationService: mockConversationService }));
vi.mock('../../conversation-engine.service', () => ({
  conversationEngineService: { chat: mockChat },
}));
vi.mock('../teams-attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../teams-attachments')>()),
  readInboundFiles: mockReadInboundFiles,
}));
vi.mock('../../thread-reply-classifier.service', () => ({
  threadReplyClassifierService: { classify: mockClassify },
  THREAD_TRANSCRIPT_LINES: 10,
}));
vi.mock('../../../config', () => ({
  config: {
    agentId: 'agent-1',
    teamsAppId: 'app-1',
    teamsAppPassword: 'secret',
    teamsAppTenantId: 'tenant-1',
    host: '127.0.0.1',
    // 0 = an ephemeral port per test, so a running runtime's bot port never collides.
    teamsPort: 0,
    port: 3003,
    publicUrl: null as string | null,
  },
}));

import { teamsAdapterService, TEAMS_MESSAGING_PATH } from '../teams-adapter.service';
import { config } from '../../../config';
import { teamsChannelLabel } from '../../../utils/teams-formatter';

const CONNECTION = {
  id: 'tenant-1',
  tenantId: 'tenant-1',
  clientId: 'app-1',
  name: 'Microsoft Teams',
};

function lastApp() {
  return mockAppState.instances[mockAppState.instances.length - 1];
}

async function initializeConfigured(): Promise<void> {
  mockGetTeamsConfig.mockResolvedValue(CONNECTION);
  await teamsAdapterService.initialize();
}

/** The http.Server the adapter handed to the SDK's ExpressAdapter. */
function botServer(): import('node:http').Server {
  return (lastApp().options.httpServerAdapter as { appOrServer: import('node:http').Server }).appOrServer;
}

/** Fire the captured message handler and let the fire-and-forget work settle. */
async function receive(activity: Record<string, unknown>): Promise<{ send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const handler = lastApp().handlers.get('message');
  if (!handler) throw new Error('message handler not registered');
  await handler({ activity, send });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { send };
}

function dmActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'act-1',
    type: 'message',
    text: 'hello agent',
    from: { id: '29:bf-user', aadObjectId: 'aad-user-1', name: 'Jane Doe' },
    recipient: { id: '28:bot' },
    conversation: { id: 'a:dm-conversation', conversationType: 'personal' },
    ...overrides,
  };
}

const BOT_MENTION = {
  type: 'mention',
  mentioned: { id: '28:bot', name: 'Agent' },
  text: '<at>Agent</at>',
};

/** A reply in the reply chain rooted at 1755000000000 that mentions the bot. */
function channelActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'act-42',
    type: 'message',
    text: '<at>Agent</at> hello there',
    entities: [BOT_MENTION],
    from: { id: '29:bf-user', aadObjectId: 'aad-user-1', name: 'Jane Doe' },
    recipient: { id: '28:bot' },
    conversation: {
      id: '19:chan@thread.tacv2;messageid=1755000000000',
      conversationType: 'channel',
    },
    channelData: {
      team: { id: '19:team@thread.tacv2' },
      channel: { id: '19:chan@thread.tacv2' },
    },
    ...overrides,
  };
}

describe('TeamsAdapterService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppState.instances.length = 0;
    teamsAdapterService.__resetForTests();
    mockTrackEvent.mockClear();
    mockTeamsMappingService.countAllMappings.mockResolvedValue(1);
    mockPrisma.conversationThread.findUnique.mockResolvedValue({ agentId: 'agent-1' });
    mockPrisma.teamsMapping.findMany.mockResolvedValue([]);
    mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-1' });
    mockChat.mockResolvedValue({ threadId: 'thread-1' });
    mockReadInboundFiles.mockResolvedValue({ attachmentIds: [], failures: [], names: [] });
  });

  afterEach(async () => {
    await teamsAdapterService.shutdown();
  });

  describe('initialize', () => {
    it('idles when Teams env is not configured', async () => {
      mockGetTeamsConfig.mockResolvedValue(null);

      await teamsAdapterService.initialize();

      expect(mockAppState.instances.length).toBe(0);
      expect(await teamsAdapterService.isUserConnected('lens-1')).toBe(false);
    });

    it('serves the bot endpoint on its own listener at the runtime bind address', async () => {
      await initializeConfigured();

      const server = botServer();
      expect(server.listening).toBe(true);
      expect(server.address()).toMatchObject({ address: '127.0.0.1' });
    });

    it('idles when the bot port is taken', async () => {
      const http = await import('node:http');
      const squatter = http.createServer();
      await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', () => resolve()));
      config.teamsPort = (squatter.address() as { port: number }).port;

      try {
        await initializeConfigured();
        expect(await teamsAdapterService.isUserConnected('lens-1')).toBe(false);
        // The bind failed after the SDK app initialized, so the app is stopped
        // rather than left leaking its token-manager timers.
        expect(lastApp().stop).toHaveBeenCalledTimes(1);
      } finally {
        config.teamsPort = 0;
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
      }
    });

    it('registers the SDK app on our route with explicit credentials', async () => {
      await initializeConfigured();

      const app = lastApp();
      expect(app.options).toMatchObject({
        clientId: 'app-1',
        clientSecret: 'secret',
        tenantId: 'tenant-1',
        messagingEndpoint: TEAMS_MESSAGING_PATH,
        // Pinned so a stray env var can never disable JWT validation.
        dangerouslyAllowUnauthenticatedRequests: false,
      });
      expect(app.initialize).toHaveBeenCalledTimes(1);
      expect(app.handlers.has('message')).toBe(true);
      expect(mockTrackEvent).toHaveBeenCalledWith('teams adapter initialized', null, {
        'agent.id': 'agent-1',
        'teams.tenant': 'tenant-1',
      });
    });

    it('fails soft when the SDK rejects during initialize', async () => {
      mockGetTeamsConfig.mockResolvedValue(CONNECTION);
      mockAppState.failNextInitialize = true;

      await expect(teamsAdapterService.initialize()).resolves.toBeUndefined();

      expect(await teamsAdapterService.isUserConnected('lens-1')).toBe(false);
      // deliver on an idle adapter is a no-op, not a throw
      await teamsAdapterService.deliver('lens-1', {
        id: 'msg-1',
        threadId: 'thread-1',
        content: 'hi',
      } as never);
    });

    it('drops an inbound activity after a failed initialize instead of running a turn', async () => {
      // The route can already be mounted and a valid Bot Service POST still
      // reaches the handler, so an activity after a failed init must not run a
      // full turn whose reply could never send.
      mockGetTeamsConfig.mockResolvedValue(CONNECTION);
      mockAppState.failNextInitialize = true;
      await teamsAdapterService.initialize();

      const { send } = await receive(dmActivity());

      expect(mockChat).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('inbound messages', () => {
    it('ignores the bot echoing its own activity', async () => {
      await initializeConfigured();

      const { send } = await receive(
        dmActivity({ from: { id: '28:bot' }, recipient: { id: '28:bot' } })
      );

      expect(send).not.toHaveBeenCalled();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('sends one typing activity and acks before the turn finishes', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findUserMapping.mockResolvedValue({
        id: 'map-1',
        lensUserId: 'lens-1',
        agentId: 'agent-1',
        dmConversationId: 'a:dm-conversation',
      });
      let resolveChat: () => void = () => {};
      mockChat.mockImplementation(
        () => new Promise<void>((resolve) => (resolveChat = () => resolve()))
      );

      const { send } = await receive(dmActivity());

      // Handler returned (receive resolved) while chat is still pending.
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0][0] as { type: string }).type).toBe('typing');
      expect(mockChat).toHaveBeenCalledTimes(1);
      resolveChat();
    });

    it('links a DM via verification code and captures the conversation id atomically', async () => {
      await initializeConfigured();
      mockPrisma.teamsVerificationCode.findUnique.mockResolvedValue({
        connectionId: 'tenant-1',
        agentId: 'agent-1',
        lensUserId: 'lens-1',
        agentName: 'Prism',
        expiresAt: new Date(Date.now() + 60_000),
      });
      mockPrisma.teamsMapping.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      await receive(dmActivity({ text: 'a1b2c3' }));

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.teamsMapping.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          teamsUserId: 'aad-user-1',
          lensUserId: 'lens-1',
          dmConversationId: 'a:dm-conversation',
        }),
      });
      expect(lastApp().send).toHaveBeenCalledWith(
        'a:dm-conversation',
        expect.objectContaining({ text: expect.stringContaining('✅') })
      );
      expect(mockTrackEvent).toHaveBeenCalledWith('teams dm linked', 'lens-1', {
        'agent.id': 'agent-1',
      });
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('refuses a DM link when the agent already has a channel link', async () => {
      await initializeConfigured();
      mockPrisma.teamsVerificationCode.findUnique.mockResolvedValue({
        connectionId: 'tenant-1',
        agentId: 'agent-1',
        lensUserId: 'lens-1',
        agentName: 'Prism',
        expiresAt: new Date(Date.now() + 60_000),
      });
      mockPrisma.teamsMapping.findFirst
        .mockResolvedValueOnce(null) // no existing link for this Teams user
        .mockResolvedValueOnce({ id: 'ch-1', channelConversationId: '19:chan@thread.tacv2' });

      await receive(dmActivity({ text: 'a1b2c3' }));

      expect(mockPrisma.teamsMapping.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(lastApp().send).toHaveBeenCalledWith(
        'a:dm-conversation',
        expect.objectContaining({ text: expect.stringContaining('channels') })
      );
    });

    it('rejects an expired DM code', async () => {
      await initializeConfigured();
      mockPrisma.teamsVerificationCode.findUnique.mockResolvedValue({
        expiresAt: new Date(Date.now() - 1),
      });
      mockPrisma.teamsVerificationCode.delete.mockResolvedValue({});

      await receive(dmActivity({ text: 'A1B2C3' }));

      expect(lastApp().send).toHaveBeenCalledWith(
        'a:dm-conversation',
        expect.objectContaining({ text: expect.stringContaining('expired') })
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('prompts an unlinked DM user to link instead of invoking the model', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findUserMapping.mockResolvedValue(null);

      await receive(dmActivity());

      expect(lastApp().send).toHaveBeenCalledWith(
        'a:dm-conversation',
        expect.objectContaining({ text: expect.stringContaining('link code') })
      );
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('runs a linked DM turn with teams metadata and refreshes a drifted conversation id', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findUserMapping.mockResolvedValue({
        id: 'map-1',
        lensUserId: 'lens-1',
        agentId: 'agent-1',
        dmConversationId: 'a:old-conversation',
      });

      await receive(dmActivity());

      expect(mockTeamsMappingService.updateDmConversationId).toHaveBeenCalledWith(
        'map-1',
        'a:dm-conversation'
      );
      expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith(
        'lens-1',
        'agent-1',
        'a:dm-conversation'
      );
      expect(mockChat).toHaveBeenCalledWith({
        userId: 'lens-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: 'hello agent',
        metadata: { channel: 'teams' },
      });
    });

    it('runs a linked channel turn threaded, mention-stripped and sender-tagged', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findByConversationId.mockResolvedValue({
        id: 'map-2',
        lensUserId: 'lens-1',
        agentId: 'agent-1',
        channelName: 'General',
      });

      await receive(channelActivity());

      expect(mockTeamsMappingService.findByConversationId).toHaveBeenCalledWith(
        '19:chan@thread.tacv2'
      );
      expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith(
        'lens-1',
        'agent-1',
        '19:chan@thread.tacv2;messageid=1755000000000'
      );
      expect(mockChat).toHaveBeenCalledWith({
        userId: 'lens-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        message: '<@aad-user-1:Jane Doe>: hello there',
        metadata: {
          channel: 'teams',
          channelId: '19:chan@thread.tacv2',
          channelThreadId: '1755000000000',
          channelLabel: teamsChannelLabel('General'),
          senderExternalId: 'aad-user-1',
          senderName: 'Jane Doe',
        },
      });
    });

    it('answers an unlinked channel with threaded link guidance', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findByConversationId.mockResolvedValue(null);

      await receive(channelActivity());

      expect(lastApp().reply).toHaveBeenCalledWith(
        '19:chan@thread.tacv2',
        '1755000000000',
        expect.objectContaining({ text: expect.stringContaining("isn't linked") })
      );
      expect(mockChat).not.toHaveBeenCalled();
    });

    function givenChannelLinkCode(): void {
      mockPrisma.teamsVerificationCode.findUnique.mockResolvedValue({
        connectionId: 'tenant-1',
        agentId: 'agent-1',
        lensUserId: 'lens-1',
        agentName: 'Prism',
        expiresAt: new Date(Date.now() + 60_000),
      });
      mockPrisma.teamsMapping.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);
    }

    it('links a channel via verification code, named from the team channel list', async () => {
      await initializeConfigured();
      givenChannelLinkCode();
      lastApp().api.teams.getConversations.mockResolvedValue([
        { id: '19:team@thread.tacv2' },
        { id: '19:chan@thread.tacv2', name: 'Incidents' },
      ]);

      await receive(channelActivity({ text: '<at>Agent</at> D4E5F6' }));

      expect(lastApp().api.teams.getConversations).toHaveBeenCalledWith('19:team@thread.tacv2');
      expect(mockPrisma.teamsMapping.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelConversationId: '19:chan@thread.tacv2',
          channelName: 'Incidents',
        }),
      });
      expect(mockTrackEvent).toHaveBeenCalledWith('teams channel linked', 'lens-1', {
        'agent.id': 'agent-1',
      });
    });

    it('refuses a channel link when the agent already has a personal link', async () => {
      await initializeConfigured();
      givenChannelLinkCode();
      lastApp().api.teams.getConversations.mockResolvedValue([
        { id: '19:team@thread.tacv2' },
        { id: '19:chan@thread.tacv2', name: 'Incidents' },
      ]);
      mockPrisma.teamsMapping.findFirst.mockResolvedValue({ id: 'dm-1', dmConversationId: 'a:dm' });

      await receive(channelActivity({ text: '<at>Agent</at> D4E5F6' }));

      expect(mockPrisma.teamsMapping.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(lastApp().reply).toHaveBeenCalledWith(
        '19:chan@thread.tacv2',
        '1755000000000',
        expect.objectContaining({ text: expect.stringContaining('personal chat') })
      );
    });

    it('names the General channel, which the channel list shows unnamed', async () => {
      await initializeConfigured();
      givenChannelLinkCode();
      lastApp().api.teams.getConversations.mockResolvedValue([{ id: '19:team@thread.tacv2' }]);

      await receive(
        channelActivity({
          text: '<at>Agent</at> D4E5F6',
          conversation: {
            id: '19:team@thread.tacv2;messageid=1755000000000',
            conversationType: 'channel',
          },
          channelData: {
            team: { id: '19:team@thread.tacv2' },
            channel: { id: '19:team@thread.tacv2' },
          },
        })
      );

      expect(mockPrisma.teamsMapping.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelConversationId: '19:team@thread.tacv2',
          channelName: 'General',
        }),
      });
    });

    it('links the channel unnamed when the channel list lookup fails', async () => {
      await initializeConfigured();
      givenChannelLinkCode();
      lastApp().api.teams.getConversations.mockRejectedValue(new Error('403'));

      await receive(channelActivity({ text: '<at>Agent</at> D4E5F6' }));

      expect(mockPrisma.teamsMapping.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelConversationId: '19:chan@thread.tacv2',
          channelName: null,
        }),
      });
      expect(lastApp().reply).toHaveBeenCalledWith(
        '19:chan@thread.tacv2',
        '1755000000000',
        expect.objectContaining({ text: expect.stringContaining('Channel linked') })
      );
    });

    it('ignores group chats without signaling work', async () => {
      await initializeConfigured();

      const { send } = await receive(
        dmActivity({ conversation: { id: '19:group', conversationType: 'groupChat' } })
      );

      // No typing cue — the bot must not signal work it won't do.
      expect(send).not.toHaveBeenCalled();
      expect(mockChat).not.toHaveBeenCalled();
      expect(lastApp().send).not.toHaveBeenCalled();
    });

    it('drops activities after shutdown', async () => {
      await initializeConfigured();
      const handler = lastApp().handlers.get('message');
      await teamsAdapterService.shutdown();

      const send = vi.fn();
      await handler!({ activity: dmActivity(), send });

      expect(send).not.toHaveBeenCalled();
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('files on a message', () => {
    const LINKED_DM = {
      id: 'map-1',
      lensUserId: 'lens-1',
      agentId: 'agent-1',
      dmConversationId: 'a:dm-conversation',
    };
    const FILE = { contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'report.txt' };

    it('answers a personal-chat message that carries only a file', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findUserMapping.mockResolvedValue(LINKED_DM);
      mockReadInboundFiles.mockResolvedValue({ attachmentIds: ['att-1'], failures: [], names: ['report.txt'] });

      await receive(dmActivity({ text: '', attachments: [FILE] }));

      expect(mockReadInboundFiles).toHaveBeenCalledWith([FILE], expect.any(Object), { threadId: 'thread-1' });
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ message: '(shared a file: report.txt)', attachmentIds: ['att-1'] })
      );
    });

    it('answers a channel mention and tells the agent which file it could not read', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findByConversationId.mockResolvedValue({
        id: 'map-2',
        lensUserId: 'lens-1',
        agentId: 'agent-1',
        channelName: 'Incidents',
      });
      mockReadInboundFiles.mockResolvedValue({
        attachmentIds: [],
        failures: [{ filename: 'plan.docx', reason: 'no permission' }],
        names: ['plan.docx'],
      });

      await receive(channelActivity({ text: '<at>Agent</at> summarize this', attachments: [FILE] }));

      const input = mockChat.mock.calls[0][0];
      expect(input.message).toBe('<@aad-user-1:Jane Doe>: summarize this');
      expect(input).not.toHaveProperty('attachmentIds');
      expect(input.runtimeNotices).toEqual([expect.stringContaining('"plan.docx": no permission')]);
    });

    it('reads no files for a message that carries none', async () => {
      await initializeConfigured();
      mockTeamsMappingService.findUserMapping.mockResolvedValue(LINKED_DM);

      await receive(dmActivity());

      expect(mockReadInboundFiles).not.toHaveBeenCalled();
      expect(mockChat.mock.calls[0][0]).not.toHaveProperty('runtimeNotices');
    });
  });

  describe('channel messages that do not mention the bot', () => {
    const REPLY = { text: 'what time is it?', entities: [] };

    beforeEach(async () => {
      await initializeConfigured();
      mockTeamsMappingService.findByConversationId.mockResolvedValue({
        id: 'map-2',
        lensUserId: 'lens-1',
        agentId: 'agent-1',
        channelName: 'Incidents',
      });
      mockConversationService.findThreadByExternalId.mockResolvedValue({ id: 'thread-1' });
      mockConversationService.getRecentMessages.mockResolvedValue([
        {
          role: 'USER',
          content: '<@aad-user-1:Jane Doe>: what broke the build?',
          senderExternalId: 'aad-user-1',
          senderName: 'Jane Doe',
        },
        { role: 'AGENT', content: 'A failing lint rule.', senderExternalId: null, senderName: null },
      ]);
    });

    it('answers a reply in a chain it answered in when the classifier says respond', async () => {
      mockClassify.mockResolvedValue({ action: 'respond' });

      const { send } = await receive(channelActivity(REPLY));

      expect(mockConversationService.findThreadByExternalId).toHaveBeenCalledWith(
        'lens-1',
        'agent-1',
        '19:chan@thread.tacv2;messageid=1755000000000'
      );
      expect(mockClassify).toHaveBeenCalledWith({
        platform: { channel: 'teams', name: 'Microsoft Teams' },
        agentId: 'agent-1',
        lines: [
          { fromBot: false, author: 'Jane Doe', text: 'what broke the build?' },
          { fromBot: true, author: 'unknown', text: 'A failing lint rule.' },
          { fromBot: false, author: 'Jane Doe', text: 'what time is it?' },
        ],
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0][0] as { type: string }).type).toBe('typing');
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          message: '<@aad-user-1:Jane Doe>: what time is it?',
          metadata: expect.objectContaining({
            channelLabel: teamsChannelLabel('Incidents'),
            channelThreadId: '1755000000000',
          }),
        })
      );
    });

    it('stores a reply the classifier ignores, without a turn or a typing cue', async () => {
      mockClassify.mockResolvedValue({ action: 'ignore' });

      const { send } = await receive(channelActivity(REPLY));

      expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-1', {
        role: 'USER',
        content: '<@aad-user-1:Jane Doe>: what time is it?',
        triggeredBy: 'USER_INPUT',
        senderExternalId: 'aad-user-1',
        senderName: 'Jane Doe',
      });
      expect(mockChat).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(lastApp().reply).not.toHaveBeenCalled();
    });

    it('leaves a reply that mentions somebody else to them', async () => {
      await receive(
        channelActivity({
          text: '<at>Bob</at> what time is it?',
          entities: [{ type: 'mention', mentioned: { id: '29:bob', name: 'Bob' }, text: '<at>Bob</at>' }],
        })
      );

      expect(mockClassify).not.toHaveBeenCalled();
      expect(mockConversationService.addMessage).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ role: 'USER', senderName: 'Jane Doe' })
      );
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('ignores a reply in a chain the bot has not answered in', async () => {
      mockConversationService.findThreadByExternalId.mockResolvedValue(null);

      const { send } = await receive(channelActivity(REPLY));

      expect(mockClassify).not.toHaveBeenCalled();
      expect(mockConversationService.addMessage).not.toHaveBeenCalled();
      expect(mockChat).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('ignores a top-level post', async () => {
      const { send } = await receive(channelActivity({ ...REPLY, id: '1755000000000' }));

      expect(mockTeamsMappingService.findByConversationId).not.toHaveBeenCalled();
      expect(mockClassify).not.toHaveBeenCalled();
      expect(mockChat).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('says nothing in a channel that is not linked', async () => {
      mockTeamsMappingService.findByConversationId.mockResolvedValue(null);

      await receive(channelActivity(REPLY));

      expect(lastApp().reply).not.toHaveBeenCalled();
      expect(lastApp().send).not.toHaveBeenCalled();
    });

    it('does not read a link code that does not mention the bot', async () => {
      mockTeamsMappingService.findByConversationId.mockResolvedValue(null);

      await receive(channelActivity({ text: 'D4E5F6', entities: [] }));

      expect(mockPrisma.teamsVerificationCode.findUnique).not.toHaveBeenCalled();
      expect(lastApp().reply).not.toHaveBeenCalled();
    });
  });

  describe('deliver', () => {
    const baseMessage = {
      id: 'msg-1',
      threadId: 'thread-1',
      content: 'the answer',
      triggeredBy: 'USER_INPUT',
      toolCalls: null,
    };

    it('is a no-op before initialize', async () => {
      await teamsAdapterService.deliver('lens-1', baseMessage as never);
      expect(mockPrisma.teamsMapping.findMany).not.toHaveBeenCalled();
    });

    it('delivers channel-scoped as a threaded reply', async () => {
      await initializeConfigured();

      await teamsAdapterService.deliver('lens-1', baseMessage as never, {
        channel: 'teams',
        channelId: '19:chan@thread.tacv2',
        channelThreadId: '1755000000000',
        threadId: 'thread-1',
      });

      expect(lastApp().reply).toHaveBeenCalledWith(
        '19:chan@thread.tacv2',
        '1755000000000',
        expect.objectContaining({ text: 'the answer' })
      );
      expect(mockTrackEvent).toHaveBeenCalledWith('teams message delivered', 'lens-1', {
        'agent.id': 'agent-1',
        'teams.delivery': 'channel',
      });
    });

    it('scopes a DM turn to personal conversations only', async () => {
      await initializeConfigured();
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { dmConversationId: 'a:dm-1', channelConversationId: null, isMainChannel: false },
        { dmConversationId: null, channelConversationId: '19:main@thread.tacv2', isMainChannel: true },
      ]);

      await teamsAdapterService.deliver('lens-1', baseMessage as never, {
        channel: 'teams',
        threadId: 'thread-1',
      });

      expect(lastApp().send).toHaveBeenCalledTimes(1);
      expect(lastApp().send).toHaveBeenCalledWith(
        'a:dm-1',
        expect.objectContaining({ text: 'the answer' })
      );
    });

    it('broadcasts autonomous output to DM mappings plus only the main channel', async () => {
      await initializeConfigured();
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { dmConversationId: 'a:dm-1', channelConversationId: null, isMainChannel: false },
        { dmConversationId: null, channelConversationId: '19:old@thread.tacv2', isMainChannel: false },
        { dmConversationId: null, channelConversationId: '19:main@thread.tacv2', isMainChannel: true },
      ]);

      await teamsAdapterService.deliver('lens-1', {
        ...baseMessage,
        triggeredBy: 'HEARTBEAT',
      } as never);

      const targets = lastApp().send.mock.calls.map((call: unknown[]) => call[0]);
      expect(targets).toEqual(['a:dm-1', '19:main@thread.tacv2']);
      expect(mockTrackEvent).toHaveBeenCalledWith('teams message delivered', 'lens-1', {
        'agent.id': 'agent-1',
        'teams.delivery': 'mapping',
        'teams.mappings': '2',
      });
    });

    it('falls back to the oldest channel when none is flagged main', async () => {
      await initializeConfigured();
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { dmConversationId: null, channelConversationId: '19:oldest@thread.tacv2', isMainChannel: false },
        { dmConversationId: null, channelConversationId: '19:newer@thread.tacv2', isMainChannel: false },
      ]);

      await teamsAdapterService.deliver('lens-1', baseMessage as never);

      const targets = lastApp().send.mock.calls.map((call: unknown[]) => call[0]);
      expect(targets).toEqual(['19:oldest@thread.tacv2']);
    });

    it('retries a 429 send honoring Retry-After', async () => {
      await initializeConfigured();
      const app = lastApp();
      app.send
        .mockRejectedValueOnce({ status: 429, response: { headers: { 'retry-after': '0' } } })
        .mockResolvedValueOnce({ id: 'sent-2' });
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { dmConversationId: 'a:dm-1', channelConversationId: null, isMainChannel: false },
      ]);

      await teamsAdapterService.deliver('lens-1', baseMessage as never);

      expect(app.send).toHaveBeenCalledTimes(2);
    });

    describe('shared files', () => {
      async function deliverFile(): Promise<string> {
        await initializeConfigured();
        mockPrisma.teamsMapping.findMany.mockResolvedValue([
          { dmConversationId: 'a:dm-1', channelConversationId: null, isMainChannel: false },
        ]);
        await teamsAdapterService.deliver('lens-1', {
          ...baseMessage,
          attachments: [{ id: 'att-1', filename: 'report [final].pdf' }],
        } as never);
        return (lastApp().send.mock.calls[0][1] as { text: string }).text;
      }

      afterEach(() => {
        config.publicUrl = null;
      });

      it('links each file to the download route on this machine', async () => {
        await expect(deliverFile()).resolves.toContain(
          '📎 Shared file: [report final.pdf](http://localhost:3003/agents/attachments/att-1)'
        );
      });

      it('links each file at the public address when the runtime has one', async () => {
        config.publicUrl = 'https://prism.example.com/agent';

        await expect(deliverFile()).resolves.toContain(
          '[report final.pdf](https://prism.example.com/agent/agents/attachments/att-1)'
        );
      });
    });

    it('logs instead of throwing when a send fails outright', async () => {
      await initializeConfigured();
      lastApp().send.mockRejectedValue(new Error('boom'));
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { dmConversationId: 'a:dm-1', channelConversationId: null, isMainChannel: false },
      ]);

      await expect(teamsAdapterService.deliver('lens-1', baseMessage as never)).resolves.toBeUndefined();
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'teams message send failed',
        null,
        expect.objectContaining({ 'error.name': 'Error' })
      );
    });
  });

  describe('shutdown', () => {
    it('closes the bot listener, and a later initialize opens a fresh one', async () => {
      await initializeConfigured();
      const first = botServer();

      await teamsAdapterService.shutdown();
      expect(first.listening).toBe(false);

      await teamsAdapterService.initialize();
      expect(mockAppState.instances.length).toBe(2);
      expect(botServer()).not.toBe(first);
      expect(botServer().listening).toBe(true);
    });

    it('stops the SDK app and is idempotent', async () => {
      await initializeConfigured();
      const app = lastApp();

      await teamsAdapterService.shutdown();
      await teamsAdapterService.shutdown();

      expect(app.stop).toHaveBeenCalledTimes(1);
      expect(
        mockTrackEvent.mock.calls.filter(([name]) => name === 'teams adapter shutdown').length
      ).toBe(1);
      expect(await teamsAdapterService.isUserConnected('lens-1')).toBe(false);
    });
  });
});

describe('Teams routing for messages nobody replied to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('threadDestination', () => {
    it('continues a channel thread in its reply chain, labelled by its id', async () => {
      // A channel thread stores `${conversationId};messageid=${rootMessageId}`,
      // so the continuation posts into the chain, not top-level.
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        userId: 'lens-1',
        agentId: 'agent-1',
        externalThreadId: '19:chan@thread.tacv2;messageid=1755000000000',
      });

      expect(await teamsAdapterService.threadDestination('thread-1')).toEqual({
        channelId: '19:chan@thread.tacv2',
        channelThreadId: '1755000000000',
        channelLabel: teamsChannelLabel('19:chan@thread.tacv2'),
      });
      expect(mockPrisma.teamsMapping.findFirst).not.toHaveBeenCalled();
    });

    it("keeps a DM thread's continuation in the personal conversation", async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        userId: 'lens-1',
        agentId: 'agent-1',
        externalThreadId: 'a:dm-1',
      });
      mockPrisma.teamsMapping.findFirst.mockResolvedValue({ dmConversationId: 'a:dm-1' });

      expect(await teamsAdapterService.threadDestination('thread-1')).toEqual({
        channelId: 'a:dm-1',
        channelLabel: teamsChannelLabel('a:dm-1'),
      });
      expect(mockPrisma.teamsMapping.findFirst).toHaveBeenCalledWith({
        where: { lensUserId: 'lens-1', agentId: 'agent-1', dmConversationId: { not: null } },
        select: { dmConversationId: true },
      });
    });
  });

  describe('defaultDestination', () => {
    it('picks the personal conversation first', async () => {
      mockPrisma.teamsMapping.findFirst.mockResolvedValue({ dmConversationId: 'a:dm-1' });

      expect(await teamsAdapterService.defaultDestination('agent-1', 'lens-1')).toEqual({
        threadKey: 'a:dm-1',
      });
      expect(mockTeamsMappingService.getMainChannel).not.toHaveBeenCalled();
    });

    it('names the main channel, which a channel-scoped delivery needs', async () => {
      // A Teams context without a channel id is DM-scoped and delivers nothing
      // in Team Mode.
      mockPrisma.teamsMapping.findFirst.mockResolvedValue(null);
      mockTeamsMappingService.getMainChannel.mockResolvedValue('19:main@thread.tacv2');

      expect(await teamsAdapterService.defaultDestination('agent-1', 'lens-1')).toEqual({
        threadKey: '19:main@thread.tacv2',
        channelId: '19:main@thread.tacv2',
      });
    });

    it('has none when Teams is not linked', async () => {
      mockPrisma.teamsMapping.findFirst.mockResolvedValue(null);
      mockTeamsMappingService.getMainChannel.mockResolvedValue(null);

      expect(await teamsAdapterService.defaultDestination('agent-1', 'lens-1')).toBeNull();
    });
  });
});
