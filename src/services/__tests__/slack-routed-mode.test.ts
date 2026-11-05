/**
 * Slack routed mode, on the adapter's side: a router delivers the events of a
 * shared Slack app, says how it addressed each one, and links people and
 * channels; the agent keeps each Slack thread's history in its own database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSlackMappingService,
  mockConversationService,
  mockChat,
  mockClassify,
  mockPrisma,
  mockTrackEvent,
  mockGetSlackConnection,
  mockReloadSlackConfig,
  mockClearSlackConfig,
  mockIsTriggerChannel,
  mockGetAgent,
  builtApps,
} = vi.hoisted(() => ({
  mockIsTriggerChannel: vi.fn(),
  mockGetAgent: vi.fn(),
  mockSlackMappingService: {
    findByChannelId: vi.fn(),
    findUserMapping: vi.fn(),
    upsertUserMapping: vi.fn(),
    removeUserMapping: vi.fn(),
    upsertChannelMapping: vi.fn(),
    removeChannelMapping: vi.fn(),
    deleteChannelMapping: vi.fn(),
    getActiveUserMappingsWithDmChannel: vi.fn(),
  },
  mockConversationService: {
    getOrCreateThreadByExternalId: vi.fn(),
    getRecentMessages: vi.fn(),
    addMessage: vi.fn(),
  },
  mockChat: vi.fn(),
  mockClassify: vi.fn(),
  mockPrisma: {
    conversationMessage: { findMany: vi.fn() },
    conversationParticipant: { upsert: vi.fn() },
    slackMapping: { findFirst: vi.fn() },
  },
  mockTrackEvent: vi.fn(),
  mockGetSlackConnection: vi.fn(),
  mockReloadSlackConfig: vi.fn(),
  mockClearSlackConfig: vi.fn(),
  builtApps: [] as Array<{
    options: { receiver?: unknown; socketMode?: boolean };
    message: ReturnType<typeof vi.fn>;
    event: ReturnType<typeof vi.fn>;
    client: { conversations: { replies: ReturnType<typeof vi.fn> }; reactions: { add: ReturnType<typeof vi.fn> } };
  }>,
}));

vi.mock('../slack-mapping.service', () => ({ slackMappingService: mockSlackMappingService }));
vi.mock('../slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: { isHeartbeatTriggerChannel: mockIsTriggerChannel },
}));
vi.mock('../slack-message-queue.service', () => ({ slackMessageQueueService: {} }));
vi.mock('../heartbeat.service', () => ({ heartbeatService: {} }));
vi.mock('../conversation.service', () => ({ conversationService: mockConversationService }));
vi.mock('../conversation-engine.service', () => ({ conversationEngineService: { chat: mockChat } }));
vi.mock('../agent-workspace.service', () => ({
  agentWorkspaceService: { getAgent: mockGetAgent },
}));
vi.mock('../thread-reply-classifier.service', () => ({
  threadReplyClassifierService: { classify: mockClassify },
  loadGateAgent: async () => ({ name: 'Atlas', role: '' }),
  THREAD_TRANSCRIPT_LINES: 10,
}));
vi.mock('../slack-router.service', () => ({ slackRouterService: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../queues/slack-heartbeat-throttle-queue', () => ({ getSlackHeartbeatThrottleQueue: vi.fn() }));
vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../lib/slack-source', () => ({
  getSlackConnection: mockGetSlackConnection,
  getActiveSlackConnections: vi.fn(),
}));
vi.mock('../../lib/slack-config', () => ({
  slackMode: () => 'routed',
  reloadSlackConfig: mockReloadSlackConfig,
  clearSlackConfig: mockClearSlackConfig,
}));
vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: () => false,
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({
  config: { agentId: 'agent-1', slackApiUrl: 'https://api.example.test/slack/api/' },
}));
vi.mock('@slack/bolt', () => ({
  App: class {
    error = vi.fn();
    message = vi.fn();
    action = vi.fn();
    event = vi.fn();
    client = { conversations: { replies: vi.fn() }, reactions: { add: vi.fn() } };
    constructor(readonly options: { receiver?: unknown; socketMode?: boolean }) {
      builtApps.push(this as never);
    }
  },
  SocketModeReceiver: class {},
  LogLevel: { INFO: 'info', WARN: 'warn' },
}));

import { slackAdapterService } from '../slack-adapter.service';
import { HandedEventReceiver } from '../slack-handed-receiver';
import { SlackThreadProvider } from '../providers/slack-thread.provider';

const BOT = 'U0BOT';
const TEAM = 'T0EXAMPLE';
const CHANNEL = 'C0EXAMPLE';
const ALICE = 'U0ALICE';
const THREAD_TS = '1761732000.000100';
const MESSAGE_TS = '1761732060.000200';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = slackAdapterService as any;

function routed(route: string) {
  return { route, handOff: vi.fn() };
}

function channelMessage(text: string, threadTs: string | undefined, event: ReturnType<typeof routed>) {
  return adapter.handleChannelMessage('conn', CHANNEL, ALICE, text, threadTs, MESSAGE_TS, vi.fn(), BOT, TEAM, [], event);
}

function connectedApp() {
  const replies = vi.fn();
  adapter.apps.set(TEAM, {
    app: { client: { conversations: { replies } } },
    teamId: TEAM,
    teamName: 'Example',
    isSocketMode: false,
    botUserId: BOT,
  });
  return replies;
}

beforeEach(() => {
  vi.clearAllMocks();
  builtApps.length = 0;
  mockIsTriggerChannel.mockResolvedValue({ isTrigger: false });
  mockGetAgent.mockResolvedValue({ id: 'agent-1', name: 'Atlas' });
  adapter.apps = new Map();
  adapter.getUserInfo = vi.fn().mockResolvedValue({ real_name: 'Alice' });
  adapter.resolveMentions = vi.fn(async (text: string) => text);
  adapter.addReaction = vi.fn().mockResolvedValue(undefined);
  adapter.addParticipant = vi.fn().mockResolvedValue(undefined);
  adapter._workingIndicator = { begin: vi.fn().mockResolvedValue(null), stopAll: vi.fn() };
  mockSlackMappingService.findByChannelId.mockResolvedValue({
    agentId: 'agent-1',
    lensUserId: 'person-1',
    slackChannelName: 'ops',
    connection: { teamId: TEAM },
  });
  mockSlackMappingService.getActiveUserMappingsWithDmChannel.mockResolvedValue([]);
  mockConversationService.getOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-1' });
  mockConversationService.getRecentMessages.mockResolvedValue([{ id: 'm1', role: 'AGENT', content: 'Earlier reply.' }]);
  mockConversationService.addMessage.mockResolvedValue({ message: {}, titleSet: null });
  mockChat.mockResolvedValue({});
  mockPrisma.conversationMessage.findMany.mockResolvedValue([]);
});

describe('Routed channel messages', () => {
  it('answers a message the router addressed by a mention, in a stored thread, without reading Slack', async () => {
    const wait = vi.spyOn(SlackThreadProvider.prototype, 'waitForExternalMessage');
    const event = routed('mention');

    await channelMessage('what is the status?', undefined, event);

    expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith(
      'person-1',
      'agent-1',
      MESSAGE_TS,
      { source: 'DATABASE', channelId: CHANNEL },
    );
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', message: '<@U0ALICE:Alice>: what is the status?' }),
    );
    expect(event.handOff.mock.invocationCallOrder[0]).toBeLessThan(mockChat.mock.invocationCallOrder[0]);
    expect(wait).not.toHaveBeenCalled();
  });

  it('leaves a top-level message the router did not address unanswered', async () => {
    await channelMessage(`<@${BOT}> hello`, undefined, routed('thread_reply'));

    expect(mockChat).not.toHaveBeenCalled();
  });

  it('judges a thread reply on the stored thread, and keeps one it does not answer', async () => {
    mockConversationService.getRecentMessages.mockResolvedValue([
      { role: 'USER', content: '<@U0BOB:Bob>: is the deploy done?', senderExternalId: 'U0BOB', senderName: 'Bob' },
      { role: 'AGENT', content: 'It finished at noon.' },
    ]);
    mockClassify.mockResolvedValue({ action: 'ignore' });
    const event = routed('thread_reply');

    await channelMessage('thanks Bob, I will check the logs', THREAD_TS, event);

    expect(mockClassify).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          { author: { kind: 'person', name: 'Bob' }, text: 'is the deploy done?' },
          { author: { kind: 'agent', name: 'Atlas' }, text: 'It finished at noon.' },
          { author: { kind: 'person', name: 'Alice' }, text: 'thanks Bob, I will check the logs' },
        ],
      }),
    );
    expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-1', {
      role: 'USER',
      content: '<@U0ALICE:Alice>: thanks Bob, I will check the logs',
      triggeredBy: 'USER_INPUT',
      senderExternalId: ALICE,
      senderName: 'Alice',
    });
    expect(event.handOff).toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('reacts to a thread reply that tags somebody else, and keeps it', async () => {
    const event = routed('thread_reply');

    await channelMessage('<@U0BOB> can you look?', THREAD_TS, event);

    expect(adapter.addReaction).toHaveBeenCalledWith(CHANNEL, MESSAGE_TS, TEAM, 'eyes');
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockConversationService.addMessage).toHaveBeenCalledWith('thread-1', expect.objectContaining({ role: 'USER' }));
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('answers a thread reply the classifier finds is for the agent', async () => {
    mockClassify.mockResolvedValue({ action: 'respond' });

    await channelMessage('and what about staging?', THREAD_TS, routed('thread_reply'));

    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
  });

  it('ignores a link code: the router links channels', async () => {
    await channelMessage('ABC123', THREAD_TS, routed('mention'));

    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ message: '<@U0ALICE:Alice>: ABC123' }));
  });
});

describe('A Slack thread the agent joins', () => {
  it('stores the messages before the one that brought the agent in, once', async () => {
    const replies = connectedApp();
    replies.mockResolvedValue({
      messages: [
        { ts: THREAD_TS, user: BOT, bot_id: 'B0BOT', text: 'Disk usage is at 91%.' },
        { ts: '1761732030.000100', user: BOT, bot_id: 'B0BOT', username: 'Sales', text: 'Not mine to fix.' },
        { ts: '1761732040.000100', user: 'U0BOB', text: 'who owns this?' },
        { ts: MESSAGE_TS, user: ALICE, text: 'can you clean it up?' },
        { ts: '1761732090.000100', user: 'U0BOB', text: 'later message' },
      ],
    });
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { externalMessageId: THREAD_TS, content: 'Disk usage is at **91%**.', triggeredBy: 'HEARTBEAT', triggerName: null },
    ]);
    adapter.getUserInfo = vi.fn().mockResolvedValue({ real_name: 'Bob' });
    mockConversationService.getRecentMessages.mockResolvedValueOnce([]);

    await channelMessage('can you clean it up?', THREAD_TS, routed('mention'));

    expect(replies).toHaveBeenCalledTimes(1);
    expect(replies).toHaveBeenCalledWith({ channel: CHANNEL, ts: THREAD_TS, limit: 200 });
    expect(mockConversationService.addMessage.mock.calls).toEqual([
      ['thread-1', { role: 'AGENT', content: 'Disk usage is at **91%**.', triggeredBy: 'HEARTBEAT' }],
      [
        'thread-1',
        {
          role: 'USER',
          content: '<@B0BOT:Sales>: Not mine to fix.',
          triggeredBy: 'USER_INPUT',
          senderExternalId: 'B0BOT',
          senderName: 'Sales',
        },
      ],
      [
        'thread-1',
        {
          role: 'USER',
          content: '<@U0BOB:Bob>: who owns this?',
          triggeredBy: 'USER_INPUT',
          senderExternalId: 'U0BOB',
          senderName: 'Bob',
        },
      ],
    ]);
    expect(mockChat).toHaveBeenCalled();
  });

  it('reads nothing when the stored thread already has messages', async () => {
    const replies = connectedApp();

    await channelMessage('one more thing', THREAD_TS, routed('mention'));

    expect(replies).not.toHaveBeenCalled();
  });

  it('starts without the earlier messages when Slack refuses the read', async () => {
    const replies = connectedApp();
    replies.mockRejectedValue(Object.assign(new Error('not_allowed'), { data: { error: 'not_allowed' } }));
    mockConversationService.getRecentMessages.mockResolvedValueOnce([]);

    await channelMessage('can you clean it up?', THREAD_TS, routed('mention'));

    expect(mockConversationService.addMessage).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalled();
  });
});

describe('Routed DMs', () => {
  it('answers a threaded DM in a stored thread', async () => {
    mockSlackMappingService.findUserMapping.mockResolvedValue({
      id: 'map-1',
      agentId: 'agent-1',
      lensUserId: 'person-1',
      dmChannelId: 'D0ALICE',
    });
    const event = routed('dm');

    await adapter.handleDmMessage('conn', ALICE, 'and now?', 'D0ALICE', vi.fn(), TEAM, MESSAGE_TS, THREAD_TS, [], event);

    expect(mockConversationService.getOrCreateThreadByExternalId).toHaveBeenCalledWith(
      'person-1',
      'agent-1',
      THREAD_TS,
      { source: 'DATABASE', channelId: 'D0ALICE' },
    );
    expect(event.handOff).toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ metadata: { channel: 'slack', channelThreadId: THREAD_TS } }));
  });
});

describe('The routed message handler', () => {
  async function routedApp() {
    mockGetSlackConnection.mockResolvedValue({
      id: TEAM,
      teamId: TEAM,
      teamName: 'Example',
      botToken: '__nexus_cred:proxy__',
      botId: 'B0BOT',
      botUserId: BOT,
      isActive: true,
    });
    await adapter.initializeConnection(TEAM);
    return builtApps[0];
  }

  it('builds an app that opens no connection and takes the router\'s events', async () => {
    const app = await routedApp();

    expect(app.options.receiver).toBeInstanceOf(HandedEventReceiver);
    expect(app.options.socketMode).toBeUndefined();
    expect(adapter.apps.get(TEAM).routedReceiver).toBe(app.options.receiver);
    expect(mockTrackEvent).toHaveBeenCalledWith('slack connection added', null, expect.objectContaining({ 'slack.mode': 'routed' }));
  });

  it('drops the app mention and the user-group handle that addressed the agent', async () => {
    const app = await routedApp();
    const handleChannelMessage = vi.spyOn(adapter, 'handleChannelMessage').mockResolvedValue(undefined);
    const event = routed('mention');
    const [onMessage] = app.message.mock.calls[0];

    await onMessage({
      message: { user: ALICE, text: `<@${BOT}> <!subteam^S0OPS|@ops-agent> check <@U0BOB>'s alert`, channel: CHANNEL, ts: MESSAGE_TS },
      say: vi.fn(),
      context: { routed: event },
    });

    expect(handleChannelMessage.mock.calls[0][3]).toBe("check <@U0BOB>'s alert");
    expect(handleChannelMessage.mock.calls[0][10]).toBe(event);
    handleChannelMessage.mockRestore();
  });

  it('keeps a handle in the middle of a routed message as its plain @handle', async () => {
    const app = await routedApp();
    const handleChannelMessage = vi.spyOn(adapter, 'handleChannelMessage').mockResolvedValue(undefined);
    const [onMessage] = app.message.mock.calls[0];

    await onMessage({
      message: { user: ALICE, text: 'can <!subteam^S0OPS|@ops-agent> and <!subteam^S0SALES|@sales> both check this?', channel: CHANNEL, ts: MESSAGE_TS },
      say: vi.fn(),
      context: { routed: routed('mention') },
    });

    expect(handleChannelMessage.mock.calls[0][3]).toBe('can @ops-agent and @sales both check this?');
    handleChannelMessage.mockRestore();
  });

  it('sends a DM the router routed to the DM handler', async () => {
    const app = await routedApp();
    const handleDmMessage = vi.spyOn(adapter, 'handleDmMessage').mockResolvedValue(undefined);
    const [onMessage] = app.message.mock.calls[0];

    await onMessage({
      message: { user: ALICE, text: 'hello', channel: 'D0ALICE', ts: MESSAGE_TS },
      say: vi.fn(),
      context: { routed: routed('dm') },
    });

    expect(handleDmMessage).toHaveBeenCalled();
    handleDmMessage.mockRestore();
  });

  it('asks for no link code when the bot joins a channel', async () => {
    const app = await routedApp();
    const [, onJoin] = app.event.mock.calls.find(([name]) => name === 'member_joined_channel')!;
    const client = { chat: { postMessage: vi.fn() } };

    await onJoin({ event: { user: BOT, channel: CHANNEL }, client, context: { routed: routed('channel_event') } });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('Router connection changes and links', () => {
  const connection = {
    id: TEAM,
    teamId: TEAM,
    teamName: 'Example',
    botToken: '__nexus_cred:proxy__',
    botId: 'B0BOT',
    botUserId: BOT,
    isActive: true,
  };

  it('validates the token again on `connected` and starts the workspace app', async () => {
    mockReloadSlackConfig.mockResolvedValue(connection);
    mockGetSlackConnection.mockResolvedValue(connection);

    expect(await adapter.routerHandlers().connect(TEAM)).toBe(true);
    expect(mockReloadSlackConfig).toHaveBeenCalledTimes(1);
    expect(adapter.apps.has(TEAM)).toBe(true);
  });

  it('keeps the running app when `connected` or an event names its workspace again', async () => {
    mockReloadSlackConfig.mockResolvedValue(connection);
    mockGetSlackConnection.mockResolvedValue(connection);
    const handlers = adapter.routerHandlers();
    await handlers.connect(TEAM);
    const running = adapter.apps.get(TEAM);
    mockTrackEvent.mockClear();

    expect(await handlers.connect(TEAM)).toBe(true);
    expect(await handlers.ready('T0OTHER')).toBe(false);

    expect(adapter.apps.get(TEAM)).toBe(running);
    expect(mockTrackEvent).not.toHaveBeenCalledWith('slack connection added', null, expect.anything());
  });

  it('stays idle while the proxy token is bound to no workspace', async () => {
    mockReloadSlackConfig.mockResolvedValue(null);

    expect(await adapter.routerHandlers().connect(TEAM)).toBe(false);
    expect(adapter.apps.size).toBe(0);
  });

  it('stops the workspace app on `disconnected`', async () => {
    connectedApp();

    await adapter.routerHandlers().disconnect();

    expect(adapter.apps.size).toBe(0);
    expect(mockClearSlackConfig).toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith('slack connection disconnected', null, expect.objectContaining({ 'agent.id': 'agent-1' }));
  });

  it('links and unlinks a person\'s DM', async () => {
    const handlers = adapter.routerHandlers();
    const dm = { type: 'dm', slackUserId: ALICE, dmChannelId: 'D0ALICE', personId: 'person-1' };

    await handlers.link(TEAM, { ...dm, op: 'add' });
    await handlers.link(TEAM, { ...dm, op: 'remove' });

    expect(mockSlackMappingService.upsertUserMapping).toHaveBeenCalledWith(TEAM, ALICE, 'person-1', 'agent-1', 'D0ALICE');
    expect(mockSlackMappingService.removeUserMapping).toHaveBeenCalledWith(TEAM, ALICE);
    expect(mockTrackEvent).toHaveBeenCalledWith('slack link changed', 'person-1', {
      'agent.id': 'agent-1',
      'slack.link.type': 'dm',
      'slack.link.op': 'add',
    });
  });

  it('links a channel under its name, and unlinks it', async () => {
    adapter.getChannelName = vi.fn().mockResolvedValue('ops');
    const handlers = adapter.routerHandlers();
    const channel = { type: 'channel', channelId: CHANNEL, personId: 'person-1' };

    await handlers.link(TEAM, { ...channel, op: 'add' });
    await handlers.link(TEAM, { ...channel, op: 'remove' });

    expect(mockSlackMappingService.upsertChannelMapping).toHaveBeenCalledWith(TEAM, CHANNEL, 'agent-1', 'ops', 'person-1');
    expect(mockSlackMappingService.removeChannelMapping).toHaveBeenCalledWith(CHANNEL);
  });
});
