/**
 * Teams Message Queue Service
 *
 * Persists pending Teams messages for heartbeat triggers in the database.
 * Messages are enqueued when a Teams message arrives in a heartbeat trigger
 * channel, and drained atomically by the agent-runtime when processing a
 * heartbeat — the Teams analogue of `slack-message-queue.service.ts`.
 */

import prisma from '../lib/prisma';
import { logger } from '../logger';
import { ChannelTriggerMessage } from '../types';

class TeamsMessageQueueService {
  async enqueue(agentId: string, message: ChannelTriggerMessage): Promise<void> {
    logger.info(`[TeamsMessageQueue] Enqueuing message for agent ${agentId.substring(0, 8)} from sender ${message.sender}`);
    await prisma.pendingTeamsMessage.create({
      data: {
        agentId,
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
      },
    });
  }

  async drain(agentId: string): Promise<ChannelTriggerMessage[]> {
    logger.info(`[TeamsMessageQueue] Draining messages for agent ${agentId.substring(0, 8)}`);
    return prisma.$transaction(async (tx) => {
      const rows = await tx.pendingTeamsMessage.findMany({
        where: { agentId },
        orderBy: { createdAt: 'asc' },
      });

      if (rows.length === 0) return [];

      await tx.pendingTeamsMessage.deleteMany({
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

export const teamsMessageQueueService = new TeamsMessageQueueService();
