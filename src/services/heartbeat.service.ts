/**
 * Heartbeat Service (Agent-Runtime)
 *
 * Manages the always-on heartbeat system for personal agents.
 * Invokes the LLM directly (in-process) and communicates with
 * the backend via the internal REST API.
 *
 * Key design principles:
 * - The interval is measured from the last run, not from the timer's creation,
 *   so a restart or a re-registration cannot defer a check
 * - Classification gate LLM (Haiku) decides DELIVER/SUPPRESS after each heartbeat
 * - 24h duplicate suppression for exact-match alerts
 * - Fail-open: if the gate call fails, deliver the message
 */

import { invoke } from '../invoke';
import { lastResponseText } from '../lib/last-response-text';
import { AgentWorkspace } from '@prisma/client';
import { outboundMessageService, sentMessageList, WITHHELD_RUN_TEXT } from './outbound-message.service';
import { deliveryTargetService, parseCommaList, type DeliveryTarget } from './delivery-target.service';
import { agentStatusService } from './agent-status.service';
import { documentRevisionService } from './document-revision.service';
import { MAX_RESUME_ATTEMPTS, pendingWorkService, type PendingWorkItem } from './pending-work.service';
import prisma from '../lib/prisma';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { config } from '../config';
import { formatTimeAgo } from '../prompts/context-builder';
import { ChannelTriggerMessage, HeartbeatTrigger, type TriggerPlace, InvokeStep, type InvokeResponse, type TaskLastSend, type ToolCallRecord } from '../types';
import { heartbeatDelayMs, heartbeatDueAt } from './heartbeat-schedule';
import type { ChatPlatform } from './channel-adapter.interface';

/**
 * The stored text of a heartbeat run that stopped at the spending limit. It is
 * kept, not delivered, when the run sent a message before the limit.
 */
const HEARTBEAT_BUDGET_NOTICE =
  "This heartbeat check stopped: your organization's AI spending limit has been reached.";

/** How many stored heartbeat messages a restart reads to restore the send record. */
const SEND_RECORD_ROWS = 20;

/** How a heartbeat run ended: it posted, posted nothing, or ended in an error the runtime delivered. */
type HeartbeatOutcome = 'posted' | 'silent' | 'error';

/** How many heartbeat intervals back a restart reads sends into the send record. */
const HEARTBEAT_SEND_RESTORE_INTERVALS = 3;

/** How many sends the send record keeps, and how many run results. */
const HEARTBEAT_SENDS = 10;

/** The record with `sends` made at `at` under `checks`, each replacing an older send of the same text to the same place. */
function mergeSends(
  record: HeartbeatSendRecord | null,
  sends: Array<{ place: string; text: string }>,
  at: number,
  checks: string,
): HeartbeatSendRecord | null {
  if (sends.length === 0) return record;
  const fresh = sends.map(({ place, text }) => ({ place, text, at }));
  const kept = (record?.sends ?? []).filter((old) => !fresh.some((send) => send.place === old.place && send.text === old.text));
  return withReports({ checks, sends: [...fresh, ...kept].slice(0, HEARTBEAT_SENDS) }, record?.reports ?? []);
}

/** The record with a run's result added, newest first. */
function addReport(record: HeartbeatSendRecord, text: string, at: number): HeartbeatSendRecord {
  return withReports(record, [{ text, at }, ...record.reports]);
}

/** The newest `HEARTBEAT_SENDS` results of the runs since the oldest send the record keeps. */
function withReports(record: Omit<HeartbeatSendRecord, 'reports'>, reports: HeartbeatSendRecord['reports']): HeartbeatSendRecord {
  const since = record.sends[record.sends.length - 1].at;
  return { ...record, reports: reports.filter((report) => report.at >= since).slice(0, HEARTBEAT_SENDS) };
}

// ============================================================================
// Types
// ============================================================================

/**
 * How a caller anchors the schedule.
 *
 * `keep-schedule` leaves the next cycle where it is, so a restart or any
 * re-registration that is not an interval change cannot defer a check.
 * `new-interval` starts a fresh interval from now, which is what a user
 * changing the cadence asks for.
 */
