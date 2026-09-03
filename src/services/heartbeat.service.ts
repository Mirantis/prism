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
import { slackMessageQueueService } from './slack-message-queue.service';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { formatTimeAgo } from '../prompts/context-builder';
import { InvokeStep, SlackTriggerMessage } from '../types';
import { heartbeatDelayMs, heartbeatDueAt } from './heartbeat-schedule';

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

  /** First registration in this process: the schedule comes off the last run. */
  private registerState(agent: AgentWorkspace, intervalMs: number, now: number): HeartbeatState {
    const state: HeartbeatState = {
      userId: agent.userId,
      agentId: agent.id,
      timeoutId: null,
      intervalMs,
      dueAt: heartbeatDueAt(agent.lastHeartbeat, intervalMs, now),
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
   * One cycle happened. The in-memory cursor and the persisted one move
   * together, so the next process computes the same schedule. A write that
   * fails logs a warning and leaves the persisted cursor behind, which reads as
   * overdue on the next boot, so a check runs early.
   */
  private async recordCycle(state: HeartbeatState): Promise<void> {
    const ranAt = new Date();
    state.lastRun = ranAt;
    state.dueAt = ranAt.getTime() + state.intervalMs;

    try {
      await agentStatusService.updateHeartbeatTimestamp();
    } catch (err) {
      logger.warn(
        `[Heartbeat] Failed to persist the last-run timestamp: ${err instanceof Error ? err.message : String(err)}`,
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

      // Drain any pending Slack messages from DB so they aren't orphaned
      const pendingSlackMessages = await slackMessageQueueService.drain(state.agentId);
      const hasSlackMessages = pendingSlackMessages.length > 0;
      if (hasSlackMessages) {
        logger.info(`[Heartbeat] Picked up ${pendingSlackMessages.length} pending Slack message(s) during timer heartbeat`);
      }

      // Invoke LLM directly (in-process, no HTTP)
      const invokeResult = await invoke({
        userId,
        agentId: state.agentId,
        mode: 'heartbeat',
        prompt: hasSlackMessages
          ? this.buildSlackTriggeredHeartbeatPrompt(pendingSlackMessages)
          : this.buildHeartbeatPrompt(),
        lastHeartbeatAlert: state.lastAlertText ?? undefined,
        lastHeartbeatAlertAt: state.lastAlertAt ?? undefined,
        slackMessages: hasSlackMessages ? pendingSlackMessages : undefined,
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
  // Slack-Triggered Heartbeat
  // ============================================================================

  /**
   * Notify that new Slack messages are queued in the DB.
   * Fires a heartbeat if not already running. If already running, the
   * throttle queue will schedule another trigger after the cooldown.
   */
  triggerFromSlack(): 'queued' | 'ignored' {
    const state = this.heartbeatState;

    if (!state) {
      logger.warn(`[Heartbeat] No heartbeat state — ignoring Slack trigger`);
      return 'ignored';
    }

    logger.info(`[Heartbeat] Slack trigger notification`);

    if (state.isRunning) {
      logger.info(`[Heartbeat] Heartbeat already running, throttle queue will handle next trigger`);
      return 'ignored';
    }

    // Fire-and-forget — errors are handled inside
    this.executeSlackTriggeredHeartbeat().catch((err) => {
      logger.error(`[Heartbeat] Slack-triggered heartbeat failed:`, err);
    });

    return 'queued';
  }

  /**
   * Execute a single Slack-triggered heartbeat by draining pending messages.
   * New messages that arrive during execution will be handled by the
   * throttle queue scheduling another trigger after the cooldown.
   */
  private async executeSlackTriggeredHeartbeat(): Promise<void> {
    logger.info(`[Heartbeat] Starting Slack-triggered heartbeat`);
    const startedAt = Date.now();
    const state = this.heartbeatState;

    if (!state || state.isRunning) {
      logger.info(`[Heartbeat] Heartbeat already running or no state`);

      return;
    }

    state.isRunning = true;

    try {
      const messages = await slackMessageQueueService.drain(state.agentId);

      if (messages.length === 0) {
        logger.info(`[Heartbeat] No Slack messages to process`);
        return;
      }

      logger.info(`[Heartbeat] Executing Slack-triggered heartbeat with ${messages.length} message(s)`);

      const startTime = Date.now();

      const invokeResult = await invoke({
        userId: state.userId,
        agentId: state.agentId,
        mode: 'heartbeat',
        prompt: this.buildSlackTriggeredHeartbeatPrompt(messages),
        lastHeartbeatAlert: state.lastAlertText ?? undefined,
        lastHeartbeatAlertAt: state.lastAlertAt ?? undefined,
        slackMessages: messages,
      });

      // Budget exceeded — skip gracefully
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        logger.info(`[Heartbeat] Slack-triggered heartbeat skipped — budget exceeded`);
        this.trackHeartbeat(state, 'slack', 'budget_exceeded', startedAt);
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

      this.logSteps(responseText, invokeResult.steps, 'slack-triggered');

      await this.recordCycle(state);

      logger.info(`[Heartbeat] Slack-triggered heartbeat shouldDeliver=${shouldDeliver}`);

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
        logger.info(`[Heartbeat] Slack-triggered alert: ${responseText.substring(0, 100)}`);
      }

      state.consecutiveErrors = 0;

      logger.info(`[Heartbeat] Slack-triggered heartbeat completed in ${Date.now() - startTime}ms`);
      this.trackHeartbeat(state, 'slack', shouldDeliver ? 'delivered' : 'suppressed', startedAt);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] Slack-triggered heartbeat failed: ${errMsg}`);

      if (state) {
        this.trackHeartbeat(state, 'slack', 'error', startedAt);
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
    trigger: 'timer' | 'slack',
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

  private buildSlackTriggeredHeartbeatPrompt(_messages: SlackTriggerMessage[]): string {
    return 'Perform your heartbeat check now. This heartbeat was triggered by new messages in the monitored Slack channel.';
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
