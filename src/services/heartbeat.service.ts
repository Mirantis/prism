/**
 * Heartbeat Service (Agent-Runtime)
 *
 * Manages the always-on heartbeat system for personal agents.
 * Invokes the LLM directly (in-process) and communicates with
 * the backend via the internal REST API.
 *
 * Key design principles:
 * - Classification gate LLM (Haiku) decides DELIVER/SUPPRESS after each heartbeat
 * - 24h duplicate suppression for exact-match alerts
 * - Fail-open: if the gate call fails, deliver the message
 */

import { invoke } from '../invoke';
import { AgentWorkspace } from '@prisma/client';
import { messageDeliveryService } from './message-delivery.service';
import { runClassificationGate, isRecentDuplicate } from '../lib/classification-gate';
import { agentStatusService } from './agent-status.service';
import { slackMessageQueueService } from './slack-message-queue.service';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { formatTimeAgo } from '../prompts/context-builder';
import { InvokeStep, SlackTriggerMessage } from '../types';

// ============================================================================
// Types
// ============================================================================

interface HeartbeatState {
  userId: string;
  agentId: string;
  intervalId: NodeJS.Timeout;
  intervalMs: number;
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

// ============================================================================
// Heartbeat Service
// ============================================================================

class HeartbeatService {
  // Map from agentId to heartbeat state
  private heartbeatState: HeartbeatState | null = null;

  startHeartbeat(agent: AgentWorkspace): void {
    // Heartbeat enablement is persisted in the backend DB.
    // If the agent is marked STOPPED, we don't start a timer on runtime startup.
    if (agent.heartbeatStatus === 'STOPPED') {
      logger.info(`[Heartbeat] Not starting (status: STOPPED)`);
      return;
    }

    if (this.heartbeatState) {
      this.clearHeartbeatTimer();
    }

    const intervalMs = agent.heartbeatIntervalMs || 28800000;

    const intervalId = setInterval(async () => {
      await this.executeHeartbeat();
    }, intervalMs);

    this.heartbeatState = {
      userId: agent.userId,
      agentId: agent.id,
      intervalId,
      intervalMs,
      lastRun: null,
      isRunning: false,
      consecutiveErrors: 0,
      lastAlertText: null,
      lastAlertAt: null,
    };

    // Fire-and-forget persistence (don't block startup/management call).
    agentStatusService.updateAgentHeartbeatStatus('ENABLED').catch((err) => {
      logger.warn(`[Heartbeat] Failed to persist ENABLED status: ${err instanceof Error ? err.message : String(err)}`);
    });

    logger.info(`[Heartbeat] Started (interval: ${intervalMs / 60000}min)`);
    trackEvent('heartbeat started', agent.userId, {
      'agent.id': agent.id,
      'heartbeat.interval_ms': String(intervalMs),
    });
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
      clearInterval(state.intervalId);
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

      // Budget exceeded — skip and reset error streak so the timer keeps running
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        logger.info(`[Heartbeat] Skipping — budget exceeded`);
        this.trackHeartbeat(state, 'timer', 'budget_exceeded', startTime);
        return { shouldSkip: true, text: 'Budget exceeded' };
      }

      // Use only the last step's text (the final summary), not intermediate step texts
      const lastStep = invokeResult.steps[invokeResult.steps.length - 1];
      const responseText = (lastStep?.text ?? '').trim();

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

      await agentStatusService.updateHeartbeatTimestamp();

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

      state.lastRun = new Date();
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

      // Use only the last step's text (the final summary), not intermediate step texts
      const lastStep = invokeResult.steps[invokeResult.steps.length - 1];
      const responseText = (lastStep?.text ?? '').trim();

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

      await agentStatusService.updateHeartbeatTimestamp();

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

      state.lastRun = new Date();
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