export type HeartbeatSchedule = 'keep-schedule' | 'new-interval';

interface HeartbeatState {
  userId: string;
  agentId: string;
  timeoutId: NodeJS.Timeout | null;
  intervalMs: number;
  /** Absolute time the next cycle is due. */
  dueAt: number;
  lastRun: Date | null;
  isRunning: boolean;
  consecutiveErrors: number;
  /**
   * What earlier runs sent, and what the newest run reported. A run reads no
   * history, so this tells it about earlier sends. It is separate from the
   * delivered alert the duplicate check compares against.
   */
  lastSend: HeartbeatSendRecord | null;
  /** The restore of the last alert and the send record. Every run waits for it. */
  restored: Promise<void>;
}

/**
 * The newest `HEARTBEAT_SENDS` messages earlier runs sent, newest first, with a
 * repeated message kept once. A heartbeat runs several checks, so the record
 * holds sends about several incidents, also in one channel. `reports` are the
 * results of the runs since the oldest kept send, newest first: a run that sends
 * reports only what it sent where, so an earlier result can be the one that
 * shows a condition cleared. `checks` is the Heartbeat document the sends were
 * made under: a run under other checks drops the record.
 */
interface HeartbeatSendRecord {
  checks: string;
  sends: Array<{ place: string; text: string; at: number }>;
  reports: Array<{ text: string; at: number }>;
}

interface HeartbeatResult {
  shouldSkip: boolean;
  text: string;
}

/** The messages a source holds for a heartbeat, oldest first, and the ids that name them. */
export interface PendingTriggerMessages {
  messages: ChannelTriggerMessage[];
  ids: string[];
  /** The channel the messages were posted in. */
  place?: TriggerPlace;
}

/**
 * A channel that queues messages to start the heartbeat. A timer heartbeat
 * reads every registered source, so nothing queued waits for a trigger. A run
 * removes the messages it read once it ends, so a restart before then leaves
 * them for the next run.
 */
export interface HeartbeatTriggerSource {
  /** The channel's adapter name; reported as the heartbeat's trigger. */
  readonly channel: ChatPlatform;
  /** How the prompt names the channel's platform. */
  readonly platform: string;
  /** Every message queued for `agentId`. They stay queued until `remove`. */
  pending(agentId: string): Promise<PendingTriggerMessages>;
  /** Forget the messages a run answered. */
  remove(ids: string[]): Promise<void>;
}

/** The messages one run read, by the source that holds them. */
type ReadMessages = Array<{ source: HeartbeatTriggerSource; ids: string[] }>;

/** A run, as `pending_work` holds it until the run ends: the messages it read, by channel. */
interface HeartbeatWork {
  read: Partial<Record<ChatPlatform, string[]>>;
}

/** A delay for the log line: seconds under a minute, whole minutes above it. */
function formatDelay(delayMs: number): string {
  if (delayMs < 60_000) return `${Math.round(delayMs / 1000)}s`;
  return `${Math.round(delayMs / 60_000)}min`;
}

// ============================================================================
// Heartbeat Service
// ============================================================================

class HeartbeatService {
  private heartbeatState: HeartbeatState | null = null;
  private triggerSources: HeartbeatTriggerSource[] = [];
  /** A run stopped the process on `MAX_RESUME_ATTEMPTS` boots in a row, so the boot does not start the check at once. */
  private givenUp = false;

  registerTriggerSource(source: HeartbeatTriggerSource): void {
    this.triggerSources.push(source);
  }

  /**
   * The boot step for runs a restart stopped. A check that is still due, and the
   * messages a run read, start a run again. A run the attempt bound gave up
   * answers its messages, and the next check is an interval away.
   */
  async resume(_items: PendingWorkItem[], givenUp: PendingWorkItem[]): Promise<void> {
    if (givenUp.length === 0) return;
    logger.warn(`[Heartbeat] A run stopped the runtime on ${MAX_RESUME_ATTEMPTS} boots in a row; skipping it`);
    this.givenUp = true;
    for (const item of givenUp) {
      const { read } = item.payload as unknown as HeartbeatWork;
      for (const source of this.triggerSources) {
        await source.remove(read[source.channel] ?? []);
      }
    }
  }

