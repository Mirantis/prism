import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    pendingSlackMessage: { findMany: vi.fn() },
    slackHeartbeatTrigger: { findUnique: vi.fn() },
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { slackMessageQueueService } from '../slack-message-queue.service';

describe('SlackMessageQueueService.pending', () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the agent's trigger channel as the place of its queued messages", async () => {
    mockPrisma.pendingSlackMessage.findMany.mockResolvedValue([
      { id: 'm1', sender: 'Alice', text: 'ALERT: deploy failed', timestamp: '2026-10-30T09:00:00.000Z' },
    ]);
    mockPrisma.slackHeartbeatTrigger.findUnique.mockResolvedValue({ slackChannelId: 'C0REL0001', slackChannelName: 'releases' });

    const pending = await slackMessageQueueService.pending('agent-1');

    expect(mockPrisma.slackHeartbeatTrigger.findUnique).toHaveBeenCalledWith({ where: { agentId: 'agent-1' } });
    expect(pending).toEqual({
      ids: ['m1'],
      messages: [{ sender: 'Alice', text: 'ALERT: deploy failed', timestamp: '2026-10-30T09:00:00.000Z' }],
      place: { target: 'slack:C0REL0001', name: '#releases' },
    });
  });

  it('reads no trigger channel when nothing is queued', async () => {
    mockPrisma.pendingSlackMessage.findMany.mockResolvedValue([]);

    expect(await slackMessageQueueService.pending('agent-1')).toEqual({ ids: [], messages: [] });
    expect(mockPrisma.slackHeartbeatTrigger.findUnique).not.toHaveBeenCalled();
  });
});
