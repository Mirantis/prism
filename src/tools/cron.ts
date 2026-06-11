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
import { cronSchedulerService } from '../services/cron-scheduler.service';
import { logger } from '../logger';

/**
 * Parse human-readable schedule into a cron expression.
 * Supports: "in X minutes", "at 3pm", "every 2 hours", "every day at 9am", raw cron.
 */
export function parseSchedule(schedule: string): {
  cronExpression: string;
  isOneShot: boolean;
  nextRunAt: Date | null;
} {
  const normalized = schedule.toLowerCase().trim();

  const inMatch = normalized.match(/^in\s+(\d+)\s+(minute|minutes|hour|hours|min|mins|hr|hrs)$/);
  if (inMatch) {
    const value = parseInt(inMatch[1]);
    const unit = inMatch[2];
    const ms = unit.startsWith('hour') || unit.startsWith('hr')
      ? value * 60 * 60 * 1000
      : value * 60 * 1000;

    return {
      cronExpression: schedule,
      isOneShot: true,
      nextRunAt: new Date(Date.now() + ms),
    };
  }

  const atMatch = normalized.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atMatch) {
    let hour = parseInt(atMatch[1]);
    const minute = atMatch[2] ? parseInt(atMatch[2]) : 0;
    const ampm = atMatch[3];

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);

    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    return {
      cronExpression: schedule,
      isOneShot: true,
      nextRunAt: target,
    };
  }

  const everyMatch = normalized.match(/^every\s+(\d+)\s+(minute|minutes|hour|hours|min|mins|hr|hrs)$/);
  if (everyMatch) {
    const value = parseInt(everyMatch[1]);
    const unit = everyMatch[2];

    if (unit.startsWith('hour') || unit.startsWith('hr')) {
      return { cronExpression: `0 */${value} * * *`, isOneShot: false, nextRunAt: null };
    }
    return { cronExpression: `*/${value} * * * *`, isOneShot: false, nextRunAt: null };
  }

  const dailyMatch = normalized.match(/^every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]);
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2]) : 0;
    const ampm = dailyMatch[3];

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    return { cronExpression: `${minute} ${hour} * * *`, isOneShot: false, nextRunAt: null };
  }

  return { cronExpression: schedule, isOneShot: false, nextRunAt: null };
}

export function getCronTools(
  userId: string,
  agentId: string,
): Record<string, Tool> {
  return {
    schedule_task: tool({
      description: 'Schedule a task to run at a specific time or interval.',
      inputSchema: z.object({
        name: z.string().describe('Short name for the task'),
        schedule: z.string().describe('When to run: "in 2 minutes", "every hour", "at 3pm", cron expression'),
        instruction: z.string().describe('What to do when the task runs'),
      }),
      execute: async ({ name, schedule, instruction }) => {
        const { cronExpression, isOneShot, nextRunAt } = parseSchedule(schedule);

        if (!isOneShot && !cron.validate(cronExpression)) {
          throw new Error(`Invalid cron expression: ${cronExpression}`);
        }

        const task = await prisma.cronTask.create({
          data: {
            agentId,
            userId,
            name,
            schedule: cronExpression,
            instruction,
            nextRunAt,
          },
        });

        try {
          cronSchedulerService.scheduleTask({
            id: task.id,
            agentId,
            userId,
            name: task.name,
            schedule: task.schedule,
            instruction: task.instruction,
            isActive: task.isActive,
            nextRunAt: task.nextRunAt?.toISOString() ?? null,
            lastRunAt: task.lastRunAt?.toISOString() ?? null,
            createdAt: task.createdAt.toISOString(),
            updatedAt: task.updatedAt.toISOString(),
          });
        } catch (err) {
          logger.error({ err }, '[CronTool] Failed to schedule task in-process');
        }

        return {
          success: true,
          taskId: task.id,
          message: task.nextRunAt
            ? `Scheduled "${name}" to run at ${task.nextRunAt.toLocaleString()}`
            : `Scheduled "${name}" with schedule: ${task.schedule}`,
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
            nextRunAt: t.nextRunAt?.toISOString() ?? null,
            lastRunAt: t.lastRunAt?.toISOString() ?? null,
          })),
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
            cronSchedulerService.unscheduleTask(taskId, userId);
          } catch (err) {
            logger.error({ err }, '[CronTool] Failed to unschedule task in-process');
          }
        }

        return { success: true, message: `Deleted task ${taskId}` };
      },
    }),
  };
}
