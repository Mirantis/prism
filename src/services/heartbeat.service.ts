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
import { messageDeliveryService } from './message-delivery.service';
import { runClassificationGate, isRecentDuplicate } from '../lib/classification-gate';
import { agentStatusService } from './agent-status.service';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { formatTimeAgo } from '../prompts/context-builder';
import { ChannelTriggerMessage, HeartbeatTrigger, InvokeStep } from '../types';
import { heartbeatDelayMs, heartbeatDueAt } from './heartbeat-schedule';
import type { ChatPlatform } from './channel-adapter.interface';

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
  lastAlertText: string | null;
  lastAlertAt: number | null;
}

interface HeartbeatResult {
  shouldSkip: boolean;
  text: string;
}

/**
 * A channel that queues messages to start the heartbeat. A timer heartbeat
 * drains every registered source, so nothing queued waits for a trigger.
 */
export interface HeartbeatTriggerSource {
  /** The channel's adapter name; reported as the heartbeat's trigger. */
  readonly channel: ChatPlatform;
  /** How the prompt names the channel's platform. */
  readonly platform: string;
  /** Hand over every message queued for `agentId`, and forget them. */
  drain(agentId: string): Promise<ChannelTriggerMessage[]>;
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

  registerTriggerSource(source: HeartbeatTriggerSource): void {
    this.triggerSources.push(source);
  }

  startHeartbeat(agent: AgentWorkspace, schedule: HeartbeatSchedule): void {
    // Heartbeat enablement is persisted in the backend DB.
    // If the agent is marked STOPPED, we don't start a timer on runtime startup.
    if (agent.heartbeatStatus === 'STOPPED') {
      logger.info(`[Heartbeat] Not starting (status: STOPPED)`);
      return;
    }

    const intervalMs = agent.heartbeatIntervalMs || 28800000;
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
      dueAt: heartbeatDueAt(agent.nextHeartbeatAt, agent.lastHeartbeat, intervalMs, now),
      lastRun: agent.lastHeartbeat,
      isRunning: false,
      consecutiveErrors: 0,
      lastAlertText: null,
      lastAlertAt: null,
    };

    this.heartbeatState = state;
    return state;
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

    try {
      logger.info(`[Heartbeat] Executing`);

      // Drain every channel's pending trigger messages so they aren't orphaned
      const triggers: HeartbeatTrigger[] = [];
      for (const source of this.triggerSources) {
        const messages = await source.drain(state.agentId);
        if (messages.length === 0) continue;
        logger.info(`[Heartbeat] Picked up ${messages.length} pending ${source.platform} message(s) during timer heartbeat`);
        triggers.push({ platform: source.platform, messages });
      }
      const triggered = triggers.length > 0;

      // Invoke LLM directly (in-process, no HTTP)
      const invokeResult = await invoke({
        userId,
        agentId: state.agentId,
        mode: 'heartbeat',
        prompt: triggered ? this.buildTriggeredHeartbeatPrompt(triggers) : this.buildHeartbeatPrompt(),
        lastHeartbeatAlert: state.lastAlertText ?? undefined,
        lastHeartbeatAlertAt: state.lastAlertAt ?? undefined,
        heartbeatTriggers: triggered ? triggers : undefined,
      });

      // Budget exceeded — skip and reset error streak so the timer keeps running.
      // The cycle still happened, so the next one is a full interval away.
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        await this.recordCycle(state);
        logger.info(`[Heartbeat] Skipping — budget exceeded`);
        this.trackHeartbeat(state, 'timer', 'budget_exceeded', startTime);
        return { shouldSkip: true, text: 'Budget exceeded' };
      }

      const responseText = lastResponseText(invokeResult.steps);

      // Determine if we should deliver
      let shouldDeliver = false;
      if (!responseText) {
        // Empty response — nothing to deliver
        shouldDeliver = false;
      } else if (this.isDuplicate(state, responseText)) {
        // Exact duplicate within 24h — cheap programmatic check
        shouldDeliver = false;
      } else {
        // Ask the classification gate
        shouldDeliver = await this.shouldDeliverAlert(
          state.agentId,
          userId,
          responseText,
          state.lastAlertText ?? null,
          state.lastAlertAt ?? null,
        );
      }

      this.logSteps(responseText, invokeResult.steps);

      await this.recordCycle(state);

      if (shouldDeliver) {
        await messageDeliveryService.publishToLatestThread(
          state.agentId,
          userId,
          responseText,
          'HEARTBEAT',
          {
            toolCalls: invokeResult.toolCalls.length > 0 ? invokeResult.toolCalls : undefined,
            attachmentIds: invokeResult.attachmentIds,
          },
        );

        this.recordAlert(state, responseText);
        logger.info(`[Heartbeat] Alert for agent: ${responseText.substring(0, 100)}`);
      }

      state.consecutiveErrors = 0;

      const result: HeartbeatResult = {
        shouldSkip: !shouldDeliver,
        text: shouldDeliver ? responseText : '',
      };

