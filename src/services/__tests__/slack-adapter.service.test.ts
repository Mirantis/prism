/**
 * Slack Adapter Service Tests — disconnectAndDeactivate
 *
 * Covers the teardown path that runs when a SlackConnection is removed:
 * stops the Bolt app and deletes all rows referencing the connectionId
 * across SlackMapping, SlackVerificationCode, and SlackHeartbeatTrigger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockPrisma,
  mockGetSlackConnection,
  mockGetActiveSlackConnections,
  mockSlackMappingService,
  mockSlackHeartbeatTriggerService,
} = vi.hoisted(() => ({
  mockPrisma: {
    slackVerificationCode: {
      deleteMany: vi.fn(),
    },
    conversationThread: {
      findUnique: vi.fn(),
    },
    slackMapping: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockGetSlackConnection: vi.fn(),
  mockGetActiveSlackConnections: vi.fn(),
  mockSlackMappingService: {
    deleteByConnectionId: vi.fn(),
    getActiveUserMappingsWithDmChannel: vi.fn(),
    upsertUserMapping: vi.fn(),
    findByChannelId: vi.fn(),
    getMainChannel: vi.fn(),
    listChannelIds: vi.fn(),
  },
  mockSlackHeartbeatTriggerService: {
    deleteByConnectionId: vi.fn(),
  },
}));

// Stub the module graph — slack-adapter.service.ts pulls in many deps but
// the disconnectAndDeactivate path only touches what we mock explicitly.
vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../lib/slack-source', () => ({
  getSlackConnection: mockGetSlackConnection,
  getActiveSlackConnections: mockGetActiveSlackConnections,
}));
vi.mock('../slack-mapping.service', () => ({ slackMappingService: mockSlackMappingService }));
vi.mock('../slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: mockSlackHeartbeatTriggerService,
}));
vi.mock('../slack-message-queue.service', () => ({ slackMessageQueueService: {} }));
vi.mock('../heartbeat.service', () => ({ heartbeatService: {} }));
vi.mock('../conversation.service', () => ({ conversationService: {} }));
vi.mock('../conversation-engine.service', () => ({ conversationEngineService: {} }));
vi.mock('../../queues/slack-heartbeat-throttle-queue', () => ({
  getSlackHeartbeatThrottleQueue: vi.fn(),
}));
vi.mock('../../lib/llm-providers/bedrock/bedrock-provider', () => ({}));
vi.mock('../../utils/slack-formatter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/slack-formatter')>()),
  formatSlackMessage: (s: string) => s,
}));
vi.mock('@slack/bolt', () => ({
  App: class {
    error = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    message = vi.fn();
    action = vi.fn();
    event = vi.fn();
  },
  LogLevel: { INFO: 'info', WARN: 'warn' },
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: () => false,
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({ config: {} }));

import { slackAdapterService } from '../slack-adapter.service';
import { attachmentService } from '../attachment.service';
import { conversationService } from '../conversation.service';
import { logger } from '../../logger';

describe('Requirement: disconnectAndDeactivate cleans up connection rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the apps map between tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (slackAdapterService as any).apps = new Map();
    // rebuildUserCache consults slackMappingService — return empty by default.
    mockSlackMappingService.getActiveUserMappingsWithDmChannel.mockResolvedValue([]);
    // $transaction with an interactive callback: invoke the callback with
    // the mock prisma object so the service methods receive it as `tx`.
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma),
    );
  });

  describe('Scenario: active connection with running Bolt app', () => {
    it('should stop the Bolt app, delete all related rows, and rebuild the cache', async () => {
      mockGetSlackConnection.mockResolvedValue({
        id: 'conn-001',
        teamId: 'T001',
        teamName: 'Test Workspace',
        isActive: true,
      });
      const stopFn = vi.fn().mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (slackAdapterService as any).apps.set('T001', {
        app: { stop: stopFn },
        teamId: 'T001',
        teamName: 'Test Workspace',
        isSocketMode: true,
        botUserId: 'U_BOT',
      });

      mockSlackMappingService.deleteByConnectionId.mockResolvedValue(3);
      mockPrisma.slackVerificationCode.deleteMany.mockResolvedValue({ count: 2 });
      mockSlackHeartbeatTriggerService.deleteByConnectionId.mockResolvedValue(1);

      await slackAdapterService.disconnectAndDeactivate('conn-001');

      expect(stopFn).toHaveBeenCalledOnce();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((slackAdapterService as any).apps.has('T001')).toBe(false);

      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
      expect(mockSlackMappingService.deleteByConnectionId).toHaveBeenCalledWith(
        'conn-001',
        mockPrisma,
      );
      expect(mockPrisma.slackVerificationCode.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: 'conn-001' },
      });
      expect(mockSlackHeartbeatTriggerService.deleteByConnectionId).toHaveBeenCalledWith(
        'conn-001',
        mockPrisma,
      );

      expect(mockSlackMappingService.getActiveUserMappingsWithDmChannel).toHaveBeenCalledOnce();
    });

    it('should roll back (not rebuild cache) when a delete inside the transaction fails', async () => {
      mockGetSlackConnection.mockResolvedValue({
        id: 'conn-001',
        teamId: 'T001',
        teamName: 'Test Workspace',
        isActive: true,
      });
      mockSlackMappingService.deleteByConnectionId.mockResolvedValue(1);
      mockPrisma.slackVerificationCode.deleteMany.mockRejectedValue(new Error('boom'));

      await expect(
        slackAdapterService.disconnectAndDeactivate('conn-001'),
      ).rejects.toThrow('boom');

      // rebuildUserCache runs only after the transaction succeeds.
      expect(mockSlackMappingService.getActiveUserMappingsWithDmChannel).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: no Bolt app registered for the connection', () => {
    it('should still delete related rows without trying to stop a missing app', async () => {
      mockGetSlackConnection.mockResolvedValue({
        id: 'conn-001',
        teamId: 'T001',
        teamName: 'Test Workspace',
        isActive: true,
      });
      mockSlackMappingService.deleteByConnectionId.mockResolvedValue(0);
      mockPrisma.slackVerificationCode.deleteMany.mockResolvedValue({ count: 0 });
      mockSlackHeartbeatTriggerService.deleteByConnectionId.mockResolvedValue(0);

      await slackAdapterService.disconnectAndDeactivate('conn-001');

      expect(mockSlackMappingService.deleteByConnectionId).toHaveBeenCalledWith(
        'conn-001',
        mockPrisma,
      );
      expect(mockPrisma.slackVerificationCode.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: 'conn-001' },
      });
      expect(mockSlackHeartbeatTriggerService.deleteByConnectionId).toHaveBeenCalledWith(
        'conn-001',
        mockPrisma,
      );
    });
  });

  describe('Scenario: connection not found', () => {
    it('should throw and perform no deletes', async () => {
      mockGetSlackConnection.mockResolvedValue(null);

      await expect(
        slackAdapterService.disconnectAndDeactivate('conn-missing'),
      ).rejects.toThrow('Connection not found');

      expect(mockSlackMappingService.deleteByConnectionId).not.toHaveBeenCalled();
      expect(mockPrisma.slackVerificationCode.deleteMany).not.toHaveBeenCalled();
      expect(mockSlackHeartbeatTriggerService.deleteByConnectionId).not.toHaveBeenCalled();
    });
  });
});

describe('Requirement: buildSenderTaggedContent prepares inbound text for the agent', () => {
  // The helper takes a sender's Slack ID + display name and prepends a
  // `<@USERID:Name>: ` marker so the agent's conversation history carries
  // the canonical Slack mention token for whoever is speaking. Both inbound
  // handlers (DM, channel) call this before forwarding the message to the
  // conversation engine.
  type AdapterWithHelper = {
    buildSenderTaggedContent(
      slackUserId: string,
      senderName: string | undefined,
      text: string,
    ): string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helper = (slackAdapterService as any) as AdapterWithHelper;

  describe('Scenario: both Slack user ID and display name available', () => {
    it('produces the <@USERID:Name>: prefix', () => {
      expect(helper.buildSenderTaggedContent('U123', 'Alice', 'what pods are running?'))
        .toBe('<@U123:Alice>: what pods are running?');
    });

    it('sanitizes display names that contain marker-reserved characters', () => {
      // `<`, `>`, `:`, and control chars are stripped before being embedded
      // in the marker so consumers (e.g. the outbound rewrite regex) can
      // reliably parse `<@U…:Name>` tokens.
      expect(helper.buildSenderTaggedContent('UEVE', 'Eve: <evil>', 'hello'))
        .toBe('<@UEVE:Eve evil>: hello');
    });

    it('drops the name segment when sanitization would empty it', () => {
      // A name made entirely of reserved characters would leave an empty
      // `<@U:>` marker — emit the bare `<@U>` token instead so the mention
      // still resolves on Slack.
      expect(helper.buildSenderTaggedContent('UWEIRD', ':<>', 'sup'))
        .toBe('<@UWEIRD>: sup');
    });
  });

  describe('Scenario: only the Slack user ID is known', () => {
    it('returns the message unchanged when the display name is missing', () => {
      // Without a display name we have nothing meaningful to render, so
      // skip the tag entirely rather than emit `<@U123:>: …`.
      expect(helper.buildSenderTaggedContent('U123', undefined, 'hello'))
        .toBe('hello');
    });
  });
});

describe('Requirement: Slack file download failures are surfaced to the agent', () => {
  // Previously a failed download was logged and silently dropped, so the agent
  // never knew a file was shared and couldn't tell the user. downloadSlackFiles
  // now returns per-file failures, and the handlers append them to the message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = slackAdapterService as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSlackConnection.mockResolvedValue({ botToken: 'xoxb-test', isActive: true });
  });

  it('reports an access/permission failure instead of dropping the file', async () => {
    vi.spyOn(attachmentService, 'existsByExternalFileId').mockResolvedValue(false);
    const createSpy = vi.spyOn(attachmentService, 'createOnce');
    // Slack serves an HTML login page (HTTP 200) when the bot can't read the file.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    try {
      const result = await adapter.downloadSlackFiles(
        [{ id: 'F1', name: 'secret.png', url_private_download: 'https://files.slack.com/x' }],
        { externalTs: '1700.0001' },
      );
      expect(result.attachmentIds).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].filename).toBe('secret.png');
      expect(result.failures[0].reason).toMatch(/files:read|denied access/i);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports an oversized file as a failure before downloading', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await adapter.downloadSlackFiles(
        [{ id: 'F2', name: 'huge.zip', size: 999_999_999, url_private: 'https://files.slack.com/x' }],
        {},
      );
      expect(result.attachmentIds).toEqual([]);
      expect(result.failures[0].reason).toMatch(/exceeds/i);
      expect(fetchSpy).not.toHaveBeenCalled(); // size known up front; no download attempted
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('buildAttachmentFailureNote produces an actionable runtime notice for the system prompt', () => {
    const note = adapter.buildAttachmentFailureNote([
      { filename: 'secret.png', reason: 'Slack denied access' },
    ]);
    expect(note).toContain('secret.png');
    expect(note).toMatch(/tell the user/i);
    expect(note).toContain('files:read');
    // Counters the observed failure modes: denying the file, and asking for a path.
    expect(note).toMatch(/no file was attached/i);
    expect(note).toMatch(/file path|on disk/i);
  });
});

describe('Requirement: Adapter telemetry', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = slackAdapterService as any;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter.apps = new Map();
    mockSlackMappingService.getActiveUserMappingsWithDmChannel.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma),
    );
  });

  it('emits "slack adapter initialized" with the workspace count', async () => {
    mockGetActiveSlackConnections.mockResolvedValue([{ id: 'conn-001' }]);
    const initSpy = vi
      .spyOn(slackAdapterService, 'initializeConnection')
      .mockResolvedValue(undefined);

    await slackAdapterService.initialize();
    initSpy.mockRestore();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack adapter initialized',
      null,
      expect.objectContaining({ 'slack.workspaces': '0' }),
    );
  });

  it('does not emit "slack adapter initialized" when no connections are configured', async () => {
    mockGetActiveSlackConnections.mockResolvedValue([]);

    await slackAdapterService.initialize();

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "slack adapter shutdown" after stopping all apps', async () => {
    adapter.apps.set('T001', {
      app: { stop: vi.fn().mockResolvedValue(undefined) },
      teamId: 'T001',
      teamName: 'Test Workspace',
      isSocketMode: true,
      botUserId: 'U_BOT',
    });

    await slackAdapterService.shutdown();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack adapter shutdown',
      null,
      expect.objectContaining({ 'slack.workspaces': '1' }),
    );
  });

  it('clears working indicators before stopping the Bolt apps on shutdown', async () => {
    const appStop = vi.fn().mockResolvedValue(undefined);
    adapter.apps.set('T001', {
      app: { stop: appStop },
      teamId: 'T001',
      teamName: 'Test Workspace',
      isSocketMode: true,
      botUserId: 'U_BOT',
    });
    const stopAll = vi.fn().mockResolvedValue(undefined);
    adapter._workingIndicator = { stopAll };

    await slackAdapterService.shutdown();

    expect(stopAll).toHaveBeenCalledOnce();
    // Indicator cleanup must run while the clients are still up.
    expect(stopAll.mock.invocationCallOrder[0]).toBeLessThan(appStop.mock.invocationCallOrder[0]);
    // The stopped instance is dropped so a management-API restart
    // (shutdown → initialize in the same process) gets a working one.
    expect(adapter._workingIndicator).toBeUndefined();
  });

  it('emits "slack connection added" when initializeConnection registers an app', async () => {
    mockGetSlackConnection.mockResolvedValue({
      id: 'conn-001',
      teamId: 'T001',
      teamName: 'Test Workspace',
      isActive: true,
      botToken: 'xoxb-test',
      botUserId: 'U_BOT',
    });
    delete process.env.SLACK_APP_TOKEN; // no socket mode — skips app.start()

    await slackAdapterService.initializeConnection('conn-001');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack connection added',
      null,
      expect.objectContaining({
        'slack.connection.id': 'conn-001',
        'slack.socket_mode': 'false',
      }),
    );
  });

  it('emits "slack connection removed" with cleanup counts on disconnect', async () => {
    mockGetSlackConnection.mockResolvedValue({
      id: 'conn-001',
      teamId: 'T001',
      teamName: 'Test Workspace',
      isActive: true,
    });
    mockSlackMappingService.deleteByConnectionId.mockResolvedValue(3);
    mockPrisma.slackVerificationCode.deleteMany.mockResolvedValue({ count: 2 });
    mockSlackHeartbeatTriggerService.deleteByConnectionId.mockResolvedValue(1);

    await slackAdapterService.disconnectAndDeactivate('conn-001');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack connection removed',
      null,
      expect.objectContaining({
        'slack.connection.id': 'conn-001',
        'slack.mappings_removed': '3',
      }),
    );
  });

  it('emits "slack user linked" on linkSlackUser', async () => {
    mockSlackMappingService.upsertUserMapping.mockResolvedValue(undefined);

    await slackAdapterService.linkSlackUser('conn-001', 'U123', 'lens-user-1', 'agent-1', 'D123');

    expect(mockTrackEvent).toHaveBeenCalledWith('slack user linked', 'lens-user-1', {
      'agent.id': 'agent-1',
      'slack.user.id': 'U123',
    });
  });

  it('emits "slack message delivered" with delivery=channel for channel-context delivery', async () => {
    const deliverSpy = vi
      .spyOn(slackAdapterService, 'deliverToChannel')
      .mockResolvedValue(undefined);

    await slackAdapterService.deliver(
      'lens-user-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'msg-1', threadId: 'thr-1', content: 'hi', toolCalls: null } as any,
      { channel: 'slack', channelId: 'C123', threadId: 'thr-1' },
    );
    deliverSpy.mockRestore();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack message delivered',
      'lens-user-1',
      expect.objectContaining({ 'slack.delivery': 'channel' }),
    );
  });

  it('emits "slack message delivered" with delivery=mapping after mapping fan-out', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({ agentId: 'agent-1' });
    mockPrisma.slackMapping.findMany.mockResolvedValue([
      { id: 'map-1', connectionId: 'conn-001', dmChannelId: null, slackChannelId: 'C123' },
    ]);
    mockGetSlackConnection.mockResolvedValue({
      id: 'conn-001',
      teamId: 'T001',
      teamName: 'Test Workspace',
      isActive: true,
    });
    const deliverSpy = vi
      .spyOn(slackAdapterService, 'deliverToChannel')
      .mockResolvedValue(undefined);

    await slackAdapterService.deliver(
      'lens-user-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'msg-1', threadId: 'thr-1', content: 'hi', toolCalls: null } as any,
    );
    deliverSpy.mockRestore();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack message delivered',
      'lens-user-1',
      expect.objectContaining({
        'agent.id': 'agent-1',
        'slack.delivery': 'mapping',
        'slack.mappings': '1',
      }),
    );
  });

  it('broadcasts an autonomous message to the main channel only, not every linked channel', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({ agentId: 'agent-1' });
    // Two linked channels; the second is flagged main. A heartbeat must hit only it.
    mockPrisma.slackMapping.findMany.mockResolvedValue([
      { id: 'map-1', connectionId: 'conn-001', dmChannelId: null, slackChannelId: 'C_OTHER', isMainChannel: false, createdAt: new Date('2026-06-01T00:00:00Z') },
      { id: 'map-2', connectionId: 'conn-001', dmChannelId: null, slackChannelId: 'C_MAIN', isMainChannel: true, createdAt: new Date('2026-06-02T00:00:00Z') },
    ]);
    mockGetSlackConnection.mockResolvedValue({
      id: 'conn-001',
      teamId: 'T001',
      teamName: 'Test Workspace',
      isActive: true,
    });
    const deliverSpy = vi
      .spyOn(slackAdapterService, 'deliverToChannel')
      .mockResolvedValue(undefined);

    await slackAdapterService.deliver(
      'lens-user-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'msg-1', threadId: 'thr-1', content: 'hi', toolCalls: null } as any,
    );

    const deliveredChannels = deliverSpy.mock.calls.map((c) => c[0]);
    deliverSpy.mockRestore();

    expect(deliveredChannels).toEqual(['C_MAIN']);
  });
});

describe('deliverToChannel — DM channel fallback', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = slackAdapterService as any;
  const postMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    postMessage.mockResolvedValue({ ts: '1700000000.000200' });
    adapter.apps = new Map([
      ['T001', { app: { client: { chat: { postMessage } } }, teamId: 'T001' }],
    ]);
    // Stub the message-shaping + attachment helpers so the test isolates routing.
    adapter.prepareOutboundMessage = vi.fn().mockResolvedValue({ text: 'hi', blocks: undefined });
    adapter.uploadAttachmentsToSlack = vi.fn().mockResolvedValue(undefined);
  });

  it('posts to a DM channel id even though it has no channel mapping (thread-bound DM continuation)', async () => {
    // DMs live on dmChannelId, so findByChannelId (which looks up slackChannelId)
    // returns null — the fallback must resolve the single connection and post anyway.
    mockSlackMappingService.findByChannelId.mockResolvedValue(null);
    mockGetSlackConnection.mockResolvedValue({ id: 'conn-001', teamId: 'T001', isActive: true });

    await adapter.deliverToChannel('D07ERBJA69M', 'hi', 'thr-1');

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D07ERBJA69M', thread_ts: undefined, text: 'hi' }),
    );
  });

  it('does not post when neither a channel mapping nor a Slack connection resolves', async () => {
    mockSlackMappingService.findByChannelId.mockResolvedValue(null);
    mockGetSlackConnection.mockResolvedValue(null);

    await adapter.deliverToChannel('D07ERBJA69M', 'hi', 'thr-1');

    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('deliverToChannel — working status after posting', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = slackAdapterService as any;
  const postMessage = vi.fn();
  const setStatus = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    postMessage.mockResolvedValue({ ts: '1700000000.000300' });
    setStatus.mockResolvedValue({ ok: true });
    adapter.apps = new Map([
      ['T001', {
        app: { client: { chat: { postMessage }, assistant: { threads: { setStatus } } } },
        teamId: 'T001',
      }],
    ]);
    adapter.prepareOutboundMessage = vi.fn().mockResolvedValue({ text: 'hi', blocks: undefined });
    adapter.uploadAttachmentsToSlack = vi.fn().mockResolvedValue(undefined);
    mockSlackMappingService.findByChannelId.mockResolvedValue({
      slackChannelName: 'general',
      connection: { teamId: 'T001' },
    });
    // The module-level conversationService mock is a bare {} — a threaded
    // delivery calls setExternalId, which must resolve for the post-send
    // hooks to run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conversationService as any).setExternalId = vi.fn().mockResolvedValue(undefined);
  });

  it('sets the current status again after posting into a thread with a live turn', async () => {
    const handle = await adapter.workingIndicator.begin({
      teamId: 'T001',
      channelId: 'C_CHAN',
      statusThreadTs: '123.000',
    });
    setStatus.mockClear(); // drop the initial set

    // A mid-turn post into the thread — Slack cleared the status server-side.
    await adapter.deliverToChannel('C_CHAN', 'hi', 'thr-1', '123.000');
    await new Promise((r) => setTimeout(r, 0)); // flush the indicator's op chain

    expect(setStatus).toHaveBeenCalledExactlyOnceWith({
      channel_id: 'C_CHAN',
      thread_ts: '123.000',
      status: 'is thinking…',
    });
    expect(setStatus.mock.invocationCallOrder[0]).toBeGreaterThan(
      postMessage.mock.invocationCallOrder[0],
    );

    await handle.end();
  });

  it('does not touch the status when no turn is live on the thread', async () => {
    await adapter.deliverToChannel('C_CHAN', 'hi', 'thr-1', '123.000');

    expect(postMessage).toHaveBeenCalledOnce();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe('setAssistantStatus — rejects when the status cannot be set', () => {
  // The rejection is the working indicator's fallback signal, so the contract
  // is pinned here: resolve = Slack accepted, reject = show the reaction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = slackAdapterService as any;
  const setStatus = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    adapter.apps = new Map([
      ['T001', {
        app: { client: { assistant: { threads: { setStatus } } } },
        teamId: 'T001',
      }],
    ]);
  });

  it('resolves when the Slack call succeeds', async () => {
    setStatus.mockResolvedValue({ ok: true });

    await expect(
      adapter.setAssistantStatus('T001', 'C001', '123.000', 'is thinking…'),
    ).resolves.toBeUndefined();
  });

  it('rejects when the Slack call fails', async () => {
    setStatus.mockRejectedValue(new Error('feature_not_enabled'));

    await expect(
      adapter.setAssistantStatus('T001', 'C001', '123.000', 'is thinking…'),
    ).rejects.toThrow('feature_not_enabled');
  });

  it('rejects when there is no Bolt app for the team', async () => {
    await expect(
      adapter.setAssistantStatus('T999', 'C001', '123.000', 'is thinking…'),
    ).rejects.toThrow('no Slack app for team T999');
  });
});

describe('Requirement: Slack routes messages nobody replied to', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('threadDestination', () => {
    it('recovers the thread_ts and channel for a channel-bound thread, labelled by its id', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: '1700000000.000100',
        externalChannelId: 'C123',
        threadSource: 'SLACK',
        userId: 'user-123',
        agentId: 'agent-123',
      });

      expect(await slackAdapterService.threadDestination('thread-1', 'C123')).toEqual({
        channelId: 'C123',
        channelThreadId: '1700000000.000100',
        channelLabel: 'the team Slack channel **#C123**',
      });
      // A known channel id means no DM fallback lookup is needed.
      expect(mockPrisma.slackMapping.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the user DM channel for a DM-originated thread with no channel id', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: null,
        externalChannelId: null,
        userId: 'user-123',
        agentId: 'agent-123',
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValue({ dmChannelId: 'D999' });

      // Scoped to the DM channel, so delivery does not broadcast to every mapping.
      expect(await slackAdapterService.threadDestination('thread-1')).toEqual({
        channelId: 'D999',
        channelThreadId: undefined,
        channelLabel: 'the team Slack channel **#D999**',
      });
      expect(mockPrisma.slackMapping.findFirst).toHaveBeenCalledWith({
        where: { lensUserId: 'user-123', agentId: 'agent-123', dmChannelId: { not: null } },
        select: { dmChannelId: true },
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does NOT treat a top-level DM thread externalThreadId as a thread_ts', async () => {
      // Top-level DMs are threadSource=DATABASE and store the dmChannelId in
      // externalThreadId. A continuation posts top-level into the DM channel,
      // NOT with thread_ts=dmChannelId (an invalid Slack ts).
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: 'D07ERBJA69M',
        externalChannelId: null,
        threadSource: 'DATABASE',
        userId: 'user-123',
        agentId: 'agent-123',
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValue({ dmChannelId: 'D07ERBJA69M' });

      expect(await slackAdapterService.threadDestination('thread-1')).toEqual({
        channelId: 'D07ERBJA69M',
        channelThreadId: undefined,
        channelLabel: 'the team Slack channel **#D07ERBJA69M**',
      });
    });

    it('warns when no channel can be resolved (undeliverable resume)', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: null,
        externalChannelId: null,
        userId: 'user-123',
        agentId: 'agent-123',
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValue(null);

      const destination = await slackAdapterService.threadDestination('thread-1');

      // Not rerouted to the main channel: logged and left undelivered.
      expect(destination.channelId).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No Slack channel resolved'), 'thread-1');
    });
  });

  describe('defaultDestination', () => {
    it('picks the DM channel first', async () => {
      mockPrisma.slackMapping.findFirst.mockResolvedValue({ dmChannelId: 'D123' });

      expect(await slackAdapterService.defaultDestination('agent-1', 'user-1')).toEqual({ threadKey: 'D123' });
      expect(mockSlackMappingService.getMainChannel).not.toHaveBeenCalled();
    });

    it('falls back to the main channel, with no channel id so delivery uses the mapping', async () => {
      mockPrisma.slackMapping.findFirst.mockResolvedValue(null);
      mockSlackMappingService.getMainChannel.mockResolvedValue('C_MAIN');

      expect(await slackAdapterService.defaultDestination('agent-1', 'user-1')).toEqual({ threadKey: 'C_MAIN' });
    });

    it('has none when Slack is not linked', async () => {
      mockPrisma.slackMapping.findFirst.mockResolvedValue(null);
      mockSlackMappingService.getMainChannel.mockResolvedValue(null);

      expect(await slackAdapterService.defaultDestination('agent-1', 'user-1')).toBeNull();
    });
  });

  describe('linkedChannelIds', () => {
    it("lists the agent's linked channels", async () => {
      mockSlackMappingService.listChannelIds.mockResolvedValue(['C_MAIN', 'C_REL']);

      expect(await slackAdapterService.linkedChannelIds('agent-1')).toEqual(['C_MAIN', 'C_REL']);
      expect(mockSlackMappingService.listChannelIds).toHaveBeenCalledWith('agent-1');
    });
  });
});
