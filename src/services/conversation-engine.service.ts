/**
 * Conversation Engine Service
 *
 * Handles chat conversations with the personal agent.
 * Invokes the LLM directly (no queue, no HTTP hop) and delivers
 * responses via the local MessageDeliveryService.
 */

import { generateText } from 'ai';
import { messageDeliveryService } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { attachmentService } from './attachment.service';
import { invokeStream } from '../invoke';
import { ToolCallRecord, InvokeStep, UIBlock } from '../types';
import { logger } from '../logger';
import prisma from '../lib/prisma';
import { getClassificationModel } from '../lib/classification';
import { isLangfuseEnabled } from '../lib/langfuse';
import { isTelemetryEnabled, trackEvent } from '../lib/telemetry';

// ============================================================================
// Feedback gate tuning (channel-agnostic)
// ============================================================================

/**
 * Per-thread cadence: prompt for feedback on the 1st user turn, then every
 * Nth user turn thereafter. Counts USER messages (one per turn), so multi-
 * step responses don't throw the rhythm off.
 */
export const FEEDBACK_CADENCE_N = 3;

// ============================================================================
// Types
// ============================================================================

export interface ChatInput {
  userId: string;
  agentId: string;
  message: string;
  threadId?: string;
  /** Ids of already-stored attachments to link to this user message. */
  attachmentIds?: string[];
  /** Per-turn runtime notices injected into the system prompt (see InvokeRequest). */
  runtimeNotices?: string[];
  metadata?: {
    channel?: 'websocket' | 'slack';
    channelId?: string;
    slackThreadTs?: string;
    senderSlackUserId?: string;
    senderName?: string;
  };
}

export interface ChatResponse {
  threadId: string;
  messageId: string;
  content: string;
  toolCalls: ToolCallRecord[];
  blocks?: unknown[];
  durationMs: number;
}

// ============================================================================
// Conversation Engine Service
// ============================================================================

class ConversationEngineService {
  /**
   * Single place deciding whether to ask the user for 👍/👎 feedback on the
   * current turn. Gates run cheap→expensive; all must pass:
   *
   * 1. Telemetry enabled. Feedback clicks are emitted via `trackEvent`, which
   *    is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Showing buttons
   *    in that state would silently drop the rating and waste a classifier call.
   * 2. Per-thread cadence: show on the 1st user turn, then every Nth turn.
   *    Counts USER messages (one per turn) rather than AGENT messages (one
   *    per text-producing step), so multi-step responses don't throw the
   *    cadence off. The current turn's user message has already been stored
   *    by the caller, so `userCount` is 1 on the very first turn — hence
   *    `(n - 1) % N === 0`.
   * 3. Classifier judgment: the configured Haiku classification model rates
   *    whether the reply is substantive enough that a thumbs-up/down signal
   *    would be meaningful (see `isResponseWorthyOfFeedback`). Fail-closed —
   *    if the classifier errors out we hide the buttons and log, rather than
   *    spamming the user with feedback prompts during a Bedrock outage.
   *
   * Channel-agnostic: adapters decide whether to render the prompt.
   */
  private async shouldShowFeedback(
    threadId: string,
    userMessage: string,
    terminalText: string | undefined,
    userId: string,
    agentId: string,
  ): Promise<boolean> {
    if (!isTelemetryEnabled()) return false;
    if (!terminalText) return false;

    const userCount = await prisma.conversationMessage.count({
      where: {
        threadId,
        role: 'USER',
        triggeredBy: 'USER_INPUT',
      },
    });
    if (userCount === 0 || (userCount - 1) % FEEDBACK_CADENCE_N !== 0) {
      return false;
    }

    return this.isResponseWorthyOfFeedback(userMessage, terminalText, userId, agentId);
  }

  /**
   * Binary classifier: is `agentResponse` a substantive reply where a user
   * thumbs-up/down carries useful signal? Routes through Nexus (same as the
   * main `invoke()` path) using the agent's Nexus token. Returns `false`
   * (fail-closed) on any classifier error or when no Nexus token is available
   * — a broken/unroutable classifier should not cause us to show feedback on
   * every reply.
   */
  private async isResponseWorthyOfFeedback(
    userMessage: string,
    agentResponse: string,
    userId: string,
    agentId: string,
  ): Promise<boolean> {
    const systemPrompt = `You are a gate deciding whether to ask a user to rate an agent's reply with thumbs-up/down.

Reply WORTHY when the agent's response is a substantive answer where a rating carries useful signal:
- analysis, explanation, plan, code, investigation summary, recommendation
- anything the user might judge as helpful or not

Reply SKIP when a rating would be noise:
- short acknowledgement ("Got it!", "Done.", "OK, on it.")
- clarifying question back to the user
- error or refusal ("I can't help with that", "I don't have access to …")
- trivial lookup or confirmation with no judgement involved
- progress update with no new conclusion

Respond with exactly one word: WORTHY or SKIP`;

    try {
      const result = await generateText({
        model: getClassificationModel(),
        system: systemPrompt,
        messages: [
          {
            role: 'user' as const,
            content: `## User message\n${userMessage}\n\n## Agent reply\n${agentResponse}`,
          },
        ],
        maxOutputTokens: 5,
        temperature: 0,
        ...(isLangfuseEnabled() && {
          experimental_telemetry: {
            isEnabled: true,
            functionId: 'feedback-worthiness-gate',
            metadata: { userId },
          },
        }),
      });
      const worthy = result.text.trim().toUpperCase().startsWith('WORTHY');
      logger.info(`[Feedback:Gate] Decision: ${result.text.trim()} (worthy=${worthy})`);
      return worthy;
    } catch (error) {
      logger.error({ err: error }, '[Feedback:Gate] Gate call failed, suppressing feedback');
      return false;
    }
  }