      logger.info(`[Heartbeat] Completed in ${Date.now() - startTime}ms: ${result.shouldSkip ? 'suppressed' : 'alert'}`);
      this.trackHeartbeat(state, 'timer', shouldDeliver ? 'delivered' : 'suppressed', startTime);
      return result;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] Failed: ${errMsg}`);

      // A failed run is still a cycle. It spaces the error streak one interval
      // apart, which is what the auto-stop below is counting.
      await this.recordCycle(state);

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
   * Execute a single channel-triggered heartbeat by draining pending messages.
   * Messages that arrive during execution wait for the next run.
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

    try {
      const messages = await source.drain(state.agentId);

      if (messages.length === 0) {
        logger.info(`[Heartbeat] No ${source.platform} messages to process`);
        return;
      }

      logger.info(`[Heartbeat] Executing ${label} heartbeat with ${messages.length} message(s)`);

      const startTime = Date.now();
      const triggers: HeartbeatTrigger[] = [{ platform: source.platform, messages }];

      const invokeResult = await invoke({
        userId: state.userId,
        agentId: state.agentId,
        mode: 'heartbeat',
        prompt: this.buildTriggeredHeartbeatPrompt(triggers),
        lastHeartbeatAlert: state.lastAlertText ?? undefined,
        lastHeartbeatAlertAt: state.lastAlertAt ?? undefined,
        heartbeatTriggers: triggers,
      });

      // Budget exceeded — skip gracefully
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        logger.info(`[Heartbeat] ${label} heartbeat skipped — budget exceeded`);
        this.trackHeartbeat(state, source.channel, 'budget_exceeded', startedAt);
        return;
      }

      const responseText = lastResponseText(invokeResult.steps);

      // Determine if we should deliver (same gate logic as regular heartbeats)
      let shouldDeliver = false;
      if (!responseText) {
        shouldDeliver = false;
      } else if (this.isDuplicate(state, responseText)) {
        shouldDeliver = false;
      } else {
        shouldDeliver = await this.shouldDeliverAlert(
          state.agentId,
          state.userId,
          responseText,
          state.lastAlertText ?? null,
          state.lastAlertAt ?? null,
        );
      }

      this.logSteps(responseText, invokeResult.steps, `${source.channel}-triggered`);

      await this.recordCycle(state);

      logger.info(`[Heartbeat] ${label} heartbeat shouldDeliver=${shouldDeliver}`);

      if (shouldDeliver) {
        await messageDeliveryService.publishToLatestThread(
          state.agentId,
          state.userId,
          responseText,
          'HEARTBEAT',
          {
            toolCalls: invokeResult.toolCalls.length > 0 ? invokeResult.toolCalls : undefined,
            attachmentIds: invokeResult.attachmentIds,
          },
        );

        this.recordAlert(state, responseText);
        logger.info(`[Heartbeat] ${label} alert: ${responseText.substring(0, 100)}`);
      }

      state.consecutiveErrors = 0;

      logger.info(`[Heartbeat] ${label} heartbeat completed in ${Date.now() - startTime}ms`);
      this.trackHeartbeat(state, source.channel, shouldDeliver ? 'delivered' : 'suppressed', startedAt);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] ${label} heartbeat failed: ${errMsg}`);

      if (state) {
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
    result: 'delivered' | 'suppressed' | 'budget_exceeded' | 'error',
    startTime: number,
  ): void {
    trackEvent('heartbeat completed', state.userId, {
      'agent.id': state.agentId,
      'heartbeat.trigger': trigger,
      'heartbeat.result': result,
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

  private async shouldDeliverAlert(
    agentId: string,
    userId: string,
    heartbeatResponse: string,
    lastAlertText: string | null,
    lastAlertAt: number | null,
  ): Promise<boolean> {
    if (!heartbeatResponse.trim()) return false;

    const lastAlertContext = lastAlertText
      ? `## Last Alert Sent to User (${lastAlertAt ? formatTimeAgo(lastAlertAt) : 'recently'})\n${lastAlertText}`
      : 'No previous alert has been sent.';

    const systemPrompt = `You are a message gate for an agent's heartbeat system. Decide whether a heartbeat report should be delivered to the user or suppressed.

DELIVER if it contains:
- A NEW issue or finding not covered by the last alert
- A SIGNIFICANT CHANGE in status (resolved, worsened, new items affected)
- Actionable information the user hasn't seen

SUPPRESS if it:
- Repeats the same information from the last alert with no meaningful change
- Only shows minor variations with no new insight
- Is a generic "all clear" or "nothing to report" message
- Is meta-commentary about the heartbeat itself (e.g. "no checks configured", "heartbeat config is empty", "nothing to check", "staying quiet") rather than a real finding

Respond with exactly one word: DELIVER or SUPPRESS`;

    return runClassificationGate({
      system: systemPrompt,
      user: `${lastAlertContext}\n\n## New Heartbeat Report\n${heartbeatResponse}`,
      functionId: 'heartbeat-gate',
      userId,
      agentId,
      logLabel: 'Heartbeat:Gate',
    });
  }

  private isDuplicate(state: HeartbeatState | undefined, alertText: string): boolean {
    if (!state?.lastAlertText || !state.lastAlertAt) return false;
    return isRecentDuplicate({ text: state.lastAlertText, at: state.lastAlertAt }, alertText);
  }

  private recordAlert(state: HeartbeatState | undefined, alertText: string): void {
    if (!state) return;
    state.lastAlertText = alertText;
    state.lastAlertAt = Date.now();
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
