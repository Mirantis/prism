/**
 * Slack Heartbeat Trigger Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    slackHeartbeatTrigger: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
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