  startHeartbeat(agent: AgentWorkspace, schedule: HeartbeatSchedule): void {
    // Heartbeat enablement is persisted in the backend DB.
    // If the agent is marked STOPPED, we don't start a timer on runtime startup.
    if (agent.heartbeatStatus === 'STOPPED') {
      logger.info(`[Heartbeat] Not starting (status: STOPPED)`);
      return;
    }

    const intervalMs = agent.heartbeatIntervalMs || config.heartbeatIntervalMs;
    const now = Date.now();

    // Re-registration keeps the live state object: a run in flight writes its
    // own fields to it, and the alert history behind the 24h duplicate check
    // belongs to the agent rather than to the timer.
    const state = this.heartbeatState ?? this.registerState(agent, intervalMs, now);
    state.intervalMs = intervalMs;
    if (schedule === 'new-interval') {
      state.dueAt = now + intervalMs;
      this.persistSchedule(state);
    }

    const delayMs = this.armTimer(state);

    // Fire-and-forget persistence (don't block startup/management call).
    agentStatusService.updateAgentHeartbeatStatus('ENABLED').catch((err) => {
      logger.warn(`[Heartbeat] Failed to persist ENABLED status: ${err instanceof Error ? err.message : String(err)}`);
    });

    logger.info(
      `[Heartbeat] Started (interval: ${intervalMs / 60000}min, next check in ${formatDelay(delayMs)})`,
    );
    trackEvent('heartbeat started', agent.userId, {
      'agent.id': agent.id,
      'heartbeat.interval_ms': String(intervalMs),
    });
  }

  /** First registration in this process: the schedule comes off the stored row. */
  private registerState(agent: AgentWorkspace, intervalMs: number, now: number): HeartbeatState {
    const state: HeartbeatState = {
      userId: agent.userId,
      agentId: agent.id,
      timeoutId: null,
      intervalMs,
      dueAt: this.givenUp ? now + intervalMs : heartbeatDueAt(agent.nextHeartbeatAt, agent.lastHeartbeat, intervalMs, now),
      lastRun: agent.lastHeartbeat,
      isRunning: false,
      consecutiveErrors: 0,
      lastSend: null,
      restored: Promise.resolve(),
    };

    this.heartbeatState = state;
    if (this.givenUp) {
      this.givenUp = false;
      this.persistSchedule(state);
    }
    state.restored = this.restoreSendRecord(state, agent.heartbeatMd);
    return state;
  }

  /**
   * The send record holds the sends and results of the runs of the last
   * `HEARTBEAT_SEND_RESTORE_INTERVALS` intervals after the newest revision of the
   * Heartbeat document, read from the stored heartbeat rows of the web threads.
   * The trades: a run that posted nothing is not stored, so the record can miss a
   * report that a condition cleared; a send older than the window is sent again;
   * and a document written straight into the database has no revision, so
   * earlier sends are read as made under it.
   */
  private async restoreSendRecord(state: HeartbeatState, checks: string): Promise<void> {
    try {
      const rows = await prisma.conversationMessage.findMany({
        where: { role: 'AGENT', triggeredBy: 'HEARTBEAT', thread: { agentId: state.agentId, externalThreadId: null } },
        orderBy: { createdAt: 'desc' },
        take: SEND_RECORD_ROWS,
        select: { content: true, createdAt: true, toolCalls: true },
      });
      const edited = await documentRevisionService.newest(prisma, state.agentId, 'heartbeatMd');
      const since = Math.max(
        Date.now() - HEARTBEAT_SEND_RESTORE_INTERVALS * state.intervalMs,
        edited?.createdAt.getTime() ?? 0,
      );
      const sends = rows.map((row) => sentMessageList((row.toolCalls as ToolCallRecord[] | null) ?? []));
      let record: HeartbeatSendRecord | null = null;
      // Oldest first and in a live run's order, so a newer copy of a send replaces an older one.
      for (let i = rows.length - 1; i >= 0; i--) {
        const at = rows[i].createdAt.getTime();
        if (at < since) continue;
        record = mergeSends(record, sends[i], at, checks);
        // A live run records no result for a run without a reply or one stopped by the spending limit.
        const text = rows[i].content.trim();
        if (record && text && text !== WITHHELD_RUN_TEXT && text !== HEARTBEAT_BUDGET_NOTICE) record = addReport(record, text, at);
      }
      state.lastSend = record;
    } catch (err) {
      logger.warn({ err }, '[Heartbeat] Could not read the send record');
    }
  }

