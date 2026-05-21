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
  mockBackendClient,
  mockSlackMappingService,
  mockSlackHeartbeatTriggerService,
} = vi.hoisted(() => ({
  mockPrisma: {
    slackVerificationCode: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockBackendClient: {
    getSlackConnection: vi.fn(),
    getActiveSlackConnections: vi.fn(),
  },
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
vi.mock('../../lib/backend-client', () => ({ backendClient: mockBackendClient }));
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
vi.mock('../../utils/encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('../../utils/slack-formatter', () => ({ formatSlackMessage: (s: string) => s }));
vi.mock('@slack/bolt', () => ({
  App: class {},
  LogLevel: { INFO: 'info' },
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Pin singleAgentMode: false so the suite stays stable when CI flips
// the env (test:single-agent). Otherwise the env-flip routes
// getSlackConnection through lib/slack-source.ts and bypasses the
// backend-client mock — this whole file is multi-tenant-mode-only.
vi.mock('../../config', () => ({ config: { singleAgentMode: false } }));

import { slackAdapterService } from '../slack-adapter.service';

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
      mockBackendClient.getSlackConnection.mockResolvedValue({
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
      mockBackendClient.getSlackConnection.mockResolvedValue({
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
      mockBackendClient.getSlackConnection.mockResolvedValue({
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
      mockBackendClient.getSlackConnection.mockResolvedValue(null);

      await expect(
        slackAdapterService.disconnectAndDeactivate('conn-missing'),
      ).rejects.toThrow('Connection not found');

      expect(mockSlackMappingService.deleteByConnectionId).not.toHaveBeenCalled();
      expect(mockPrisma.slackVerificationCode.deleteMany).not.toHaveBeenCalled();
      expect(mockSlackHeartbeatTriggerService.deleteByConnectionId).not.toHaveBeenCalled();
    });
  });
});
