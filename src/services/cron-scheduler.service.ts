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
import {
  DELIVER_TARGETS,
  deliveryTargetService,
  isValidDeliverTo,
  parseCommaList,
  type DeliverTo,
} from './delivery-target.service';
import { conversationService } from './conversation.service';
import { outboundMessageService, sentMessageList, sentMessages, WITHHELD_RUN_TEXT } from './outbound-message.service';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { isTimezone } from '../lib/timezone';
import type { ToolRiskGateErrorCode } from '../lib/tool-risk-gate';
import { trackEvent } from '../lib/telemetry';
import { scheduledRunPrompt } from '../prompts/scheduled-run-prompt';
import { logger } from '../logger';
import { parseSchedule } from './cron-schedule';
import type { ChannelName } from './channel-adapter.interface';
import type { TaskLastSend, ToolCallRecord } from '../types';
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
  /** Where an unbound task delivers: `DELIVER_TARGETS`, and the chosen channels, comma-separated. */
  deliverTo: string;
  channelIds: string | null;
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
  deliverTo?: string;
  /** The linked channels of the target's channel to post to; null or empty = its default destination. */
  channelIds?: string[] | null;
}

export type CronTaskEdit =
  | { status: 'updated'; task: CronTask }
  | { status: 'not_found'; error: string }
  | { status: 'running'; error: string }
  | { status: 'invalid'; field: 'name' | 'schedule' | 'deliverTo' | 'channelIds'; error: string };

/** What a task write stores for its delivery. */
type TaskDelivery =
  | { ok: true; value: { deliverTo: DeliverTo; channelIds: string | null } }
  | { ok: false; field: 'deliverTo' | 'channelIds'; error: string };

/**
 * Read the delivery a task write stores. A write that leaves the target out keeps
 * the current one, and a new target drops the chosen channels the write does not
 * restate. A task that continues a conversation answers there, so it takes no
 * other target.
 */
export async function readTaskDelivery(
  changes: Pick<CronTaskChanges, 'deliverTo' | 'channelIds'>,
  agentId: string,
  current: { deliverTo: string; channelIds: string | null; threadId: string | null },
): Promise<TaskDelivery> {
  const deliverTo = changes.deliverTo ?? current.deliverTo;
  if (!isValidDeliverTo(deliverTo)) {
    return { ok: false, field: 'deliverTo', error: `deliverTo must be one of: ${DELIVER_TARGETS.join(', ')}` };
  }
  let channelIds = deliverTo === current.deliverTo ? current.channelIds : null;
  if (changes.channelIds !== undefined) {
    const read = await deliveryTargetService.readChannelIds(
      changes.channelIds,
      deliverTo,
      agentId,
      parseCommaList(current.channelIds),
    );
    if (!read.ok) return { ok: false, field: 'channelIds', error: read.error };
    channelIds = read.value;
  }
  if (current.threadId && (deliverTo !== 'all' || channelIds)) {
    return { ok: false, field: 'deliverTo', error: 'This task continues a conversation, so it replies there' };
  }
  return { ok: true, value: { deliverTo, channelIds } };
}

interface ScheduledJob {
  task: BackendCronTask;
  /** A node-cron task for a recurring schedule, or the timer of a one-shot. */
  job: { stop: () => void; getNextRun?: () => Date | null };
  isOneShot: boolean;
}

/** How far back the boot looks for a tick of a task that has no stored next run. */
const MISSED_TICK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many stored runs of a task a restart reads to find its last send: a week
 * of hourly runs that each delivered a result. The read is once per task per
 * process, and three columns per row.
 */
