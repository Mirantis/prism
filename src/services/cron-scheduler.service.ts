/**
 * Cron Scheduler Service (Agent-Runtime)
 *
 * Manages user-scheduled tasks using cron expressions.
 * Invokes the LLM directly (in-process) and communicates with
 * the backend via the internal REST API.
 *
 * Supports three schedule types:
 * - "at" / "in" — one-shot: "in 20 minutes", "at 3pm"
 * - "every" — interval: "every 2 hours"
 * - cron expression: "0 9 * * *" (9am daily)
 */

import * as cron from 'node-cron';
import { invoke } from '../invoke';
import { messageDeliveryService } from './message-delivery.service';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

/** Shape received from the backend management API (JSON-serialized dates). */
export interface BackendCronTask {
  id: string;
  agentId: string;
  userId: string;
  name: string;
  schedule: string;
  instruction: string;
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduledJob {
  task: BackendCronTask;
  job: { stop: () => void };
  isOneShot: boolean;
}

// ============================================================================
// Cron Scheduler Service
// ============================================================================

class CronSchedulerService {
  private scheduledJobs: Map<string, ScheduledJob> = new Map();

  /**
   * List active cron tasks from the database.
   * Called during startup to initialize the scheduler.
   * If `agentId` is provided, limits the result to that agent so the
   * container's scheduler doesn't pick up other agents' tasks.
   */
  async listActiveCronTasks(agentId?: string): Promise<BackendCronTask[]> {
    const rows = await prisma.cronTask.findMany({
      where: agentId ? { isActive: true, agentId } : { isActive: true },
    });
    return rows.map((row) => ({
      ...row,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * Schedule a task from a BackendCronTask record.
   * Called on fresh creations (agent tool, management route) and during
   * startup re-registration (`source: 'boot'`).
   *
   * Single owner of the 'cron task scheduled' telemetry event — callers must
   * not emit it themselves. Boot re-registrations are not new schedules, so
   * they don't emit.
   */
  scheduleTask(task: BackendCronTask, opts: { source?: 'create' | 'boot' } = {}): void {
    if (!task.userId) {
      logger.error(`[CronScheduler] Refusing to schedule "${task.name}" — missing userId`);
      return;
    }

    this.stopJob(task.id);

    if (!task.isActive) {
      return;
    }

    const isOneShot = !!(task.nextRunAt && !cron.validate(task.schedule));

    if (opts.source !== 'boot') {
      trackEvent('cron task scheduled', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.task.name': task.name,
        'cron.schedule': task.schedule,
        'cron.one_shot': String(isOneShot),
      });
    }

    if (isOneShot) {
      const nextRunAt = task.nextRunAt ? new Date(task.nextRunAt).getTime() : 0;
      const delay = nextRunAt - Date.now();

      if (delay > 0) {
        const timeoutId = setTimeout(async () => {
          await this.executeTask(task);
          // Auto-delete one-shot tasks
          try {
            await this.deleteCronTask(task.id);
          } catch (err) {
            logger.error({ err }, `[CronScheduler] Failed to delete one-shot task ${task.id}`);
          }
          this.scheduledJobs.delete(task.id);
        }, delay);

        this.scheduledJobs.set(task.id, {
          task,
          job: { stop: () => clearTimeout(timeoutId) },
          isOneShot: true,
        });

        logger.info(`[CronScheduler] Scheduled one-shot "${task.name}" in ${Math.round(delay / 1000)}s`);
      } else if (task.nextRunAt) {
        logger.info(`[CronScheduler] One-shot "${task.name}" was past due - executing now`);
        setImmediate(async () => {
          await this.executeTask(task);
          try {
            await this.deleteCronTask(task.id);
          } catch (err) {
            logger.error({ err }, `[CronScheduler] Failed to delete one-shot task ${task.id}`);
          }
        });
      }
    } else {
      if (!cron.validate(task.schedule)) {
        logger.error(`[CronScheduler] Invalid cron expression for "${task.name}": ${task.schedule}`);
        return;
      }

      const job = cron.schedule(task.schedule, async () => {
        await this.executeTask(task);
      });

      this.scheduledJobs.set(task.id, {
        task,
        job,
        isOneShot: false,
      });

      logger.info(`[CronScheduler] Scheduled recurring "${task.name}": ${task.schedule}`);
    }
  }

  /**
   * Remove a task on user deletion (agent tool, management route).
   *
   * Single owner of the 'cron task deleted' telemetry event — callers must
   * not emit it themselves. Internal re-registration uses `stopJob` directly
   * so it never emits.
   */
  unscheduleTask(taskId: string, userId?: string): void {
    this.stopJob(taskId);
    trackEvent('cron task deleted', userId ?? null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'cron.task.id': taskId,
    });
  }

  /** Stop and drop the in-memory job, with no telemetry side effects. */
  private stopJob(taskId: string): void {
    const scheduled = this.scheduledJobs.get(taskId);
    if (scheduled) {
      scheduled.job.stop();
      this.scheduledJobs.delete(taskId);
    }
  }

  private async updateCronTaskRun(taskId: string, lastRunAt: string): Promise<void> {
    await prisma.cronTask.update({
      where: { id: taskId },
      data: { lastRunAt: lastRunAt ? new Date(lastRunAt) : new Date() },
    });
  }

  private async deleteCronTask(taskId: string): Promise<void> {
    await prisma.cronTask.delete({ where: { id: taskId } });
  }

  private async executeTask(task: BackendCronTask): Promise<void> {
    const startTime = Date.now();

    logger.info(`[CronScheduler] Executing "${task.name}" for user ${task.userId}`);

    const trackRun = (result: 'completed' | 'budget_exceeded' | 'error') =>
      trackEvent('cron task executed', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.task.name': task.name,
        'cron.result': result,
        'cron.duration_ms': String(Date.now() - startTime),
      });

    try {
      // Invoke LLM directly (in-process)
      const result = await invoke({
        userId: task.userId,
        agentId: task.agentId,
        mode: 'cron',
        prompt: task.instruction,
      });

      // Budget exceeded — notify user and record the attempt
      if (result.error?.type === 'budget_exceeded') {
        await this.updateCronTaskRun(task.id, new Date().toISOString());
        await messageDeliveryService.publishToLatestThread(
          task.agentId,
          task.userId,
          `**Scheduled Task: ${task.name}**\n\nThis task could not run — your organization's AI spending limit has been reached${result.error.detail ? `: ${result.error.detail}` : ''}. Please contact your administrator to increase the budget.`,
          'CRON_TASK',
        );
        trackRun('budget_exceeded');
        return;
      }

      // Update run timestamp
      await this.updateCronTaskRun(
        task.id,
        new Date().toISOString(),
      );

      // Use only the last step's text (the final summary), not intermediate step texts
      const lastStep = result.steps[result.steps.length - 1];
      const responseText = (lastStep?.text ?? '').trim();

      await messageDeliveryService.publishToLatestThread(
        task.agentId,
        task.userId,
        `**Scheduled Task: ${task.name}**\n\n${responseText || result.response}`,
        'CRON_TASK',
        {
          toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
          attachmentIds: result.attachmentIds,
        },
      );

      logger.info(`[CronScheduler] "${task.name}" completed in ${Date.now() - startTime}ms`);
      trackRun('completed');
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[CronScheduler] "${task.name}" failed: ${errMsg}`);
      trackRun('error');
    }
  }

  stopAll(): void {
    for (const [, scheduled] of this.scheduledJobs) {
      if (scheduled?.job?.stop) {
        scheduled.job.stop();
      }
    }
    this.scheduledJobs.clear();
    logger.info('[CronScheduler] All cron tasks stopped');
  }
}

// Export singleton instance
export const cronSchedulerService = new CronSchedulerService();
