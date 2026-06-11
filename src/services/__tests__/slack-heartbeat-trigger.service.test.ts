/**
 * Slack Heartbeat Trigger Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    slackHeartbeatTrigger: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
}));

vi.mock('../../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

import { slackHeartbeatTriggerService } from '../slack-heartbeat-trigger.service';

describe('Requirement: Delete triggers by connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Scenario: deleteByConnectionId', () => {
    it('should delete all triggers for a connection and return the count', async () => {
      mockPrisma.slackHeartbeatTrigger.deleteMany.mockResolvedValue({ count: 2 });

      const result = await slackHeartbeatTriggerService.deleteByConnectionId('conn-001');

      expect(mockPrisma.slackHeartbeatTrigger.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: 'conn-001' },
      });
      expect(result).toBe(2);
    });

    it('should return 0 when no triggers exist for the connection', async () => {
      mockPrisma.slackHeartbeatTrigger.deleteMany.mockResolvedValue({ count: 0 });

      const result = await slackHeartbeatTriggerService.deleteByConnectionId('conn-nonexistent');

      expect(result).toBe(0);
    });
  });
});

describe('Requirement: Trigger telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits "slack heartbeat trigger created" on createTrigger', async () => {
    mockPrisma.slackHeartbeatTrigger.create.mockResolvedValue({
      id: 'trig-1',
      agentId: 'test-agent-id',
      slackChannelId: 'C123',
      throttleSeconds: 300,
    });

    await slackHeartbeatTriggerService.createTrigger('conn-001', 'C123', '#alerts', 'user-1', 300);

    expect(mockTrackEvent).toHaveBeenCalledWith('slack heartbeat trigger created', 'user-1', {
      'agent.id': 'test-agent-id',
      'trigger.id': 'trig-1',
      'slack.channel.id': 'C123',
      'trigger.throttle_seconds': '300',
    });
  });

  it('emits "slack heartbeat trigger deleted" only when a row was removed', async () => {
    mockPrisma.slackHeartbeatTrigger.deleteMany.mockResolvedValue({ count: 1 });
    await slackHeartbeatTriggerService.deleteTrigger('trig-1', 'user-1');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack heartbeat trigger deleted',
      'user-1',
      expect.objectContaining({ 'trigger.id': 'trig-1' }),
    );

    mockTrackEvent.mockClear();
    mockPrisma.slackHeartbeatTrigger.deleteMany.mockResolvedValue({ count: 0 });
    await slackHeartbeatTriggerService.deleteTrigger('trig-missing', 'user-1');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "slack heartbeat trigger updated" when the throttle update matches a row', async () => {
    mockPrisma.slackHeartbeatTrigger.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.slackHeartbeatTrigger.findUnique.mockResolvedValue({ id: 'trig-1' });

    await slackHeartbeatTriggerService.updateThrottle('trig-1', 'user-1', 600);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack heartbeat trigger updated',
      'user-1',
      expect.objectContaining({ 'trigger.id': 'trig-1', 'trigger.throttle_seconds': '600' }),
    );
  });

  it('does not emit "slack heartbeat trigger updated" when no row matched', async () => {
    mockPrisma.slackHeartbeatTrigger.updateMany.mockResolvedValue({ count: 0 });

    await slackHeartbeatTriggerService.updateThrottle('trig-missing', 'user-1', 600);

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "slack heartbeat trigger claimed" only on a successful claim', async () => {
    mockPrisma.slackHeartbeatTrigger.findFirst.mockResolvedValue({
      id: 'trig-1',
      lastTriggeredAt: null,
      throttleSeconds: 300,
    });
    mockPrisma.slackHeartbeatTrigger.updateMany.mockResolvedValue({ count: 1 });

    const result = await slackHeartbeatTriggerService.tryClaimTrigger();

    expect(result.claimed).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'slack heartbeat trigger claimed',
      null,
      expect.objectContaining({ 'trigger.id': 'trig-1' }),
    );
  });

  it('does not emit a claim event when throttled', async () => {
    mockPrisma.slackHeartbeatTrigger.findFirst.mockResolvedValue({
      id: 'trig-1',
      lastTriggeredAt: new Date(),
      throttleSeconds: 300,
    });

    const result = await slackHeartbeatTriggerService.tryClaimTrigger();

    expect(result.claimed).toBe(false);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