  /**
   * Trigger messages a restart left unanswered get their heartbeat now, rather
   * than at the next timer run.
   */
  async answerPendingTriggers(): Promise<void> {
    const state = this.heartbeatState;
    if (!state) return;
    for (const source of this.triggerSources) {
      const { ids } = await source.pending(state.agentId);
      if (ids.length > 0 && this.triggerFrom(source) === 'queued') return;
    }
  }

  /** Arm the one timer this state may hold, and answer the delay it waits. */
  private armTimer(state: HeartbeatState): number {
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }

    const delayMs = heartbeatDelayMs(state.dueAt, state.intervalMs, Date.now());
    state.timeoutId = setTimeout(() => {
      void this.onTimer();
    }, delayMs);

    return delayMs;
  }

  /**
   * The timer fired. A cycle runs only when one is due: the delay is capped, and
   * a run started elsewhere may have moved the due time. The chain re-arms
   * whatever the run did, so no failure can leave the heartbeat silent for the
   * life of the process. A stop clears the state, and the identity check then
   * declines to arm a timer nothing owns.
   */
  private async onTimer(): Promise<void> {
    const state = this.heartbeatState;
    if (!state) return;

    try {
      if (Date.now() >= state.dueAt) {
        await this.executeHeartbeat();
      }
    } catch (err) {
      // executeHeartbeat answers for a failed run itself, so this is a failure
      // of that handling. Logged here rather than rethrown, since a rejection
      // out of a timer callback ends the process.
      logger.error({ err }, '[Heartbeat] Cycle failed outside the run');
    } finally {
      if (this.heartbeatState === state) {
        this.armTimer(state);
      }
    }
  }

  /**
   * One cycle happened. The in-memory deadline and the persisted one move
   * together, so the next process arms the same one. A write that fails logs a
   * warning and leaves the persisted deadline behind, which reads as overdue on
   * the next boot, so a check runs early.
   */
  private async recordCycle(state: HeartbeatState): Promise<void> {
    const ranAt = new Date();
    state.lastRun = ranAt;
    state.dueAt = ranAt.getTime() + state.intervalMs;

    await this.writeSchedule(state, ranAt);
  }

  /**
   * A run ended: the next check is an interval away, and the trigger messages it
   * read are answered. Called after the delivery, so a restart before it runs
   * the check again rather than losing its alert.
   */
  private async endCycle(state: HeartbeatState, read: ReadMessages): Promise<void> {
    await this.recordCycle(state);
    await this.endRun(state, read);
  }

  /**
   * Kept as pending work from before the model call until the run ends, so the
   * attempt bound gives up a run that stops the process on every boot.
   */
  private async beginRun(state: HeartbeatState, read: ReadMessages): Promise<void> {
    const work: HeartbeatWork = { read: Object.fromEntries(read.map(({ source, ids }) => [source.channel, ids])) };
    await pendingWorkService.begin('heartbeat', state.agentId, work).catch((err) => {
      logger.warn({ err }, '[Heartbeat] Could not record the run');
    });
  }

  /** The run ended: the messages it read are answered. */
  private async endRun(state: HeartbeatState, read: ReadMessages): Promise<void> {
    for (const { source, ids } of read) {
      await source.remove(ids).catch((err) => {
        logger.warn({ err }, `[Heartbeat] Could not remove the ${source.platform} messages this run answered`);
      });
    }
    pendingWorkService.finish('heartbeat', state.agentId);
  }

  /**
   * Persist a deadline no run produced, so a cadence change survives a restart.
   * Fire-and-forget: the caller is `startHeartbeat`, which a boot and a
   * management route both call and neither waits on a write for.
   */
  private persistSchedule(state: HeartbeatState): void {
    void this.writeSchedule(state);
  }

  /**
   * The one write of the schedule columns. `ranAt` moves the last-run column
   * too, and only a cycle passes it, so a cadence change reports no heartbeat.
   */
  private async writeSchedule(state: HeartbeatState, ranAt?: Date): Promise<void> {
    try {
      await agentStatusService.updateHeartbeatSchedule({
        nextHeartbeatAt: new Date(state.dueAt),
        ...(ranAt ? { lastHeartbeat: ranAt } : {}),
      });
    } catch (err) {
      logger.warn(
        `[Heartbeat] Failed to persist the schedule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  stopHeartbeat(): void {
    agentStatusService.updateAgentHeartbeatStatus('STOPPED').catch((err) => {
      logger.warn(`[Heartbeat] Failed to persist STOPPED status: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Emit only when a heartbeat was actually running — a no-op stop is not
    // a real event and would lack agent.id.
    const state = this.heartbeatState;
    if (state) {
      trackEvent('heartbeat stopped', state.userId, {
        'agent.id': state.agentId,
      });
    }

    this.clearHeartbeatTimer();
  }

  private clearHeartbeatTimer(): void {
    const state = this.heartbeatState;

    if (state) {
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
      }
      this.heartbeatState = null;
    }
  }

  async executeHeartbeat(): Promise<HeartbeatResult> {
    const startTime = Date.now();
    const state = this.heartbeatState;

    if (!state) {
      return { shouldSkip: true, text: 'No registered heartbeat for this agent' };
    }

    if (state.isRunning) {
      return { shouldSkip: true, text: 'Already running' };
    }

    state.isRunning = true;
    const userId = state.userId;
    const read: ReadMessages = [];
    let delivering = false;

    try {
      logger.info(`[Heartbeat] Executing`);

      // Every channel's pending trigger messages ride along so none waits for its
      // trigger. They are removed when this run ends, so a restart before then keeps them.
      const triggers: HeartbeatTrigger[] = [];
      for (const source of this.triggerSources) {
        const { messages, ids, place } = await source.pending(state.agentId);
        if (messages.length === 0) continue;
        logger.info(`[Heartbeat] Picked up ${messages.length} pending ${source.platform} message(s) during timer heartbeat`);
        triggers.push({ platform: source.platform, ...(place && { place }), messages });
        read.push({ source, ids });
      }
      const triggered = triggers.length > 0;
      await this.beginRun(state, read);
      const { checks, delivery } = await this.readChecks(state);

      // Invoke LLM directly (in-process, no HTTP)
      const invokeResult = await invoke({
        userId,
        agentId: state.agentId,
        mode: 'heartbeat',
        postingCeiling: await deliveryTargetService.ceiling(state.agentId, delivery),
        prompt: triggered ? this.buildTriggeredHeartbeatPrompt(triggers) : this.buildHeartbeatPrompt(),
        lastSend: this.sendRecordForPrompt(state),
        heartbeatTriggers: triggered ? triggers : undefined,
        abortSignal: pendingWorkService.shutdownSignal,
      });
      // A shutdown stopped the run. One that posted nothing stays due with its
      // messages queued, so the next boot runs it; one that posted already reached
      // people, so it ends. From here the run delivers, so a shutdown that starts
      // later lets it end.
      if (pendingWorkService.shutdownSignal.aborted) {
        if (await this.keepStoppedRun(state, invokeResult)) await this.endCycle(state, read);
        return { shouldSkip: true, text: 'Stopped by shutdown' };
      }
      delivering = true;
      this.noteSends(state, invokeResult.toolCalls, checks);

      // Budget exceeded — skip and reset error streak so the timer keeps running.
      // The cycle still happened, so the next one is a full interval away.
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        await this.endCycle(state, read);
        await outboundMessageService.keepWithheldRun({
          agentId: state.agentId,
          userId,
          content: HEARTBEAT_BUDGET_NOTICE,
          triggeredBy: 'HEARTBEAT',
          toolCalls: invokeResult.toolCalls,
        });
        logger.info(`[Heartbeat] Skipping — budget exceeded`);
        this.trackHeartbeat(state, 'timer', 'budget_exceeded', startTime);
        return { shouldSkip: true, text: 'Budget exceeded' };
      }

      const responseText = lastResponseText(invokeResult.steps);
      if (!invokeResult.error) this.noteReport(state, responseText);
      this.logSteps(responseText, invokeResult.steps);
      const outcome = await this.finishRun(state, delivery, invokeResult, responseText);

      await this.endCycle(state, read);

      state.consecutiveErrors = 0;

      logger.info(`[Heartbeat] Completed in ${Date.now() - startTime}ms: ${outcome}`);
      this.trackHeartbeat(state, 'timer', outcome, startTime, sentMessageList(invokeResult.toolCalls).length);
      return { shouldSkip: outcome === 'silent', text: responseText };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] Failed: ${errMsg}`);
      if (pendingWorkService.shutdownSignal.aborted && !delivering) return { shouldSkip: true, text: errMsg };

      // A failed run is still a cycle. It spaces the error streak one interval
      // apart, which is what the auto-stop below is counting.
      await this.endCycle(state, read);

      this.trackHeartbeat(state, 'timer', 'error', startTime);
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= 5) {
        logger.error(`[Heartbeat] Stopping: too many consecutive errors`);
        this.stopHeartbeat();

      }

      return { shouldSkip: true, text: errMsg };
    } finally {
      state.isRunning = false;
    }
  }

  // ============================================================================
  // Channel-Triggered Heartbeat
  // ============================================================================

  /**
   * Notify that `source` has new messages queued in the DB.
   * Fires a heartbeat if not already running. If already running, the
   * messages stay queued for the next run.
   */
  triggerFrom(source: HeartbeatTriggerSource): 'queued' | 'ignored' {
    const state = this.heartbeatState;

    if (!state) {
      logger.warn(`[Heartbeat] No heartbeat state — ignoring ${source.platform} trigger`);
      return 'ignored';
    }

    logger.info(`[Heartbeat] ${source.platform} trigger notification`);

    if (state.isRunning) {
      logger.info(`[Heartbeat] Heartbeat already running, the messages wait for the next run`);
      return 'ignored';
    }

    // Fire-and-forget — errors are handled inside
    this.executeChannelTriggeredHeartbeat(source).catch((err) => {
      logger.error(`[Heartbeat] ${source.platform}-triggered heartbeat failed:`, err);
    });

    return 'queued';
  }

  /**
   * Execute a single channel-triggered heartbeat over the pending messages, and
   * remove them once it ends. Messages that arrive during execution wait for the
   * next run.
   */
  private async executeChannelTriggeredHeartbeat(source: HeartbeatTriggerSource): Promise<void> {
    const label = `${source.platform}-triggered`;
    logger.info(`[Heartbeat] Starting ${label} heartbeat`);
    const startedAt = Date.now();
    const state = this.heartbeatState;

    if (!state || state.isRunning) {
      logger.info(`[Heartbeat] Heartbeat already running or no state`);

      return;
    }

    state.isRunning = true;
    let read: ReadMessages = [];
    let delivering = false;

    try {
      const { messages, ids } = await source.pending(state.agentId);
      read = [{ source, ids }];

      if (messages.length === 0) {
        logger.info(`[Heartbeat] No ${source.platform} messages to process`);
        return;
      }

      logger.info(`[Heartbeat] Executing ${label} heartbeat with ${messages.length} message(s)`);

      const startTime = Date.now();
      const triggers: HeartbeatTrigger[] = [{ platform: source.platform, messages }];
      await this.beginRun(state, read);
      const { checks, delivery } = await this.readChecks(state);

      const invokeResult = await invoke({
        userId: state.userId,
        agentId: state.agentId,
        mode: 'heartbeat',
        postingCeiling: await deliveryTargetService.ceiling(state.agentId, delivery),
        prompt: this.buildTriggeredHeartbeatPrompt(triggers),
        lastSend: this.sendRecordForPrompt(state),
        heartbeatTriggers: triggers,
        abortSignal: pendingWorkService.shutdownSignal,
      });
      // A shutdown stopped the run. The messages of one that posted nothing stay
      // queued for the next boot; one that posted already answered them.
      if (pendingWorkService.shutdownSignal.aborted) {
        if (await this.keepStoppedRun(state, invokeResult)) await this.endCycle(state, read);
        return;
      }
      delivering = true;
      this.noteSends(state, invokeResult.toolCalls, checks);

      // Budget exceeded — skip gracefully
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        await this.endRun(state, read);
        await outboundMessageService.keepWithheldRun({
          agentId: state.agentId,
          userId: state.userId,
          content: HEARTBEAT_BUDGET_NOTICE,
          triggeredBy: 'HEARTBEAT',
          toolCalls: invokeResult.toolCalls,
        });
        logger.info(`[Heartbeat] ${label} heartbeat skipped — budget exceeded`);
        this.trackHeartbeat(state, source.channel, 'budget_exceeded', startedAt);
        return;
      }

      const responseText = lastResponseText(invokeResult.steps);
      if (!invokeResult.error) this.noteReport(state, responseText);
      this.logSteps(responseText, invokeResult.steps, `${source.channel}-triggered`);
      const outcome = await this.finishRun(state, delivery, invokeResult, responseText);

      await this.endCycle(state, read);

      state.consecutiveErrors = 0;

      logger.info(`[Heartbeat] ${label} heartbeat completed in ${Date.now() - startTime}ms: ${outcome}`);
      this.trackHeartbeat(state, source.channel, outcome, startedAt, sentMessageList(invokeResult.toolCalls).length);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] ${label} heartbeat failed: ${errMsg}`);
      if (pendingWorkService.shutdownSignal.aborted && !delivering) return;

      // A failed run answered its messages too; kept, they would fail every run after it.
      if (state) {
        await this.endRun(state, read);
        this.trackHeartbeat(state, source.channel, 'error', startedAt);
        state.consecutiveErrors++;
      }
    } finally {
      if (state) {
        state.isRunning = false;
      }
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /** Emit a product-telemetry event for a finished heartbeat run. */
  private trackHeartbeat(
    state: HeartbeatState,
    /** `timer`, or the channel whose messages started the run. */
    trigger: 'timer' | ChatPlatform,
    result: HeartbeatOutcome | 'budget_exceeded',
    startTime: number,
    messagesSent = 0,
  ): void {
    trackEvent('heartbeat completed', state.userId, {
      'agent.id': state.agentId,
      'heartbeat.trigger': trigger,
      'heartbeat.result': result,
      'heartbeat.messages_sent': String(messagesSent),
      'heartbeat.duration_ms': String(Date.now() - startTime),
    });
  }

  private logSteps(responseText: string, steps: InvokeStep[], label?: string): void {
    const prefix = label ? `${label} ` : '';
    logger.info(
      `[Heartbeat] LLM response: "${responseText.substring(0, 100)}" with ${steps.length} ${prefix}step(s)`,
    );
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const toolNames = step.toolCalls.map((tc) => tc.tool).join(', ');
      logger.info(
        `[Heartbeat] ${prefix}step ${i + 1}/${steps.length}` +
        (toolNames ? ` tools=[${toolNames}]` : '') +
        (step.text ? ` text="${step.text.substring(0, 120)}"` : ' (no text)'),
      );
    }
  }

  private buildHeartbeatPrompt(): string {
    return 'Perform your heartbeat check now.';
  }

  private buildTriggeredHeartbeatPrompt(triggers: HeartbeatTrigger[]): string {
    const platforms = triggers.map((trigger) => trigger.platform).join(' and ');
    const channels = triggers.length > 1 ? 'channels' : 'channel';
    return `Perform your heartbeat check now. This heartbeat was triggered by new messages in the monitored ${platforms} ${channels}.`;
  }

  /**
   * A run reaches people only through what the agent posted. Its result is kept
   * as the run's record, except a run that ended in an error, or ran out of steps
   * before it posted: the agent could not post that, so it goes to the delivery
   * setting's destination.
   */
  private async finishRun(
    state: HeartbeatState,
    delivery: DeliveryTarget,
    invokeResult: InvokeResponse,
    responseText: string,
  ): Promise<HeartbeatOutcome> {
    const unposted = invokeResult.stepLimitReached && sentMessageList(invokeResult.toolCalls).length === 0;
    if ((invokeResult.error || unposted) && responseText) {
      await deliveryTargetService.deliver(state.agentId, state.userId, delivery, responseText, 'HEARTBEAT', {
        toolCalls: invokeResult.toolCalls.length > 0 ? invokeResult.toolCalls : undefined,
      });
      return 'error';
    }
    await outboundMessageService.keepWithheldRun({
      agentId: state.agentId,
      userId: state.userId,
      content: responseText,
      triggeredBy: 'HEARTBEAT',
      toolCalls: invokeResult.toolCalls,
    });
    return sentMessageList(invokeResult.toolCalls).length > 0 ? 'posted' : 'silent';
  }

  /** A run's sends join the record, each replacing the older send to its place. */
  private noteSends(state: HeartbeatState, toolCalls: ToolCallRecord[], checks: string): void {
    state.lastSend = mergeSends(state.lastSend, sentMessageList(toolCalls), Date.now(), checks);
  }

  /**
   * The Heartbeat document this run checks, and where it may post, once the
   * restore is done. A record made under other checks is dropped.
   */
  private async readChecks(state: HeartbeatState): Promise<{ checks: string; delivery: DeliveryTarget }> {
    await state.restored;
    const agent = await prisma.agentWorkspace.findUniqueOrThrow({
      where: { id: state.agentId },
      select: { heartbeatMd: true, heartbeatDeliverTo: true, heartbeatChannelIds: true },
    });
    if (state.lastSend && state.lastSend.checks !== agent.heartbeatMd) state.lastSend = null;
    return {
      checks: agent.heartbeatMd,
      delivery: { deliverTo: agent.heartbeatDeliverTo, channelIds: parseCommaList(agent.heartbeatChannelIds) },
    };
  }

  /** The record as the prompt reads it: each send with its age. */
  private sendRecordForPrompt(state: HeartbeatState): TaskLastSend | undefined {
    const record = state.lastSend;
    if (!record) return undefined;
    return {
      messages: record.sends.map(({ place, text, at }) => `- To ${place} (${formatTimeAgo(at)}): ${text}`).join('\n'),
      at: record.sends[0].at,
      reports: record.reports,
    };
  }

  /**
   * A message a run sent before a shutdown stopped it stays in history, so the
   * restored record has it. The unfinished text is no report. Answers whether the run sent.
   */
  private async keepStoppedRun(state: HeartbeatState, invokeResult: InvokeResponse): Promise<boolean> {
    await outboundMessageService.keepWithheldRun({
      agentId: state.agentId,
      userId: state.userId,
      content: WITHHELD_RUN_TEXT,
      triggeredBy: 'HEARTBEAT',
      toolCalls: invokeResult.toolCalls,
    });
    return sentMessageList(invokeResult.toolCalls).length > 0;
  }

  /** A run's result, so the next run reads whether a finding still held. An empty result says nothing. */
  private noteReport(state: HeartbeatState, text: string): void {
    if (!state.lastSend || !text.trim()) return;
    state.lastSend = addReport(state.lastSend, text.trim(), Date.now());
  }


  // ============================================================================
  // Status & Control
  // ============================================================================

  getStatus(): {
    isActive: boolean;
    lastRun: Date | null;
    isRunning: boolean;
    consecutiveErrors: number;
    intervalMs: number | null;
  } | null {
    const state = this.heartbeatState;
    if (!state) return null;

    return {
      isActive: true,
      lastRun: state.lastRun,
      isRunning: state.isRunning,
      consecutiveErrors: state.consecutiveErrors,
      intervalMs: state.intervalMs,
    };
  }

  stopAll(): void {
    logger.info(`[Heartbeat] Stopping the heartbeat`);
    this.clearHeartbeatTimer();
  }

  async triggerHeartbeat(): Promise<HeartbeatResult> {
    return this.executeHeartbeat();
  }
}

// Export singleton instance
export const heartbeatService = new HeartbeatService();