  async chat(input: ChatInput): Promise<ChatResponse> {
    const startTime = Date.now();
    const { agentId, userId, message, metadata } = input;

    // Get or create thread
    let threadId = input.threadId;
    if (!threadId) {
      const thread = await conversationService.getOrCreateActiveThread(agentId, userId);
      threadId = thread.id;
    }

    // Store user message with sender info. The message text arrives
    // already prefixed with the sender's mention marker when the caller
    // (e.g. the Slack adapter) wants the agent to see it in conversation
    // history — see `slackAdapterService.buildSenderTaggedContent`.
    const userMessage = await conversationService.addMessage(threadId, {
      content: message,
      role: 'USER',
      triggeredBy: 'USER_INPUT',
      senderExternalId: metadata?.senderSlackUserId,
      senderName: metadata?.senderName,
    });

    // Link any uploaded files (web pre-send uploads / Slack downloads) to the
    // message that carries them so the context builder can expose them.
    if (input.attachmentIds?.length) {
      await attachmentService.linkToMessage(input.attachmentIds, userMessage.id, threadId);
    }

    // Determine if this is a channel message
    const isChannelMessage = metadata?.channel === 'slack' && !!metadata?.channelId;

    // Build channel context for delivery — scopes response to the originating channel.
    // For Slack, channelId/threadTs may be undefined (DM case — routing falls back
    // to SlackMapping.dmChannelId lookup in the adapter).
    const channelContext = metadata?.channel === 'slack'
      ? {
          channel: 'slack' as const,
          channelId: metadata.channelId,
          threadTs: metadata.slackThreadTs,
          threadId,
        }
      : metadata?.channel === 'websocket'
        ? { channel: 'websocket' as const, threadId }
        : undefined;

    // Stream steps from invokeStream and publish each text-bearing step as
    // it arrives. A one-step buffer lets us tag the LAST text step with the
    // accumulated UI blocks and the feedback decision — we can't know a step
    // was last until the next step (or the stream end) arrives.
    let agentMessage: Awaited<ReturnType<typeof messageDeliveryService.publish>> | undefined;
    let pendingToolCalls: ToolCallRecord[] = [];
    let bufferedStep: InvokeStep | null = null;
    let bufferedToolCalls: ToolCallRecord[] = [];
    const responseTexts: string[] = [];
    const allBlocks: UIBlock[] = [];
    const allToolCalls: ToolCallRecord[] = [];

    for await (const step of invokeStream({
      userId,
      agentId,
      mode: 'chat',
      prompt: message,
      threadId,
      isChannelMessage,
      runtimeNotices: input.runtimeNotices,
    })) {
      allToolCalls.push(...step.toolCalls);
      if (step.blocks) allBlocks.push(...step.blocks);
      pendingToolCalls.push(...step.toolCalls);

      if (step.text) {
        responseTexts.push(step.text);

        // Flush previously-buffered step now that we know it wasn't last:
        // no blocks, no feedback gate.
        if (bufferedStep) {
          agentMessage = await messageDeliveryService.publish(
            userId,
            threadId,
            bufferedStep.text,
            'USER_INPUT',
            {
              toolCalls: bufferedToolCalls.length > 0 ? bufferedToolCalls : undefined,
              channelContext: channelContext
                ? { ...channelContext, includeFeedback: false }
                : undefined,
            }
          );
        }

        bufferedStep = step;
        bufferedToolCalls = pendingToolCalls;
        pendingToolCalls = [];
      }
    }

    // Stream is done. The buffered step (if any) is the LAST text step:
    // attach the accumulated blocks and the feedback decision here.
    if (bufferedStep) {
      const includeFeedback = await this.shouldShowFeedback(
        threadId, message, bufferedStep.text, userId, agentId,
      );
      agentMessage = await messageDeliveryService.publish(
        userId,
        threadId,
        bufferedStep.text,
        'USER_INPUT',
        {
          toolCalls: bufferedToolCalls.length > 0 ? bufferedToolCalls : undefined,
          blocks: allBlocks.length > 0 ? allBlocks : undefined,
          channelContext: channelContext ? { ...channelContext, includeFeedback } : undefined,
        }
      );
    }

    const response = responseTexts.join('\n\n');

    // Fallback: if no step had text, publish the (possibly empty) response
    // as a safety net so the caller still gets a messageId back.
    if (!agentMessage) {
      agentMessage = await messageDeliveryService.publish(
        userId,
        threadId,
        response,
        'USER_INPUT',
        {
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          blocks: allBlocks.length > 0 ? allBlocks : undefined,
          channelContext,
        }
      );
    }

    trackEvent('chat message handled', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'channel.type': metadata?.channel ?? 'api',
      'chat.duration_ms': String(Date.now() - startTime),
      'chat.tool_calls': String(allToolCalls.length),
      'chat.response_chars': String(response.length),
    });

    return {
      threadId,
      messageId: agentMessage.id,
      content: response,
      toolCalls: allToolCalls,
      blocks: allBlocks.length > 0 ? allBlocks : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}

// Export singleton instance
export const conversationEngineService = new ConversationEngineService();
