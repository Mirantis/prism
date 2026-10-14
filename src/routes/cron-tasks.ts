/**
 * Scheduled Task Routes
 *
 * The agent's scheduled tasks, for the Web UI and the terminal UI. Each write
 * persists the row first, then brings the in-process scheduler in line with it.
 *
 *   GET    /agents/cron-tasks             - List cron tasks
 *   POST   /agents/cron-tasks             - Create + register
 *   PATCH  /agents/cron-tasks/:taskId     - Edit + re-register
 *   DELETE /agents/cron-tasks/:taskId     - Unschedule + delete
 */

import { Router, Request, Response } from 'express';
import cron from 'node-cron';
import { Prisma, type CronTask } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../lib/prisma';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import {
  cronSchedulerService,
  toBackendCronTask,
  type CronTaskChanges,
} from '../services/cron-scheduler.service';
import { parseSchedule } from '../services/cron-schedule';

const router = Router();

/**
 * A task as the list shows it. A recurring task stores no next run; its running job knows it.
 * A one-shot's schedule is the wording it was asked in, which node-cron does not read.
 */
function toListedTask(task: CronTask) {
  return {
    ...task,
    recurring: cron.validate(task.schedule),
    nextRunAt: task.nextRunAt ?? cronSchedulerService.nextRunFor(task.id),
  };
}

function rejectField(res: Response, field: string, error: string): void {
  res.status(400).json({ error, fieldErrors: { [field]: error } });
}

function isMissingRow(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/**
 * GET /agents/cron-tasks
 * List cron tasks for an agent.
 */
router.get('/cron-tasks', async (_req: Request, res: Response) => {
  try {
    const tasks = await prisma.cronTask.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(tasks.map(toListedTask));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[CronTasks] Failed to list cron tasks for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/cron-tasks
 * Create + register a cron task. Mirrors the agent's own `schedule_task`
 * tool: persists to Prisma first, then registers in-memory via the
 * scheduler service.
 * Body: { name, schedule, instruction }
 */
router.post('/cron-tasks', async (req: Request, res: Response) => {
  try {
    // Trimmed before the check: a task without an instruction runs on its name, so a name of
    // only whitespace would be an empty prompt.
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const name = text(req.body.name);
    const schedule = text(req.body.schedule);
    const instruction = text(req.body.instruction);
    if (!name || !schedule) {
      res.status(400).json({ error: 'Missing required fields: name, schedule' });
      return;
    }

    const agent = await agentWorkspaceService.getAgent();

    const { cronExpression, isOneShot, nextRunAt } = parseSchedule(schedule);
    if (!isOneShot && !cron.validate(cronExpression)) {
      rejectField(res, 'schedule', `Invalid cron expression: ${cronExpression}`);
      return;
    }

    const task = await prisma.cronTask.create({
      data: {
        agentId: agent.id,
        userId: agent.userId,
        name,
        schedule: cronExpression,
        instruction,
        nextRunAt,
      },
    });

    cronSchedulerService.scheduleTask(toBackendCronTask(task));

    res.status(201).json(task);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[CronTasks] Failed to create cron task for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/cron-tasks/:taskId
 * Edit a task and re-register it. A field the body leaves out keeps its value, and a schedule
 * the body gives is read again from now.
 * Body: { name?, schedule?, instruction? }, at least one of them
 */
router.patch('/cron-tasks/:taskId', async (req: Request<{ taskId: string }>, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changes: CronTaskChanges = {};
    for (const field of ['name', 'schedule', 'instruction'] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        rejectField(res, field, `${field} must be a string`);
        return;
      }
      changes[field] = value;
    }
    if (Object.keys(changes).length === 0) {
      res.status(400).json({ error: 'Nothing to change: send a name, a schedule or an instruction' });
      return;
    }

    const result = await cronSchedulerService.updateTask(req.params.taskId, changes);
    if (result.status === 'invalid') {
      rejectField(res, result.field, result.error);
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: result.error });
      return;
    }
    if (result.status === 'running') {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json(toListedTask(result.task));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[CronTasks] Failed to update cron task ${req.params.taskId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/cron-tasks/:taskId
 * Unschedule + delete a cron task.
 */
router.delete('/cron-tasks/:taskId', async (req: Request<{ taskId: string }>, res: Response) => {
  try {
    const { taskId } = req.params;
    try {
      await prisma.cronTask.delete({ where: { id: taskId } });
    } catch (err) {
      if (isMissingRow(err)) {
        res.status(404).json({ error: 'Cron task not found' });
        return;
      }
      throw err;
    }
    // After the confirmed delete so the 'cron task deleted' event (owned by
    // unscheduleTask) never fires for nonexistent tasks.
    cronSchedulerService.unscheduleTask(taskId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[CronTasks] Failed to delete cron task ${req.params.taskId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export { router as cronTasksRouter };
