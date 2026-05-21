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

import { generateText } from 'ai';
import { invoke } from '../invoke';
import { AgentWorkspace } from '@prisma/client';
import { messageDeliveryService } from './message-delivery.service';
import { getClassificationModel } from '../lib/nexus-provider';
import { agentWorkspaceService } from './agent-workspace.service';
import { agentStatusService } from './agent-status.service';
import { slackMessageQueueService } from './slack-message-queue.service';
import { isLangfuseEnabled } from '../lib/langfuse';
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

const DUPLICATE_SUPPRESSION_HOURS = 24;

// ============================================================================
// Heartbeat Service
// ============================================================================

class HeartbeatService {
  // Map from agentId to heartbeat state
  private heartbeats: Map<string, HeartbeatState> = new Map();

  startHeartbeat(agent: AgentWorkspace): void {
    const agentId = agent.id;

    // Heartbeat enablement is persisted in the backend DB.
    // If the agent is marked STOPPED, we don't start a timer on runtime startup.
    if (agent.heartbeatStatus === 'STOPPED') {
      logger.info(`[Heartbeat] Not starting for agent ${agentId.substring(0, 8)} (status: STOPPED)`);
      return;
    }

    if (this.heartbeats.has(agentId)) {
      this.clearHeartbeatTimer(agentId);
    }

    const intervalMs = agent.heartbeatIntervalMs || 28800000;

    const intervalId = setInterval(async () => {
      await this.executeHeartbeat(agentId);
    }, intervalMs);

    this.heartbeats.set(agentId, {
      userId: agent.userId,
      agentId,
      intervalId,
      intervalMs,
      lastRun: null,
      isRunning: false,
      consecutiveErrors: 0,
      lastAlertText: null,
      lastAlertAt: null,
    });

    // Fire-and-forget persistence (don't block startup/management call).
    agentStatusService.updateAgentHeartbeatStatus(agentId, 'ENABLED').catch((err) => {
      logger.warn(`[Heartbeat] Failed to persist ENABLED status for agent ${agentId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    });

    logger.info(`[Heartbeat] Started for agent ${agentId.substring(0, 8)} (interval: ${intervalMs / 60000}min)`);
  }

  stopHeartbeat(agentId: string): void {
    agentStatusService.updateAgentHeartbeatStatus(agentId, 'STOPPED').catch((err) => {
      logger.warn(`[Heartbeat] Failed to persist STOPPED status for agent ${agentId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.clearHeartbeatTimer(agentId);
  }

  private clearHeartbeatTimer(agentId: string): void {
    const state = this.heartbeats.get(agentId);
    if (state) {
      clearInterval(state.intervalId);
      this.heartbeats.delete(agentId);
    }
  }

  async executeHeartbeat(agentId: string): Promise<HeartbeatResult> {
    const startTime = Date.now();
    const state = this.heartbeats.get(agentId);

    if (!state) {
      return { shouldSkip: true, text: 'No registered heartbeat for this agent' };
    }

    if (state.isRunning) {
      return { shouldSkip: true, text: 'Already running' };
    }

    state.isRunning = true;
    const userId = state.userId;

    try {
      logger.info(`[Heartbeat] Executing for agent ${agentId.substring(0, 8)}`);

      // Drain any pending Slack messages from DB so they aren't orphaned
      const pendingSlackMessages = await slackMessageQueueService.drain(agentId);
      const hasSlackMessages = pendingSlackMessages.length > 0;
      if (hasSlackMessages) {
        logger.info(`[Heartbeat] Picked up ${pendingSlackMessages.length} pending Slack message(s) during timer heartbeat`);
      }

      // Invoke LLM directly (in-process, no HTTP)
      const invokeResult = await invoke({
        userId,
        agentId,
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
        logger.info(`[Heartbeat:${agentId.substring(0, 8)}] Skipping — budget exceeded`);
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
          userId,
          agentId,
          responseText,
          state.lastAlertText ?? null,
          state.lastAlertAt ?? null,
        );
      }

      this.logSteps(agentId, responseText, invokeResult.steps);

      await agentStatusService.updateHeartbeatTimestamp(agentId);

      if (shouldDeliver) {
        await messageDeliveryService.publishToActiveThread(
          agentId,
          userId,
          responseText,
          'HEARTBEAT',
          { toolCalls: invokeResult.toolCalls.length > 0 ? invokeResult.toolCalls : undefined },
        );

        this.recordAlert(state, responseText);
        logger.info(`[Heartbeat] Alert for agent ${agentId.substring(0, 8)}: ${responseText.substring(0, 100)}`);
      }

      state.lastRun = new Date();
      state.consecutiveErrors = 0;

      const result: HeartbeatResult = {
        shouldSkip: !shouldDeliver,
        text: shouldDeliver ? responseText : '',
      };

      logger.info(`[Heartbeat] Completed for agent ${agentId.substring(0, 8)} in ${Date.now() - startTime}ms: ${result.shouldSkip ? 'suppressed' : 'alert'}`);
      return result;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] Failed for agent ${agentId.substring(0, 8)}: ${errMsg}`);

      state.consecutiveErrors++;
      if (state.consecutiveErrors >= 5) {
        logger.error(`[Heartbeat] Stopping for agent ${agentId.substring(0, 8)}: too many consecutive errors`);
        this.stopHeartbeat(agentId);
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
  triggerFromSlack(agentId: string): 'queued' | 'ignored' {
    const state = this.heartbeats.get(agentId);

    if (!state) {
      logger.warn(`[Heartbeat] No heartbeat state for agent ${agentId.substring(0, 8)} — ignoring Slack trigger`);
      return 'ignored';
    }

    logger.info(`[Heartbeat] Slack trigger notification for agent ${agentId.substring(0, 8)}`);

    if (state.isRunning) {
      logger.info(`[Heartbeat] Heartbeat already running for agent ${agentId.substring(0, 8)}, throttle queue will handle next trigger`);
      return 'ignored';
    }

    // Fire-and-forget — errors are handled inside
    this.executeSlackTriggeredHeartbeat(agentId).catch((err) => {
      logger.error(`[Heartbeat] Slack-triggered heartbeat failed for agent ${agentId.substring(0, 8)}:`, err);
    });

    return 'queued';
  }

  /**
   * Execute a single Slack-triggered heartbeat by draining pending messages.
   * New messages that arrive during execution will be handled by the
   * throttle queue scheduling another trigger after the cooldown.
   */
  private async executeSlackTriggeredHeartbeat(agentId: string): Promise<void> {
    logger.info(`[Heartbeat] Starting Slack-triggered heartbeat for agent ${agentId.substring(0, 8)}`);
    const state = this.heartbeats.get(agentId);

    if (!state || state.isRunning) {
      logger.info(`[Heartbeat] Heartbeat already running or no state for agent ${agentId.substring(0, 8)}`);
      return;
    }

    state.isRunning = true;

    try {
      const messages = await slackMessageQueueService.drain(agentId);

      if (messages.length === 0) {
        logger.info(`[Heartbeat] No Slack messages to process for agent ${agentId.substring(0, 8)}`);
        return;
      }

      logger.info(`[Heartbeat] Executing Slack-triggered heartbeat for agent ${agentId.substring(0, 8)} with ${messages.length} message(s)`);

      const startTime = Date.now();

      const invokeResult = await invoke({
        userId: state.userId,
        agentId,
        mode: 'heartbeat',
        prompt: this.buildSlackTriggeredHeartbeatPrompt(messages),
        lastHeartbeatAlert: state.lastAlertText ?? undefined,
        lastHeartbeatAlertAt: state.lastAlertAt ?? undefined,
        slackMessages: messages,
      });

      // Budget exceeded — skip gracefully
      if (invokeResult.error?.type === 'budget_exceeded') {
        state.consecutiveErrors = 0;
        logger.info(`[Heartbeat:${agentId.substring(0, 8)}] Slack-triggered heartbeat skipped — budget exceeded`);
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
          state.userId,
          agentId,
          responseText,
          state.lastAlertText ?? null,
          state.lastAlertAt ?? null,
        );
      }

      this.logSteps(agentId, responseText, invokeResult.steps, 'slack-triggered');

      await agentStatusService.updateHeartbeatTimestamp(agentId);

      logger.info(`[Heartbeat] Slack-triggered heartbeat shouldDeliver=${shouldDeliver} for agent ${agentId.substring(0, 8)}`);

      if (shouldDeliver) {
        await messageDeliveryService.publishToActiveThread(
          agentId,
          state.userId,
          responseText,
          'HEARTBEAT',
          { toolCalls: invokeResult.toolCalls.length > 0 ? invokeResult.toolCalls : undefined },
        );

        this.recordAlert(state, responseText);
        logger.info(`[Heartbeat] Slack-triggered alert for agent ${agentId.substring(0, 8)}: ${responseText.substring(0, 100)}`);
      }

      state.lastRun = new Date();
      state.consecutiveErrors = 0;

      logger.info(`[Heartbeat] Slack-triggered heartbeat completed for agent ${agentId.substring(0, 8)} in ${Date.now() - startTime}ms`);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Heartbeat] Slack-triggered heartbeat failed for agent ${agentId.substring(0, 8)}: ${errMsg}`);

      if (state) {
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

  private logSteps(agentId: string, responseText: string, steps: InvokeStep[], label?: string): void {
    const prefix = label ? `${label} ` : '';
    logger.info(
      `[Heartbeat] LLM response for agent ${agentId.substring(0, 8)}: "${responseText.substring(0, 100)}" with ${steps.length} ${prefix}step(s)`,
    );
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const toolNames = step.toolCalls.map((tc) => tc.tool).join(', ');
      logger.info(
        `[Heartbeat] Agent ${agentId.substring(0, 8)} ${prefix}step ${i + 1}/${steps.length}` +
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
    userId: string,
    agentId: string,
    heartbeatResponse: string,
    lastAlertText: string | null,
    lastAlertAt: number | null,
  ): Promise<boolean> {
    if (!heartbeatResponse.trim()) return false;

    const agentToken = await agentWorkspaceService.getNexusMcpAgentToken(agentId);
    if (!agentToken) {
      logger.warn({ agentId }, '[Heartbeat:Gate] No Nexus agent token — defaulting to deliver');
      return true;
    }

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

Respond with exactly one word: DELIVER or SUPPRESS`;

    try {
      const result = await generateText({
        model: getClassificationModel(agentToken),
        system: systemPrompt,
        messages: [{ role: 'user' as const, content: `${lastAlertContext}\n\n## New Heartbeat Report\n${heartbeatResponse}` }],
        maxOutputTokens: 10,
        temperature: 0,
        // Langfuse tracing (enabled when LANGFUSE keys are set)
        ...(isLangfuseEnabled() && {
          experimental_telemetry: {
            isEnabled: true,
            functionId: 'heartbeat-gate',
            metadata: {
              userId,
            },
          },
        }),
      });
      const shouldDeliver = result.text.trim().toUpperCase().startsWith('DELIVER');
      logger.info(`[Heartbeat:Gate] Decision: ${result.text.trim()} (deliver=${shouldDeliver})`);
      return shouldDeliver;
    } catch (error) {
      logger.error({ err: error }, '[Heartbeat:Gate] Gate call failed, defaulting to deliver');
      return true; // fail-open
    }
  }

  private isDuplicate(state: HeartbeatState | undefined, alertText: string): boolean {
    if (!state?.lastAlertText || !state.lastAlertAt) return false;
    const hoursSinceLast = (Date.now() - state.lastAlertAt) / (1000 * 60 * 60);
    if (hoursSinceLast >= DUPLICATE_SUPPRESSION_HOURS) return false;
    return alertText.trim() === state.lastAlertText.trim();
  }

  private recordAlert(state: HeartbeatState | undefined, alertText: string): void {
    if (!state) return;
    state.lastAlertText = alertText;
    state.lastAlertAt = Date.now();
  }

  // ============================================================================
  // Status & Control
  // ============================================================================

  getStatus(agentId: string): {
    isActive: boolean;
    lastRun: Date | null;
    isRunning: boolean;
    consecutiveErrors: number;
    intervalMs: number | null;
  } | null {
    const state = this.heartbeats.get(agentId);
    if (!state) return null;

    return {
      isActive: true,
      lastRun: state.lastRun,
      isRunning: state.isRunning,
      consecutiveErrors: state.consecutiveErrors,
      intervalMs: state.intervalMs,
    };
  }

  getActiveAgentIds(): string[] {
    return Array.from(this.heartbeats.keys());
  }

  hasHeartbeat(agentId: string): boolean {
    return this.heartbeats.has(agentId);
  }

  stopAll(): void {
    logger.info(`[Heartbeat] Stopping all heartbeats (${this.heartbeats.size} active)`);
    for (const [agentId] of this.heartbeats) {
      this.clearHeartbeatTimer(agentId);
    }
  }

  async triggerHeartbeat(agentId: string): Promise<HeartbeatResult> {
    return this.executeHeartbeat(agentId);
  }
}

// Export singleton instance
export const heartbeatService = new HeartbeatService();
