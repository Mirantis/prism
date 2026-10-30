/**
 * Cron tools — direct AI SDK tools (no MCP round trip).
 *
 * Owns DB CRUD directly and schedules/unschedules via in-process
 * cronSchedulerService.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import * as cron from 'node-cron';
import prisma from '../lib/prisma';
import { cronSchedulerService, readTaskDelivery, toBackendCronTask } from '../services/cron-scheduler.service';
import { parseSchedule } from '../services/cron-schedule';
import { DELIVER_TARGETS, parseCommaList } from '../services/delivery-target.service';
import { logger } from '../logger';
import type { ChannelName } from '../services/channel-adapter.interface';

const deliverToParam = z
  .enum(DELIVER_TARGETS)
  .describe(
    'Where the result goes: "all" (every connected channel), "chat" (web chat only), a channel ' +
    'name (its direct conversation, else its main channel), or "none" (run without posting). ' +
    'Default "all". A task that continues in the thread replies there.',
  );
const channelIdsParam = z
  .array(z.string())
  .describe('Linked channel ids of the deliverTo channel to post to, instead of its default destination');

/** A run time in the agent's time zone, with its UTC offset, such as "Oct 30, 2026, 4:00 PM GMT+2". */
function formatRunTime(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: cronSchedulerService.timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  });
}

export function getCronTools(
  userId: string,
  agentId: string,
  /** The invocation mode, for the scheduler's telemetry. */
  mode: string,
  threadId?: string,
  originChannel: ChannelName = 'websocket',
  originChannelId?: string,
): Record<string, Tool> {
  return {
    schedule_task: tool({
      description:
        'Schedule a task to run at a specific time or interval. When the user asks to be ' +
        'reminded or alerted, set it up at once; use it also to check again later on something ' +
        'that is not ready yet. Set continueInThread to resume in this conversation thread ' +
        'instead of reporting as a scheduled task — this is how you "wait" for something and ' +
        'pick the conversation back up here.',
      inputSchema: z.object({
        name: z.string().describe('Short name for the task'),
        schedule: z.string().describe('When to run: "in 30 seconds", "in 2 minutes", "every hour", "at 3pm", cron expression'),
        instruction: z.string().describe('What to do when the task runs'),
        continueInThread: z
          .boolean()
          .optional()
          .describe(
            'Continue in this conversation/thread when the task runs, instead of reporting as a ' +
            'scheduled task in the latest conversation. Use this to "wait" and resume the ' +
            'conversation here. Only valid for one-off schedules like "in 10 minutes".',
          ),
        deliverTo: deliverToParam.optional(),
        channelIds: channelIdsParam.optional(),
      }),
      execute: async ({ name, schedule, instruction, continueInThread, deliverTo, channelIds }) => {
        const { cronExpression, isOneShot, nextRunAt } = parseSchedule(schedule);

        if (!isOneShot && !cron.validate(cronExpression)) {
          throw new Error(`Invalid cron expression: ${cronExpression}`);
        }

        // Thread continuation is only meaningful for a one-off "wait then resume"
        // and needs a thread to resume in (absent on autonomous/subagent runs).
        const bindToThread = continueInThread === true;
        if (bindToThread && !isOneShot) {
          return {
            success: false,
            error: 'continueInThread only works with one-off schedules (e.g. "in 10 minutes"), not recurring ones.',
          };
        }
        if (bindToThread && !threadId) {
          return {
            success: false,
            error: 'continueInThread requires an active conversation thread to resume in.',
          };
        }
        const delivery = await readTaskDelivery({ deliverTo, channelIds }, agentId, {
          deliverTo: 'all',
          channelIds: null,
          threadId: bindToThread ? (threadId ?? null) : null,
        });
        if (!delivery.ok) return { success: false, error: delivery.error };

        const task = await prisma.cronTask.create({
          data: {
            agentId,
            userId,
            name,
            schedule: cronExpression,
            instruction,
            nextRunAt,
            ...delivery.value,
            ...(bindToThread
              ? { threadId, originChannel, originChannelId: originChannelId ?? null }
              : {}),
          },
        });

        try {
          cronSchedulerService.scheduleTask(toBackendCronTask(task), { invokeMode: mode });
        } catch (err) {
          logger.error({ err }, '[CronTool] Failed to schedule task in-process');
        }

        const when = task.nextRunAt
          ? `to run at ${formatRunTime(task.nextRunAt)}`
          : `with schedule: ${task.schedule}`;
        return {
          success: true,
          taskId: task.id,
          message: bindToThread
            ? `Scheduled "${name}" ${when} — it will continue in this conversation.`
            : `Scheduled "${name}" ${when}`,
          continueInThread: bindToThread,
          nextRunAt: task.nextRunAt?.toISOString() ?? null,
          schedule: task.schedule,
        };
      },
    }),

    list_scheduled_tasks: tool({
      description: 'List all scheduled tasks.',
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await prisma.cronTask.findMany({
          where: { userId, agentId },
          orderBy: { createdAt: 'desc' },
        });
        return {
          success: true,
          count: tasks.length,
          tasks: tasks.map(t => ({
            id: t.id,
            name: t.name,
            schedule: t.schedule,
            instruction: t.instruction,
            isActive: t.isActive,
            deliverTo: t.deliverTo,
            channelIds: parseCommaList(t.channelIds),
            nextRunAt: t.nextRunAt?.toISOString() ?? null,
            lastRunAt: t.lastRunAt?.toISOString() ?? null,
          })),
        };
      },
    }),

    update_scheduled_task: tool({
      description:
        'Change the name, schedule, instruction or delivery of a scheduled task. A field you leave out keeps its value.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID to change'),
        name: z.string().optional().describe('New short name for the task'),
        schedule: z.string().optional().describe('New time to run: "in 30 seconds", "in 2 minutes", "every hour", "at 3pm", cron expression'),
        instruction: z.string().optional().describe('New instruction: what to do when the task runs'),
        deliverTo: deliverToParam.optional(),
        channelIds: channelIdsParam.optional(),
      }),
      execute: async ({ taskId, ...changes }) => {
        const result = await cronSchedulerService.updateTask(taskId, changes, {
          owner: { userId, agentId },
          invokeMode: mode,
        });
        if (result.status !== 'updated') return { success: false, error: result.error };

        const { task } = result;
        const when = task.nextRunAt
          ? `to run at ${formatRunTime(task.nextRunAt)}`
          : `with schedule: ${task.schedule}`;
        return {
          success: true,
          taskId: task.id,
          message: `Updated "${task.name}" ${when}`,
          nextRunAt: task.nextRunAt?.toISOString() ?? null,
          schedule: task.schedule,
        };
      },
    }),

    delete_scheduled_task: tool({
      description: 'Delete a scheduled task.',
      inputSchema: z.object({
        taskId: z.string().describe('The task ID to delete'),
      }),
      execute: async ({ taskId }) => {
        const result = await prisma.cronTask.deleteMany({
          where: { id: taskId, userId, agentId },
        });

        // Only unschedule (which emits 'cron task deleted') when a row was
        // actually removed — deleting a nonexistent task is not an event.
        if (result.count > 0) {
          try {
            cronSchedulerService.unscheduleTask(taskId, userId, mode);
          } catch (err) {
            logger.error({ err }, '[CronTool] Failed to unschedule task in-process');
          }
        }

        return { success: true, message: `Deleted task ${taskId}` };
      },
    }),
  };
}
