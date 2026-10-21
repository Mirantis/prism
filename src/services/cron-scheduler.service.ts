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
 *
 * A task's `nextRunAt` moves past a run only when that run completes, so a run
 * a restart interrupted, or a tick that fell while the runtime was down, is
 * still due at the next boot, which runs it once.
 */

import * as cron from 'node-cron';
import { Prisma, type CronTask } from '@prisma/client';
import { invoke } from '../invoke';
import { messageDeliveryService } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { isTimezone } from '../lib/timezone';
import { runVerdictGate } from '../lib/classification-gate';
import type { ToolRiskGateErrorCode } from '../lib/tool-risk-gate';
import type { ToolCallRecord } from '../types';
import { CRON_TASK_GATE_PROMPT, buildCronGateUserMessage } from '../prompts/cron-prompt';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { parseSchedule } from './cron-schedule';
import type { ChannelName } from './channel-adapter.interface';
import { MAX_RESUME_ATTEMPTS, pendingWorkService, type PendingWorkItem } from './pending-work.service';

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

/** A stored task in the scheduler's shape, its dates as ISO strings. */
export function toBackendCronTask(row: CronTask): BackendCronTask {
  return {
    ...row,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields an edit may change. A field left undefined keeps its value. */
export interface CronTaskChanges {
  name?: string;
  schedule?: string;
  instruction?: string;
}

export type CronTaskEdit =
  | { status: 'updated'; task: CronTask }
  | { status: 'not_found'; error: string }
  | { status: 'running'; error: string }
  | { status: 'invalid'; field: 'name' | 'schedule'; error: string };

interface ScheduledJob {
  task: BackendCronTask;
  /** A node-cron task for a recurring schedule, or the timer of a one-shot. */
  job: { stop: () => void; getNextRun?: () => Date | null };
  isOneShot: boolean;
}

/** How far back the boot looks for a tick of a task that has no stored next run. */
const MISSED_TICK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A recurring task missed a run when its last run was interrupted, or its tick
 * fell while the runtime was down: its stored next run has passed. A task stored
 * before next runs were stored has none. It missed a run when a tick of its
 * schedule fell after its last run, within the last day, which covers the
 * downtime of the upgrade that added the column.
 */
function missedRun(task: BackendCronTask, job: { match(date: Date): boolean }): boolean {
  const now = Date.now();
  if (task.nextRunAt) return new Date(task.nextRunAt).getTime() <= now;
  const since = Math.max(new Date(task.lastRunAt ?? task.createdAt).getTime(), now - MISSED_TICK_WINDOW_MS);
  // A six-field expression names the second, a five-field one the minute.
  const step = task.schedule.trim().split(/\s+/).length === 6 ? 1000 : 60_000;
  for (let tick = Math.floor(now / step) * step; tick > since; tick -= step) {
    if (job.match(new Date(tick))) return true;
  }
  return false;
}

/**
 * Whether the risk gate refused one of a run's tool calls. `invoke` records a
 * refusal as a failed call whose output is the refusal's summary with its code;
 * any other failed call has no output.
 */
function hasRiskBlockedCall(toolCalls: ToolCallRecord[]): boolean {
  return toolCalls.some((call) => {
    if (call.success || !call.output) return false;
    const { code } = JSON.parse(call.output) as { code?: ToolRiskGateErrorCode };
    return code === 'TOOL_RISK_BLOCKED' || code === 'TOOL_RISK_EVALUATION_UNAVAILABLE';
  });
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
   * Tasks with a run currently in flight, each with the run. node-cron fires ticks regardless
   * of whether the previous run finished, so a run outlasting its interval would otherwise
   * overlap itself — double-delivering and racing the delivery baseline. An overlapping tick
   * is skipped, not queued.
   */
  private runningTasks: Map<string, Promise<boolean>> = new Map();

  /** Tasks whose runs stopped the process on `MAX_RESUME_ATTEMPTS` boots in a row. The boot runs them no more. */
  private givenUp: Set<string> = new Set();

  /** One-shots that have started. Each runs, then deletes its row, so an edit is refused. */
  private firedOneShots: Set<string> = new Set();

  /**
   * Per task, the edit or one-shot start in progress. An edit reads, writes and re-registers
   * the task, and a one-shot starts only on the job it was armed with, so neither sees the
   * other halfway.
   */
  private taskLocks: Map<string, Promise<unknown>> = new Map();

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
    return rows.map(toBackendCronTask);
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

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const result = (this.taskLocks.get(taskId) ?? Promise.resolve()).then(fn);
    const settled = result.catch(() => undefined);
    this.taskLocks.set(taskId, settled);
    try {
      return await result;
    } finally {
      if (this.taskLocks.get(taskId) === settled) this.taskLocks.delete(taskId);
    }
  }

  /**
   * The boot step for runs a restart stopped. A run that is still due runs again
   * when its task is scheduled. A run the attempt bound gave up does not.
   */
  async resume(_items: PendingWorkItem[], givenUp: PendingWorkItem[]): Promise<void> {
    for (const item of givenUp) this.givenUp.add(item.key);
  }

  /** Whether the boot gives up `task`'s missed run, logging it when it does. */
  private givesUp(task: BackendCronTask): boolean {
    if (!this.givenUp.delete(task.id)) return false;
    logger.warn(
      `[CronScheduler] "${task.name}" stopped the runtime on ${MAX_RESUME_ATTEMPTS} boots in a row - skipping its missed run`,
    );
    return true;
  }

  /**
   * Start the node-cron job for a recurring task in the current zone and hold it,
   * and store when it next runs. A run in flight stores that itself when it ends.
   * At boot, a task that missed a run runs once now, before its next run is stored.
   */
  private registerRecurring(task: BackendCronTask, opts: { atBoot?: boolean } = {}): void {
    const job = cron.schedule(
      task.schedule,
      async () => {
        await this.executeTask(task);
      },
      { timezone: this.timezone },
    );
    this.scheduledJobs.set(task.id, { task, job, isOneShot: false });
    if (opts.atBoot && missedRun(task, job) && !this.givesUp(task)) {
      logger.info(`[CronScheduler] Recurring "${task.name}" missed a run - executing now`);
      void this.executeTask(task, { afterRestart: true });
    }
    if (!this.runningTasks.has(task.id)) void this.recordRun(task.id);
  }

  /**
   * Schedule a task, replacing any job it already has. `source` decides the telemetry event:
   * `cron task scheduled` for a new task, `cron task updated` for an edit, none for `boot`.
   * The scheduler owns both events. `invokeMode` is the mode of the agent run that made the
   * change. A task keeps its delivery baseline while its instruction is the same.
   */
  scheduleTask(
    task: BackendCronTask,
    opts: { source?: 'create' | 'update' | 'boot'; invokeMode?: string } = {},
  ): void {
    if (!task.userId) {
      logger.error(`[CronScheduler] Refusing to schedule "${task.name}" — missing userId`);
      return;
    }

    const previous = this.scheduledJobs.get(task.id);
    this.stopJob(task.id);
    if (previous?.task.instruction !== task.instruction) {
      this.lastDelivered.delete(task.id);
    }

    if (!task.isActive) {
      return;
    }

    const isOneShot = Boolean(task.nextRunAt && !cron.validate(task.schedule));

    if (opts.source !== 'boot') {
      trackEvent(opts.source === 'update' ? 'cron task updated' : 'cron task scheduled', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.schedule': task.schedule,
        'cron.one_shot': String(isOneShot),
        'cron.continue_in_thread': String(Boolean(task.threadId)),
        ...(opts.invokeMode ? { 'invoke.mode': opts.invokeMode } : {}),
      });
    }

    if (isOneShot) {
      const delay = new Date(task.nextRunAt as string).getTime() - Date.now();
      const atBoot = opts.source === 'boot';
      if (delay <= 0 && atBoot && this.givesUp(task)) {
        void this.deleteCronTask(task.id).catch((err) => {
          logger.error({ err }, `[CronScheduler] Failed to delete one-shot task ${task.id}`);
        });
        return;
      }
      // A one-shot due at boot may have been running when the runtime stopped.
      this.registerOneShot(task, delay, atBoot && delay <= 0);
      if (delay > 0) {
        logger.info(`[CronScheduler] Scheduled one-shot "${task.name}" in ${Math.round(delay / 1000)}s`);
      } else {
        logger.info(`[CronScheduler] One-shot "${task.name}" was past due - executing now`);
      }
    } else {
      if (!cron.validate(task.schedule)) {
        logger.error(`[CronScheduler] Invalid cron expression for "${task.name}": ${task.schedule}`);
        return;
      }

      this.registerRecurring(task, { atBoot: opts.source === 'boot' });
      logger.info(`[CronScheduler] Scheduled recurring "${task.name}": ${task.schedule}`);
    }
  }

  /**
   * Arm the timer of a one-shot and hold it. A past-due one runs at once. `afterRestart` tells
   * the model that a run of the task may have stopped part-way at a restart.
   */
  private registerOneShot(task: BackendCronTask, delay: number, afterRestart = false): void {
    const scheduled: ScheduledJob = { task, job: { stop: () => clearTimeout(timer) }, isOneShot: true };
    const timer = setTimeout(() => void this.runOneShot(scheduled, afterRestart), Math.max(0, delay));
    this.scheduledJobs.set(task.id, scheduled);
  }

  /**
   * Run a one-shot, then delete it. A run of the task's earlier schedule ends first. An edit or a
   * delete that replaced or removed this job before the start leaves this one nothing to do. One a
   * shutdown interrupts stays, and the next boot runs it.
   */
  private async runOneShot(scheduled: ScheduledJob, afterRestart: boolean): Promise<void> {
    const { task } = scheduled;
    await this.runningTasks.get(task.id);
    const started = await this.withTaskLock(task.id, async () => {
      if (this.scheduledJobs.get(task.id) !== scheduled) return false;
      this.scheduledJobs.delete(task.id);
      this.firedOneShots.add(task.id);
      return true;
    });
    if (!started) return;

    try {
      if (!(await this.executeTask(task, { afterRestart }))) return;
      try {
        await this.deleteCronTask(task.id);
      } catch (err) {
        logger.error({ err }, `[CronScheduler] Failed to delete one-shot task ${task.id}`);
      }
    } finally {
      this.firedOneShots.delete(task.id);
      this.lastDelivered.delete(task.id);
    }
  }

  /**
   * Edit a stored task and re-register it. Values are trimmed, and a schedule is read again from
   * now. `owner` limits the edit to that user's and agent's tasks, and `invokeMode` is as for
   * `scheduleTask`. An edit that changes nothing writes nothing.
   */
  async updateTask(
    taskId: string,
    changes: CronTaskChanges,
    opts: { owner?: { userId: string; agentId: string }; invokeMode?: string } = {},
  ): Promise<CronTaskEdit> {
    const name = changes.name?.trim();
    const schedule = changes.schedule?.trim();
    const instruction = changes.instruction?.trim();
    if (name === '') return { status: 'invalid', field: 'name', error: 'Name is required' };
    if (schedule === '') return { status: 'invalid', field: 'schedule', error: 'Schedule is required' };

    return this.withTaskLock(taskId, async (): Promise<CronTaskEdit> => {
      const task = await prisma.cronTask.findFirst({ where: { id: taskId, ...opts.owner } });
      if (!task) return { status: 'not_found', error: 'Cron task not found' };
      if (this.firedOneShots.has(taskId)) {
        return { status: 'running', error: 'This task is running now, and it is removed when the run ends' };
      }

      let timing = { schedule: task.schedule, nextRunAt: task.nextRunAt };
      if (schedule !== undefined) {
        const { cronExpression, isOneShot, nextRunAt } = parseSchedule(schedule);
        if (!isOneShot && !cron.validate(cronExpression)) {
          return { status: 'invalid', field: 'schedule', error: `Invalid cron expression: ${cronExpression}` };
        }
        // As in `schedule_task`, only a one-off task continues a conversation.
        if (!isOneShot && task.threadId) {
          return {
            status: 'invalid',
            field: 'schedule',
            error: 'This task continues a conversation, so it can only run once, such as "in 10 minutes"',
          };
        }
        timing = { schedule: cronExpression, nextRunAt };
      }

      const data = { name: name ?? task.name, instruction: instruction ?? task.instruction, ...timing };
      const unchanged =
        data.name === task.name &&
        data.instruction === task.instruction &&
        data.schedule === task.schedule &&
        data.nextRunAt?.getTime() === task.nextRunAt?.getTime();
      if (unchanged) return { status: 'updated', task };

      let updated: CronTask;
      try {
        updated = await prisma.cronTask.update({ where: { id: taskId }, data });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          return { status: 'not_found', error: 'Cron task not found' };
        }
        throw err;
      }

      this.scheduleTask(toBackendCronTask(updated), { source: 'update', invokeMode: opts.invokeMode });
      return { status: 'updated', task: updated };
    });
  }

  /**
   * Remove the job of a deleted task. The scheduler owns the 'cron task deleted' event, and
   * `invokeMode` is as for `scheduleTask`.
   */
  unscheduleTask(taskId: string, userId?: string, invokeMode?: string): void {
    this.stopJob(taskId);
    this.lastDelivered.delete(taskId);
    trackEvent('cron task deleted', userId ?? null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'cron.task.id': taskId,
      ...(invokeMode ? { 'invoke.mode': invokeMode } : {}),
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
  }

  /**
   * A run ended: store when, and when the task next runs. Without a run, stores
   * the next run alone. A one-shot is deleted instead, so this is for a
   * recurring task. A run can delete its own task, so the write uses
   * `updateMany`, which accepts a missing row. A failed write is logged; the
   * stored time then reads as due, and the next boot runs the task once more.
   */
  private async recordRun(taskId: string, ranAt?: Date): Promise<void> {
    const scheduled = this.scheduledJobs.get(taskId);
    if (!scheduled || scheduled.isOneShot) return;
    try {
      await prisma.cronTask.updateMany({
        where: { id: taskId },
        data: {
          nextRunAt: scheduled.job.getNextRun?.() ?? null,
          ...(ranAt ? { lastRunAt: ranAt } : {}),
        },
      });
    } catch (err) {
      logger.error({ err }, `[CronScheduler] Failed to record the run of task ${taskId}`);
    }
  }

  private async deleteCronTask(taskId: string): Promise<void> {
    await prisma.cronTask.deleteMany({ where: { id: taskId } });
  }

  /**
   * Run a task once. False when a shutdown stopped the run before it delivered,
   * which leaves the run due. `afterRestart` tells the model that a run of the
   * task may have stopped part-way at a restart.
   */
  private async executeTask(task: BackendCronTask, opts: { afterRestart?: boolean } = {}): Promise<boolean> {
    if (this.runningTasks.has(task.id)) {
      logger.warn(`[CronScheduler] "${task.name}" is still running — skipping overlapping run`);
      return true;
    }
    const run = this.runTask(task, opts).finally(() => this.runningTasks.delete(task.id));
    this.runningTasks.set(task.id, run);
    return run;
  }

  private async runTask(task: BackendCronTask, opts: { afterRestart?: boolean }): Promise<boolean> {
    // A run that stops the process leaves its row, so the bound counts the boots that run it again.
    await pendingWorkService.begin('cron', task.id, {}).catch((err) => {
      logger.error({ err }, `[CronScheduler] Could not record the run of "${task.name}"`);
    });
    const startTime = Date.now();
    const boundThreadId = task.threadId;
    // A task saved without an instruction runs on its name, the only text its author gave.
    const instruction = task.instruction.trim() || task.name;

    logger.info(`[CronScheduler] Executing "${task.name}" for user ${task.userId}`);

    const trackRun = (result: 'completed' | 'suppressed' | 'budget_exceeded' | 'error') =>
      trackEvent('cron task executed', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.result': result,
        'cron.continue_in_thread': String(Boolean(boundThreadId)),
        'cron.duration_ms': String(Date.now() - startTime),
      });

    let stopped = false;
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
          return true;
        }
      }
      // A task that continues a conversation single-thread mode hides reads no history:
      // its answer goes to the one conversation (see `publish`), which that history is
      // not part of. It still delivers as a bound task, to its own channel alone.
      const historyThreadId =
        boundThreadId && (await conversationService.writableThreadId(boundThreadId)) === boundThreadId ? boundThreadId : null;

      // Invoke LLM directly (in-process). A bound task runs against its thread so
      // it sees the conversation history (see includeConversation in invoke.ts)
      // and can re-schedule another "wait" to keep polling in-thread.
      const result = await invoke({
        userId: task.userId,
        agentId: task.agentId,
        mode: 'cron',
        prompt: instruction,
        afterRestart: opts.afterRestart,
        abortSignal: pendingWorkService.shutdownSignal,
        ...(historyThreadId
          ? {
              threadId: historyThreadId,
              originChannel: (task.originChannel as ChannelName | null) ?? undefined,
              originChannelId: task.originChannelId ?? undefined,
            }
          : {}),
      });
      // A shutdown stopped the run. It delivers nothing and stays due. From here
      // the run delivers, so a shutdown that starts later lets it end.
      if (pendingWorkService.shutdownSignal.aborted) {
        stopped = true;
        return false;
      }

      // Build channel-neutral routing for a bound task once (the origin
      // channel's own thread, recovered from the thread row); undefined for unbound.
      const channelContext = boundThreadId
        ? await messageDeliveryService.threadContext(boundThreadId, task.originChannel, task.originChannelId)
        : undefined;

      // Budget exceeded — notify user and record the attempt
      if (result.error?.type === 'budget_exceeded') {
        const budgetMessage = `**Scheduled Task: ${task.name}**\n\nThis task could not run — your organization's AI spending limit has been reached${result.error.detail ? `: ${result.error.detail}` : ''}. Please contact your administrator to increase the budget.`;
        if (boundThreadId) {
          await messageDeliveryService.publish(task.userId, boundThreadId, budgetMessage, 'CRON_TASK', { channelContext });
        } else {
          await messageDeliveryService.publishToLatestThread(task.agentId, task.userId, budgetMessage, 'CRON_TASK');
        }
        trackRun('budget_exceeded');
        return true;
      }

      // Use only the last step's text (the final summary), not intermediate step texts
      const lastStep = result.steps[result.steps.length - 1];
      const responseText = (lastStep?.text ?? '').trim();
      const body = responseText || result.response;

      // Suppression ladder: an empty result is suppressed outright; a run that
      // ended in an error message, or whose tool call the risk gate refused, is
      // always delivered (neither is "nothing to report", and a task told to
      // send no message would otherwise fail silently on every run); the
      // classification gate decides the rest. The
      // gate sees the task instruction — so unconditional "send me X" tasks
      // always deliver, even when the text repeats — and the last delivered
      // result, so a conditional check that merely repeats it stays quiet.
      // No pre-gate duplicate short-circuit here (unlike the heartbeat):
      // it would silence unconditional tasks whose output is legitimately
      // identical run after run, e.g. an hourly fixed-text reminder.
      const prior = this.lastDelivered.get(task.id) ?? null;
      let verdict: string;
      if (!body.trim()) {
        verdict = 'SUPPRESS';
      } else if (result.error || hasRiskBlockedCall(result.toolCalls)) {
        verdict = 'DELIVER';
      } else {
        verdict = await runVerdictGate({
          system: CRON_TASK_GATE_PROMPT,
          user: buildCronGateUserMessage({
            instruction,
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

      if (!verdict.startsWith('DELIVER')) {
        // A suppressed run that is neither a repeat nor the delivered text means
        // the situation changed while we stayed quiet (e.g. the incident resolved
        // into an all-clear). Drop the baseline so a later recurrence reads as a
        // new finding, not as a repeat of the stale one.
        if (prior && !verdict.startsWith('REPEAT') && body.trim() !== prior.text) {
          this.lastDelivered.delete(task.id);
        }
        logger.info(`[CronScheduler] "${task.name}" suppressed — nothing new to report`);
        trackRun('suppressed');
        return true;
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
      // "**Scheduled Task: …**" header can't defeat the comparison. A task that is
      // no longer scheduled, such as one its own run deleted, has no next run to
      // compare, so it keeps no baseline, and one edited to a new instruction during
      // the run starts without one.
      if (this.scheduledJobs.get(task.id)?.task.instruction === task.instruction) {
        this.lastDelivered.set(task.id, { text: body.trim(), at: Date.now() });
      }

      logger.info(`[CronScheduler] "${task.name}" completed in ${Date.now() - startTime}ms`);
      trackRun('completed');
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[CronScheduler] "${task.name}" failed: ${errMsg}`);
      trackRun('error');
    } finally {
      // Every way out of the run, a failure included, is a run that ended,
      // except a shutdown before the delivery, which leaves the run due.
      if (!stopped) {
        await this.recordRun(task.id, new Date());
        pendingWorkService.finish('cron', task.id);
      }
    }
    return true;
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
