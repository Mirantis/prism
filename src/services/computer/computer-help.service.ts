import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';

import type { MessageTrigger } from '../message-delivery.service';
import { computerService } from './computer.service';
import type { ComputerUse } from './computer-access';

export interface ComputerHelp {
  type: 'computer_help';
  id: string;
  reason: string;
  tab?: number;
  targetId?: string;
  threadId?: string;
  originChannel?: 'slack' | 'websocket';
  originChannelId?: string;
  status: 'waiting' | 'continued' | 'dismissed';
}

export function computerLink(helpId?: string): string {
  const suffix = `computer${helpId ? `?help=${encodeURIComponent(helpId)}` : ''}`;
  return config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${suffix}` : `/${suffix}`;
}

/** Help cards are conversation content; voice-only cards last for their call. */
class ComputerHelpService {
  private voice = new Map<string, ComputerHelp>();

  async request(use: ComputerUse, reason: string, tab?: number): Promise<ComputerHelp> {
    const help: ComputerHelp = {
      type: 'computer_help',
      id: randomUUID(),
      reason,
      tab,
      targetId: await computerService.helpTarget(tab),
      status: 'waiting',
      threadId: use.threadId,
      originChannel: use.originChannel,
      originChannelId: use.originChannelId,
    };
    if (use.mode === 'voice') {
      this.voice.set(`${use.id}/${help.id}`, help);
    } else {
      const { conversationService } = await import('../conversation.service');
      const { messageDeliveryService } = await import('../message-delivery.service');
      help.threadId ??= (
        await conversationService.getOrCreateLatestThread(use.agentId, use.userId)
      ).id;
      const channelContext = await conversationService.getChannelContext(
        help.threadId,
        use.originChannel,
        use.originChannelId,
      );
      const trigger: MessageTrigger =
        use.mode === 'goal'
          ? 'GOAL'
          : use.mode === 'cron'
            ? 'CRON_TASK'
            : use.mode === 'heartbeat'
              ? 'HEARTBEAT'
              : use.mode === 'webhook'
                ? 'WEBHOOK'
                : 'USER_INPUT';
      const link =
        config.publicUrl || channelContext.channel === 'websocket'
          ? `[Open Computer](${computerLink(help.id)})`
          : 'Open Computer in the Prism Web UI.';
      await messageDeliveryService.publish(
        use.userId,
        help.threadId,
        `${reason}\n\n${link}\n\nTell me when you are ready to continue.`,
        trigger,
        {
          blocks: [help],
          channelContext,
        },
      );
    }
    computerService.access.yield(use);
    trackEvent('computer help requested', use.userId, {
      'agent.id': use.agentId,
      'computer.help_id': help.id,
    });
    computerService.access.emit('change');
    return help;
  }

  async list(agentId: string, userId: string, threadId?: string): Promise<ComputerHelp[]> {
    const messages = await prisma.conversationMessage.findMany({
      where: {
        thread: { agentId, userId },
        ...(threadId ? { threadId } : {}),
        blocks: { path: '$[0].type', equals: 'computer_help' },
      },
      select: { blocks: true },
      orderBy: { createdAt: 'asc' },
    });
    return [
      ...messages.flatMap((row) => row.blocks as unknown as ComputerHelp[]),
      ...(!threadId ? this.voice.values() : []),
    ];
  }

  async resolve(
    agentId: string,
    userId: string,
    id: string,
    status: 'continued' | 'dismissed',
  ): Promise<ComputerHelp | null> {
    const voice = [...this.voice.values()].find((help) => help.id === id);
    if (voice) {
      if (voice.status !== 'waiting') return null;
      voice.status = status;
      this.resolved(agentId, userId, voice);
      return voice;
    }
    const row = await prisma.conversationMessage.findFirst({
      where: { thread: { agentId, userId }, blocks: { path: '$[0].id', equals: id } },
      select: { id: true, blocks: true },
    });
    if (!row) throw new Error('Help request not found.');
    const help = (row.blocks as unknown as ComputerHelp[])[0];
    if (help.status !== 'waiting') return null;
    const updated = { ...help, status };
    const result = await prisma.conversationMessage.updateMany({
      where: { id: row.id, blocks: { path: '$[0].status', equals: 'waiting' } },
      data: { blocks: [updated] as unknown as Prisma.InputJsonValue },
    });
    if (!result.count) return null;
    this.resolved(agentId, userId, updated);
    return updated;
  }

  async continueRequest(
    agentId: string,
    userId: string,
    id: string,
    action: 'continue' | 'dismiss',
    clientId?: string,
  ): Promise<void> {
    if (action === 'continue' && computerService.access.paused) {
      if (!clientId) throw new Error('Hand control back in Computer first.');
      computerService.assertCanHandBack(clientId);
    }
    const help = await this.resolve(
      agentId,
      userId,
      id,
      action === 'continue' ? 'continued' : 'dismissed',
    );
    if (!help || action === 'dismiss') return;
    if (computerService.access.paused) {
      if (!clientId) throw new Error('Hand control back in Computer first.');
      await computerService.handBack(clientId);
    }
    if (!help.threadId) {
      const { voiceChatService } = await import('../voice/voice-chat.service');
      voiceChatService.continueComputer(help.reason);
      return;
    }
    if (await this.resumeGoal(agentId, userId, help)) return;
    const { conversationService } = await import('../conversation.service');
    const { conversationEngineService } = await import('../conversation-engine.service');
    const context = await conversationService.getChannelContext(
      help.threadId,
      help.originChannel,
      help.originChannelId,
    );
    void conversationEngineService
      .chat({
        userId,
        agentId,
        threadId: help.threadId,
        message: `I finished helping with the computer. The help request was: ${JSON.stringify(help.reason)}\n\nInspect the current screen, then continue the original request.`,
        metadata: {
          channel: context.channel,
          channelId: context.channelId,
          slackThreadTs: context.threadTs,
        },
      })
      .catch((error) => logger.error({ err: error }, '[Computer] Continuation failed'));
  }

  async resumeGoal(agentId: string, userId: string, help: ComputerHelp): Promise<boolean> {
    if (!help.threadId) return false;
    if ((await this.list(agentId, userId, help.threadId)).some((item) => item.status === 'waiting'))
      return false;
    const { goalService } = await import('../goal.service');
    const goal = await goalService.getGoalForThread(help.threadId);
    if (goal?.status !== 'paused' || goal.lastReason !== 'Waiting for computer help.') return false;
    await goalService.resumeGoal(goal.id);
    return true;
  }

  private resolved(agentId: string, userId: string, help: ComputerHelp): void {
    trackEvent('computer help resolved', userId, {
      'agent.id': agentId,
      'computer.help_id': help.id,
      status: help.status,
    });
    computerService.access.emit('change');
  }

  endVoice(use: ComputerUse): void {
    for (const key of this.voice.keys()) if (key.startsWith(`${use.id}/`)) this.voice.delete(key);
    computerService.access.emit('change');
  }
}

export const computerHelpService = new ComputerHelpService();
