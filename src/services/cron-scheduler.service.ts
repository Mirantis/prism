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
import { conversationService } from './conversation.service';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { isTimezone } from '../lib/timezone';
import { runClassificationGate } from '../lib/classification-gate';
import { CRON_TASK_GATE_PROMPT, buildCronGateUserMessage } from '../prompts/cron-prompt';
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
  /**
   * When set, the task "continues" the originating conversation in this thread
   * instead of broadcasting to the user's latest thread. originChannel/
   * originChannelId drive channel-neutral scoped delivery (see executeTask).
   */
  threadId: string | null;
  originChannel: string | null;
  originChannelId: string | null;
}

interface ScheduledJob {
  task: BackendCronTask;
  /** A node-cron task for a recurring schedule, or the timer of a one-shot. */
  job: { stop: () => void; getNextRun?: () => Date | null };
  isOneShot: boolean;
}

// ============================================================================
// Cron Scheduler Service
// ============================================================================

class CronSchedulerService {
  private scheduledJobs: Map<string, ScheduledJob> = new Map();
  /** The zone every recurring schedule is read in: the agent's setting, set at boot and on change. */
  private timezone = 'UTC';

  /**
   * Per-task delivery baseline for the suppression gate (heartbeat parity:
   * in-memory only, resets on restart). Advanced only when a run actually
   * delivers, so suppressed runs keep comparing against the last text the
   * user saw.
   */
  private lastDelivered: Map<string, { text: string; at: number }> = new Map();

  /**
   * Tasks with a run currently in flight. node-cron fires ticks regardless of
   * whether the previous run finished, so a run outlasting its interval would
   * otherwise overlap itself — double-delivering and racing the delivery
   * baseline. An overlapping tick is skipped, not queued.
   */
  private runningTasks: Set<string> = new Set();

  /** Whether any cron task run is currently in flight. */
  hasRunningTask(): boolean {
    return this.runningTasks.size > 0;
  }

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
   * Read every recurring schedule in this zone from now on. A running job is replaced, so its
   * next tick moves with the zone; the task's instruction is unchanged, so its delivery
   * baseline stays. A name Intl rejects is logged and UTC is used instead, since node-cron
   * throws on it.
   */
  useTimezone(timezone: string): void {
    const accepted = isTimezone(timezone);
    if (!accepted) {
      logger.error(`[CronScheduler] Unknown time zone "${timezone}"; recurring tasks run in UTC`);
    }
    this.timezone = accepted ? timezone : 'UTC';
    for (const scheduled of [...this.scheduledJobs.values()]) {
      if (scheduled.isOneShot) continue;
      scheduled.job.stop();
      this.registerRecurring(scheduled.task);
    }
  }

