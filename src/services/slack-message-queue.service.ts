/**
 * Slack Message Queue Service
 *
 * Persists pending Slack messages for heartbeat triggers in the database.
 * Messages are enqueued when a Slack message arrives in a heartbeat trigger channel,
 * and drained atomically by the agent-runtime when processing a heartbeat.
 */

import prisma from '../lib/prisma';
import { logger } from '../logger';
import { SlackTriggerMessage } from '../types';

class SlackMessageQueueService {
  async enqueue(agentId: string, message: SlackTriggerMessage): Promise<void> {
    logger.info(`[SlackMessageQueue] Enqueuing message for agent ${agentId.substring(0, 8)} from sender ${message.sender}`);
    await prisma.pendingSlackMessage.create({
      data: {
        agentId,
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
      },
    });
  }

  async drain(agentId: string): Promise<SlackTriggerMessage[]> {
    logger.info(`[SlackMessageQueue] Draining messages for agent ${agentId.substring(0, 8)}`);
    return prisma.$transaction(async (tx) => {
      const rows = await tx.pendingSlackMessage.findMany({
        where: { agentId },
        orderBy: { createdAt: 'asc' },
      });

      if (rows.length === 0) return [];

      await tx.pendingSlackMessage.deleteMany({
        where: { agentId },
      });

      return rows.map((row) => ({
        sender: row.sender,
        text: row.text,
        timestamp: row.timestamp,
      }));
    });
  }
}

export const slackMessageQueueService = new SlackMessageQueueService();
