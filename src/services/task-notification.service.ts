/**
 * Task Notification Service
 *
 * Owns the runtime's report that a coding task the agent started in a
 * conversation has ended. The report is stored in that conversation as a hidden
 * message under the task's id, and is then answered like any message there: a
 * turn running on the thread reads it at its next step, and otherwise a turn of
 * its own starts. The agent therefore ends its turn after it starts a task, and
 * the person can talk to it while the task runs.
 *
 * The task keeps its result until the report is stored, and the report is
 * stored at most once per task, so a restart in between sends it again exactly
 * once. From the store on, the report is a message owed an answer, which the
 * conversation engine keeps across a restart.
 */

import prisma from '../lib/prisma';
import { logger } from '../logger';
import { trackEvent } from '../lib/telemetry';
import { conversationEngineService, type ChatInput } from './conversation-engine.service';
import { conversationService } from './conversation.service';
import { messageDeliveryService } from './message-delivery.service';

/** The conversation a task reports to, as the turn that started the task found it. */
export interface TaskNotificationTarget {
  threadId: string;
  agentId: string;
  userId: string;
  /** The channel the conversation's messages come from, as `collectTools` names it. */
  originChannel?: string;
  originChannelId?: string;
}

class TaskNotificationService {
  /**
   * Store the report `text` of task `taskId` and start or steer the turn that
   * answers it. Resolves once the report is stored; the turn runs on.
   */
  async deliver(target: TaskNotificationTarget, taskId: string, text: string): Promise<void> {
    if (await prisma.conversationMessage.findUnique({ where: { id: taskId }, select: { id: true } })) return;

    const threadId = await conversationService.writableThreadId(target.threadId);
    const context = await messageDeliveryService.threadContext(threadId, target.originChannel, target.originChannelId);
    const input: Pick<ChatInput, 'agentId' | 'userId' | 'message' | 'taskNotification' | 'metadata'> = {
      agentId: target.agentId,
      userId: target.userId,
      message: text,
      taskNotification: { taskId },
      metadata: {
        channel: context.channel,
        channelId: context.channelId,
        channelThreadId: context.channelThreadId,
        channelLabel: context.channelLabel,
      },
    };
    await conversationEngineService.acceptUserMessage(input, threadId, taskId);

    const telemetry = { 'agent.id': target.agentId, 'thread.id': threadId, 'task.id': taskId };
    void conversationEngineService
      .chat({ ...input, threadId, stored: { id: taskId, titleSet: null } })
      .then((response) => {
        trackEvent('task notification delivered', target.userId, {
          ...telemetry,
          'notification.delivery': response.steered ? 'steered' : 'turn',
        });
      })
      .catch((err) => {
        logger.error({ err, threadId, taskId }, '[TaskNotification] The turn that answers the notification failed');
        trackEvent('task notification delivered', target.userId, { ...telemetry, 'notification.delivery': 'failed' });
      });
  }
}

export const taskNotificationService = new TaskNotificationService();