  /** Start the node-cron job for a recurring task in the current zone and hold it. */
  private registerRecurring(task: BackendCronTask): void {
    const job = cron.schedule(
      task.schedule,
      async () => {
        await this.executeTask(task);
      },
      { timezone: this.timezone },
    );
    this.scheduledJobs.set(task.id, { task, job, isOneShot: false });
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

    const isOneShot = Boolean(task.nextRunAt && !cron.validate(task.schedule));

    if (opts.source !== 'boot') {
      trackEvent('cron task scheduled', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.task.name': task.name,
        'cron.schedule': task.schedule,
        'cron.one_shot': String(isOneShot),
        'cron.continue_in_thread': String(Boolean(task.threadId)),
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
          this.lastDelivered.delete(task.id);
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
          this.lastDelivered.delete(task.id);
        });
      }
    } else {
      if (!cron.validate(task.schedule)) {
        logger.error(`[CronScheduler] Invalid cron expression for "${task.name}": ${task.schedule}`);
        return;
      }

      this.registerRecurring(task);
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

  /**
   * When a task next runs: the stored time of a one-shot, else what its running cron job
   * reports. Null for a task this process has not scheduled, such as a paused one.
   */
  nextRunFor(taskId: string): Date | null {
    const scheduled = this.scheduledJobs.get(taskId);
    if (!scheduled) return null;
    if (scheduled.isOneShot) {
      return scheduled.task.nextRunAt ? new Date(scheduled.task.nextRunAt) : null;
    }
    return scheduled.job.getNextRun?.() ?? null;
  }

  /** Stop and drop the in-memory job, with no telemetry side effects. */
  private stopJob(taskId: string): void {
    const scheduled = this.scheduledJobs.get(taskId);
    if (scheduled) {
      scheduled.job.stop();
      this.scheduledJobs.delete(taskId);
    }
    // Re-scheduling may change the instruction, so the delivery baseline
    // must not carry over.
    this.lastDelivered.delete(taskId);
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
    if (this.runningTasks.has(task.id)) {
      logger.warn(`[CronScheduler] "${task.name}" is still running — skipping overlapping run`);
      return;
    }
    this.runningTasks.add(task.id);

    const startTime = Date.now();
    const boundThreadId = task.threadId;

    logger.info(`[CronScheduler] Executing "${task.name}" for user ${task.userId}`);

    const trackRun = (result: 'completed' | 'suppressed' | 'budget_exceeded' | 'error') =>
      trackEvent('cron task executed', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.task.name': task.name,
        'cron.result': result,
        'cron.continue_in_thread': String(Boolean(boundThreadId)),
        'cron.duration_ms': String(Date.now() - startTime),
      });

    try {
      // A thread-bound ("continue in this conversation") task resumes in its
      // originating thread; make sure that thread still exists before invoking —
      // it may have been deleted since scheduling (the cascade removes the row,
      // but the in-memory one-shot timer can still fire).
      if (boundThreadId) {
        const thread = await prisma.conversationThread.findUnique({
          where: { id: boundThreadId },
          select: { id: true },
        });
        if (!thread) {
          logger.warn(`[CronScheduler] "${task.name}" thread ${boundThreadId} is gone — skipping`);
          return;
        }
      }

      // Invoke LLM directly (in-process). A bound task runs against its thread so
      // it sees the conversation history (see includeConversation in invoke.ts)
      // and can re-schedule another "wait" to keep polling in-thread.
      const result = await invoke({
        userId: task.userId,
        agentId: task.agentId,
        mode: 'cron',
        prompt: task.instruction,
        ...(boundThreadId
          ? {
              threadId: boundThreadId,
              originChannel: (task.originChannel as 'slack' | 'websocket' | null) ?? undefined,
              originChannelId: task.originChannelId ?? undefined,
            }
          : {}),
      });

      // Build channel-neutral routing for a bound task once (Slack thread_ts /
      // WebSocket session recovered from the thread row); undefined for unbound.
      const channelContext = boundThreadId
        ? await conversationService.getChannelContext(boundThreadId, task.originChannel, task.originChannelId)
        : undefined;

      // Budget exceeded — notify user and record the attempt
      if (result.error?.type === 'budget_exceeded') {
        await this.updateCronTaskRun(task.id, new Date().toISOString());
        const budgetMessage = `**Scheduled Task: ${task.name}**\n\nThis task could not run — your organization's AI spending limit has been reached${result.error.detail ? `: ${result.error.detail}` : ''}. Please contact your administrator to increase the budget.`;
        if (boundThreadId) {
          await messageDeliveryService.publish(task.userId, boundThreadId, budgetMessage, 'CRON_TASK', { channelContext });
        } else {
          await messageDeliveryService.publishToLatestThread(task.agentId, task.userId, budgetMessage, 'CRON_TASK');
        }
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
      const body = responseText || result.response;

      // Suppression ladder: an empty result is suppressed outright; a run that
      // ended in an error message is always delivered (an error is never
      // "nothing to report"); the classification gate decides the rest. The
      // gate sees the task instruction — so unconditional "send me X" tasks
      // always deliver, even when the text repeats — and the last delivered
      // result, so a conditional check that merely repeats it stays quiet.
      // No pre-gate duplicate short-circuit here (unlike the heartbeat):
      // it would silence unconditional tasks whose output is legitimately
      // identical run after run, e.g. an hourly fixed-text reminder.
      const prior = this.lastDelivered.get(task.id) ?? null;
      let shouldDeliver: boolean;
      if (!body.trim()) {
        shouldDeliver = false;
      } else if (result.error) {
        shouldDeliver = true;
      } else {
        shouldDeliver = await runClassificationGate({
          system: CRON_TASK_GATE_PROMPT,
          user: buildCronGateUserMessage({
            instruction: task.instruction,
            resultText: body,
            lastDeliveredText: prior?.text ?? null,
            lastDeliveredAt: prior?.at ?? null,
          }),
          functionId: 'cron-gate',
          userId: task.userId,
          agentId: task.agentId,
          logLabel: 'CronScheduler:Gate',
        });
      }

      if (!shouldDeliver) {
        // A suppressed run whose text no longer matches the delivered baseline
        // means the situation changed while we stayed quiet (e.g. the incident
        // resolved into an all-clear). Drop the baseline so a later recurrence
        // reads as a new finding, not as a repeat of the stale one.
        if (prior && body.trim() !== prior.text) {
          this.lastDelivered.delete(task.id);
        }
        logger.info(`[CronScheduler] "${task.name}" suppressed — nothing new to report`);
        trackRun('suppressed');
        return;
      }

      if (boundThreadId) {
        // Thread-bound: deliver as a natural continuation of the conversation
        // (no "Scheduled Task" header), scoped to the originating channel/thread.
        await messageDeliveryService.publish(task.userId, boundThreadId, body, 'CRON_TASK', {
          toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
          attachmentIds: result.attachmentIds,
          channelContext,
        });
      } else {
        await messageDeliveryService.publishToLatestThread(
          task.agentId,
          task.userId,
          `**Scheduled Task: ${task.name}**\n\n${body}`,
          'CRON_TASK',
          {
            toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
            attachmentIds: result.attachmentIds,
          },
        );
      }

      // Advance the delivery baseline only on an actual delivery (heartbeat
      // recordAlert parity), keyed on the un-headered body so the unbound
      // "**Scheduled Task: …**" header can't defeat the comparison.
      this.lastDelivered.set(task.id, { text: body.trim(), at: Date.now() });

      logger.info(`[CronScheduler] "${task.name}" completed in ${Date.now() - startTime}ms`);
      trackRun('completed');
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[CronScheduler] "${task.name}" failed: ${errMsg}`);
      trackRun('error');
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  stopAll(): void {
    for (const [, scheduled] of this.scheduledJobs) {
      if (scheduled?.job?.stop) {
        scheduled.job.stop();
      }
    }
    this.scheduledJobs.clear();
    this.lastDelivered.clear();
    logger.info('[CronScheduler] All cron tasks stopped');
  }
}

// Export singleton instance
export const cronSchedulerService = new CronSchedulerService();
