/**
 * Slack Message Queue Service
 *
 * Persists pending Slack messages for heartbeat triggers in the database.
 * Messages are enqueued when a Slack message arrives in a heartbeat trigger channel,
 * read by the heartbeat, which this queue is a trigger source of, and removed when
 * that heartbeat ends.
 */

import prisma from '../lib/prisma';
import { logger } from '../logger';
import { ChannelTriggerMessage } from '../types';
import type { HeartbeatTriggerSource, PendingTriggerMessages } from './heartbeat.service';

class SlackMessageQueueService implements HeartbeatTriggerSource {
  readonly channel = 'slack';
  readonly platform = 'Slack';

  async enqueue(agentId: string, message: ChannelTriggerMessage): Promise<void> {
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

  async pending(agentId: string): Promise<PendingTriggerMessages> {
    const rows = await prisma.pendingSlackMessage.findMany({
      where: { agentId },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length > 0) {
      logger.info(`[SlackMessageQueue] ${rows.length} message(s) pending for agent ${agentId.substring(0, 8)}`);
    }
    return {
      ids: rows.map((row) => row.id),
      messages: rows.map((row) => ({ sender: row.sender, text: row.text, timestamp: row.timestamp })),
    };
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await prisma.pendingSlackMessage.deleteMany({ where: { id: { in: ids } } });
  }
}

export const slackMessageQueueService = new SlackMessageQueueService();