const LAST_SEND_ROWS = 200;

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
   * Per unbound task, what its last sending run sent and what the newest run
   * after it reported, which the next run reads in place of history, with the
   * instruction it was recorded under. Null means none; an absent entry is read
   * from the stored messages on the first run.
   */
  private lastSend: Map<string, { instruction: string; record: TaskLastSend } | null> = new Map();

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
   * change. A task keeps its delivery baseline while its instruction and its target are the same.
   */
  scheduleTask(
    task: BackendCronTask,
    opts: { source?: 'create' | 'update' | 'boot'; invokeMode?: string } = {},
  ): void {
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
      trackEvent(opts.source === 'update' ? 'cron task updated' : 'cron task scheduled', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.schedule': task.schedule,
        'cron.one_shot': String(isOneShot),
        'cron.continue_in_thread': String(Boolean(task.threadId)),
        'cron.deliver_to': task.deliverTo,
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
      this.lastSend.delete(task.id);
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

      const delivery = await readTaskDelivery(changes, task.agentId, task);
      if (!delivery.ok) return { status: 'invalid', field: delivery.field, error: delivery.error };

      const data = {
        name: name ?? task.name,
        instruction: instruction ?? task.instruction,
        ...timing,
        ...delivery.value,
      };
      const unchanged =
        data.name === task.name &&
        data.instruction === task.instruction &&
        data.schedule === task.schedule &&
        data.nextRunAt?.getTime() === task.nextRunAt?.getTime() &&
        data.deliverTo === task.deliverTo &&
        data.channelIds === task.channelIds;
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

      // A new instruction starts with no send record, so no run reads the old one's sends from
      // storage, whether the task has a job now or runs again later.
      if (data.instruction !== task.instruction) this.lastSend.set(taskId, null);
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
    this.lastSend.delete(taskId);
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
   * What the task's runs sent and reported since. Read from the stored messages
   * once per process; a failed read is tried again on the next run.
   */
  private async lastSendOf(task: BackendCronTask): Promise<TaskLastSend | undefined> {
    if (!this.lastSend.has(task.id)) {
      const read = await this.readLastSend(task);
      // A run that sent while the read was out wins over what the read found.
      if (read !== undefined && !this.lastSend.has(task.id)) {
        this.lastSend.set(task.id, read && { instruction: task.instruction, record: read });
      }
    }
    const entry = this.lastSend.get(task.id);
    return entry?.instruction === task.instruction ? entry.record : undefined;
  }

  /**
   * The newest stored run of this task that sent a message, and the newest one
   * after it, or undefined when the read fails. An unbound run is stored in its
   * user's thread under the task's heading, delivered or withheld, with its tool
   * calls. The rows hold neither the task's id, its instruction nor a run's error,
   * which costs these trades after a restart: a rename finds none, and two tasks
   * of one name read each other's; a send made under an earlier instruction is
   * read as this instruction's; a failed run can be read as the newest report;
   * a run the gate withheld that sent nothing is not stored, so an all-clear
   * after the send is lost; and a send older than the newest `LAST_SEND_ROWS`
   * runs is lost.
   */
  private async readLastSend(task: BackendCronTask): Promise<TaskLastSend | null | undefined> {
    const heading = `**Scheduled Task: ${task.name}**`;
    try {
      const rows = await prisma.conversationMessage.findMany({
        where: {
          role: 'AGENT',
          triggeredBy: 'CRON_TASK',
          thread: { agentId: task.agentId, userId: task.userId },
          content: { startsWith: heading },
          createdAt: { gte: new Date(task.createdAt) },
        },
        orderBy: { createdAt: 'desc' },
        take: LAST_SEND_ROWS,
        select: { content: true, toolCalls: true, createdAt: true },
      });
      let latestReport: TaskLastSend['latestReport'];
      // SQLite matches the prefix without regard to case.
      for (const row of rows.filter((r) => r.content.startsWith(heading))) {
        const messages = sentMessages((row.toolCalls as ToolCallRecord[] | null) ?? []);
        const at = row.createdAt.getTime();
        if (messages.length > 0) return { messages: messages.join('\n'), at, ...(latestReport && { latestReport }) };
        latestReport ??= { text: row.content.slice(heading.length).trim(), at };
      }
      return null;
    } catch (err) {
      logger.warn({ err }, `[CronScheduler] Could not read what "${task.name}" last sent`);
      return undefined;
    }
  }

  /**
   * A run that sent replaces the record, unless its task changed while it ran.
   * Answers whether the run sent.
   */
  private noteSends(task: BackendCronTask, toolCalls: ToolCallRecord[]): boolean {
    const messages = sentMessages(toolCalls);
    if (messages.length === 0) return false;
    if (this.isCurrent(task)) {
      this.lastSend.set(task.id, { instruction: task.instruction, record: { messages: messages.join('\n'), at: Date.now() } });
    }
    return true;
  }

  /** A later run's result, so the next run reads whether the finding still held. An empty result says nothing. */
  private noteReport(task: BackendCronTask, body: string): void {
    const entry = this.lastSend.get(task.id);
    if (!entry || entry.instruction !== task.instruction || !body.trim() || !this.isCurrent(task)) return;
    this.lastSend.set(task.id, { ...entry, record: { ...entry.record, latestReport: { text: body.trim(), at: Date.now() } } });
  }

  /** Whether the task is still scheduled with the instruction this run had. */
  private isCurrent(task: BackendCronTask): boolean {
    return this.scheduledJobs.get(task.id)?.task.instruction === task.instruction;
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

    let sentCalls: ToolCallRecord[] = [];
    const trackRun = (result: 'posted' | 'silent' | 'budget_exceeded' | 'error') =>
      trackEvent('cron task executed', task.userId, {
        'agent.id': task.agentId,
        'cron.task.id': task.id,
        'cron.result': result,
        'cron.messages_sent': String(sentMessageList(sentCalls).length),
        'cron.continue_in_thread': String(Boolean(boundThreadId)),
        'cron.deliver_to': task.deliverTo,
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
      const target = { deliverTo: task.deliverTo, channelIds: parseCommaList(task.channelIds) };

      const lastSend = boundThreadId ? undefined : await this.lastSendOf(task);
      // Invoke LLM directly (in-process). A bound task runs against its thread so
      // it sees the conversation history (see includeConversation in invoke.ts)
      // and can re-schedule another "wait" to keep polling in-thread.
      const result = await invoke({
        userId: task.userId,
        agentId: task.agentId,
        mode: 'cron',
        prompt: boundThreadId ? instruction : scheduledRunPrompt(instruction, lastSend),
        afterRestart: opts.afterRestart,
        abortSignal: pendingWorkService.shutdownSignal,
        ...(historyThreadId
          ? {
              threadId: historyThreadId,
              originChannel: (task.originChannel as ChannelName | null) ?? undefined,
              originChannelId: task.originChannelId ?? undefined,
            }
          : {}),
        // An unbound task posts within its delivery target, and only an unbound task recurs.
        ...(!boundThreadId && {
          postingCeiling: await deliveryTargetService.ceiling(task.agentId, target),
          lastSend,
        }),
      });
      // A shutdown stopped the run. It delivers nothing, and a message it sent stays
      // in history. A run that sent nothing stays due; one that sent already reached
      // people, so it ends, as a run again after the restart would send it twice.
      // From here the run delivers, so a shutdown that starts later lets it end.
      if (pendingWorkService.shutdownSignal.aborted) {
        const stoppedText = (result.steps[result.steps.length - 1]?.text ?? '').trim() || WITHHELD_RUN_TEXT;
        await outboundMessageService.keepWithheldRun({
          agentId: task.agentId,
          userId: task.userId,
          threadId: boundThreadId ?? undefined,
          content: boundThreadId ? stoppedText : `**Scheduled Task: ${task.name}**\n\n${stoppedText}`,
          triggeredBy: 'CRON_TASK',
          toolCalls: result.toolCalls,
        });
        if (sentMessageList(result.toolCalls).length > 0) return true;
        stopped = true;
        return false;
      }

      // Build channel-neutral routing for a bound task once (the origin
      // channel's own thread, recovered from the thread row); undefined for unbound.
      const channelContext = boundThreadId
        ? await messageDeliveryService.threadContext(boundThreadId, task.originChannel, task.originChannelId)
        : undefined;

      sentCalls = result.toolCalls;
      const sent = !boundThreadId && this.noteSends(task, result.toolCalls);

      // Budget exceeded — notify user and record the attempt
      if (result.error?.type === 'budget_exceeded') {
        const budgetMessage = `**Scheduled Task: ${task.name}**\n\nThis task could not run — your organization's AI spending limit has been reached${result.error.detail ? `: ${result.error.detail}` : ''}. Please contact your administrator to increase the budget.`;
        // The tool calls of the steps before the limit go with the notice, so a
        // message the run already sent stays in its history.
        const toolCalls = result.toolCalls.length > 0 ? result.toolCalls : undefined;
        if (boundThreadId) {
          await messageDeliveryService.publish(task.userId, boundThreadId, budgetMessage, 'CRON_TASK', {
            toolCalls,
            channelContext,
          });
        } else {
          const { message } = await deliveryTargetService.deliver(task.agentId, task.userId, target, budgetMessage, 'CRON_TASK', {
            toolCalls,
          });
          if (!message) {
            await outboundMessageService.keepWithheldRun({
              agentId: task.agentId,
              userId: task.userId,
              content: budgetMessage,
              triggeredBy: 'CRON_TASK',
              toolCalls: result.toolCalls,
            });
          }
        }
        trackRun('budget_exceeded');
        return true;
      }

      // Use only the last step's text (the final summary), not intermediate step texts
      const lastStep = result.steps[result.steps.length - 1];
      const responseText = (lastStep?.text ?? '').trim();
      const body = responseText || result.response;
      // A failed run's text is the error, not a finding.
      if (!boundThreadId && !sent && !result.error) this.noteReport(task, body);
      const toolCalls = result.toolCalls.length > 0 ? result.toolCalls : undefined;

      if (boundThreadId) {
        // A continuation replies in its conversation, with no "Scheduled Task"
        // header. An empty reply is a wait with nothing to say yet.
        if (responseText) {
          await messageDeliveryService.publish(task.userId, boundThreadId, responseText, 'CRON_TASK', {
            toolCalls,
            attachmentIds: result.attachmentIds,
            channelContext,
          });
        } else {
          await outboundMessageService.keepWithheldRun({
            agentId: task.agentId,
            userId: task.userId,
            threadId: boundThreadId,
            content: body,
            triggeredBy: 'CRON_TASK',
            toolCalls: result.toolCalls,
          });
        }
        logger.info(`[CronScheduler] "${task.name}" completed in ${Date.now() - startTime}ms`);
        trackRun(responseText ? 'posted' : 'silent');
        return true;
      }

      // An unbound run reaches people only through what the agent posted. A run
      // that ended in an error could not post what happened, so its result goes
      // to the task's target, as does that of a run that posted nothing because
      // the risk gate refused a tool call or it ran out of steps. A run that did
      // post keeps its closing line, which says where it posted, to itself.
      const content = `**Scheduled Task: ${task.name}**\n\n${body}`;
      const failed =
        Boolean(result.error) ||
        (!sent && (hasRiskBlockedCall(result.toolCalls) || Boolean(result.stepLimitReached)));
      const { message } = failed
        ? await deliveryTargetService.deliver(task.agentId, task.userId, target, content, 'CRON_TASK', {
            toolCalls,
            attachmentIds: result.attachmentIds,
          })
        : { message: null };
      if (!message) {
        await outboundMessageService.keepWithheldRun({
          agentId: task.agentId,
          userId: task.userId,
          content,
          triggeredBy: 'CRON_TASK',
          toolCalls: result.toolCalls,
        });
      }

      logger.info(`[CronScheduler] "${task.name}" completed in ${Date.now() - startTime}ms`);
      trackRun(failed ? 'error' : sent ? 'posted' : 'silent');
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
    this.lastSend.clear();
    logger.info('[CronScheduler] All cron tasks stopped');
  }
}

// Export singleton instance
export const cronSchedulerService = new CronSchedulerService();
