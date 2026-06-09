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
  mockSlackMappingService,
  mockSlackHeartbeatTriggerService,
} = vi.hoisted(() => ({
  mockPrisma: {
    slackVerificationCode: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockGetSlackConnection: vi.fn(),
  mockSlackMappingService: {
    deleteByConnectionId: vi.fn(),
    getActiveUserMappingsWithDmChannel: vi.fn(),
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
  getActiveSlackConnections: vi.fn(),
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
vi.mock('../../queues/channel-learning.queue', () => ({ channelLearningQueue: {} }));
vi.mock('../../lib/bedrock-provider', () => ({
  isBedrockConfigured: () => false,
  getClassificationModel: vi.fn(),
}));
vi.mock('../../utils/slack-formatter', () => ({ formatSlackMessage: (s: string) => s }));
vi.mock('@slack/bolt', () => ({
  App: class {},
  LogLevel: { INFO: 'info' },
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({ config: {} }));

import { slackAdapterService } from '../slack-adapter.service';
import { attachmentService } from '../attachment.service';

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
    vi.spyOn(attachmentService, 'existsBySlackFileId').mockResolvedValue(false);
    const createSpy = vi.spyOn(attachmentService, 'createSlackAttachment');
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

  it('appendAttachmentFailures injects an actionable note telling the agent to inform the user', () => {
    const note = adapter.appendAttachmentFailures('(shared a file)', [
      { filename: 'secret.png', reason: 'Slack denied access' },
    ]);
    expect(note).toContain('(shared a file)');
    expect(note).toContain('secret.png');
    expect(note).toMatch(/tell.*the user/i);
    expect(note).toContain('files:read');
    // Counters the observed failure modes: denying the file, and shell-hunting.
    expect(note).toMatch(/no\s+file\s+was\s+attached/i);
    expect(note).toMatch(/shell/i);
  });

  it('leaves the text untouched when there are no failures', () => {
    expect(adapter.appendAttachmentFailures('hi', [])).toBe('hi');
  });
});
