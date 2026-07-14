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
import { agentWorkspaceService } from './agent-workspace.service';
import { goalService } from './goal.service';
import { threadTitleService } from './thread-title.service';
import { attachmentService } from './attachment.service';
import { invokeStream } from '../invoke';
import { ToolCallRecord, InvokeStep, UIBlock, ChannelOrigin } from '../types';
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
  /** Aborting this signal stops the in-flight LLM generation mid-turn. */
  abortSignal?: AbortSignal;
  metadata?: {
    channel?: 'websocket' | 'slack';
    channelId?: string;
    /** Human-readable Slack channel name (no `#`), surfaced to the model. */
    channelName?: string;
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
  /** The title just assigned to the thread from this message, else null. */
  titleSet: string | null;
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
    abortSignal?: AbortSignal,
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

    return this.isResponseWorthyOfFeedback(userMessage, terminalText, userId, agentId, abortSignal);
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
    abortSignal?: AbortSignal,
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
        abortSignal,
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

    // Get or create thread, capturing its persisted workspace root so shell
    // tools run with the thread's cwd (falling back to the global root when
    // unset — see resolveWorkspace).
    let threadId = input.threadId;
    let workspaceRoot: string | undefined;
    if (!threadId) {
      const thread = await conversationService.getOrCreateLatestThread(agentId, userId);
      threadId = thread.id;
      workspaceRoot = thread.workspaceRoot ?? undefined;
    } else {
      workspaceRoot = (await conversationService.getThreadWorkspaceRoot(threadId)) ?? undefined;
    }

    // Store user message with sender info. The message text arrives
    // already prefixed with the sender's mention marker when the caller
    // (e.g. the Slack adapter) wants the agent to see it in conversation
    // history — see `slackAdapterService.buildSenderTaggedContent`.
    const { message: userMessage, titleSet } = await conversationService.addMessage(threadId, {
      content: message,
      role: 'USER',
      triggeredBy: 'USER_INPUT',
      senderExternalId: metadata?.senderSlackUserId,
      senderName: metadata?.senderName,
    });

    // First user message named the thread: announce the placeholder title and
    // kick off the cheap-model upgrade (fire-and-forget, never blocks the
    // turn). Channel-agnostic — transports subscribe to threadTitleService.
    //
    // Gated to non-Slack turns: Slack messages live in SLACK threads, which the
    // web Recents and CLI resume picker (both `threadSource: DATABASE`) never
    // show — so a generated title for them would cost a Haiku call + DB write
    // nobody ever sees.
    if (titleSet && metadata?.channel !== 'slack') {
      threadTitleService.onFirstUserMessage(agentId, userId, threadId, message, titleSet);
    }

    // Link any uploaded files (web pre-send uploads / Slack downloads) to the
    // message that carries them so the context builder can expose them.
    if (input.attachmentIds?.length) {
      await attachmentService.linkToMessage(input.attachmentIds, userMessage.id, threadId);
    }

    // A Slack channel turn carries its channel's display name so the system
    // prompt can name it; the two travel together as a discriminated union
    // (channelName is guaranteed present wherever isChannelMessage is true).
    // Fall back to the channel id when no name is stored on the mapping.
    const slackChannelId = metadata?.channel === 'slack' ? metadata.channelId : undefined;
    const channelOrigin: ChannelOrigin = slackChannelId
      ? { isChannelMessage: true, channelName: metadata?.channelName ?? slackChannelId }
      : { isChannelMessage: false };

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

    // Concise vs. streaming delivery. When `verbose` is false (the default)
    // only the final result of the turn is published — intermediate text is
    // neither delivered nor persisted; when true, each text-bearing step is
    // published the moment it arrives. The snapshot is read INSIDE the
    // per-thread lock (at execution point, not enqueue point) and passed into
    // invokeStream, so the system-prompt instruction and the delivery gating
    // can never disagree — even if the user toggles the setting while this
    // turn is queued behind another.
    let verbose = false;

    // Stream steps from invokeStream. A one-step buffer lets us tag the LAST
    // text step with the accumulated UI blocks and the feedback decision —
    // we can't know a step was last until the next step (or the stream end)
    // arrives.
    let agentMessage: Awaited<ReturnType<typeof messageDeliveryService.publish>> | undefined;
    let pendingToolCalls: ToolCallRecord[] = [];
    let bufferedStep: InvokeStep | null = null;
    let bufferedToolCalls: ToolCallRecord[] = [];
    // A synthetic error step yielded by invokeStream's failure path (tagged
    // via `step.error`). Held OUT of the ordinary buffer so a late failure
    // can't replace the useful output completed in earlier steps — it is
    // appended to the final publish instead.
    let terminalErrorStep: InvokeStep | null = null;
    const responseTexts: string[] = [];
    const allBlocks: UIBlock[] = [];
    const allToolCalls: ToolCallRecord[] = [];
    // Files the agent shared (share_file) accrue across steps and ride out on
    // the final delivered message, so they appear alongside the answer.
    const allAttachmentIds: string[] = [];

    let response = '';

    // Run the whole turn under the per-thread lock so an interactive user turn
    // and a background goal turn never invoke() the same thread concurrently.
    // A `create_goal` call made during this turn kicks its loop fire-and-forget;
    // that loop's first turn queues behind this lock and runs once we release.
    await goalService.runExclusive(threadId, async () => {
      ({ verbose } = await agentWorkspaceService.getAgent());

      for await (const step of invokeStream({
        userId,
        agentId,
        mode: 'chat',
        prompt: message,
        threadId,
        workspaceRoot,
        verbose,
        ...channelOrigin,
        originChannel: metadata?.channel,
        originChannelId: metadata?.channelId,
        runtimeNotices: input.runtimeNotices,
        abortSignal: input.abortSignal,
      })) {
        allToolCalls.push(...step.toolCalls);
        if (step.blocks) allBlocks.push(...step.blocks);
        if (step.attachmentIds) allAttachmentIds.push(...step.attachmentIds);
        pendingToolCalls.push(...step.toolCalls);

        // Error steps are terminal (invokeStream closes the stream right
        // after) and never rotate into the buffer — otherwise a late failure
        // would erase the completed findings held there and, in concise mode,
        // the turn would deliver ONLY the generic error text.
        if (step.error) {
          terminalErrorStep = step;
          continue;
        }

        if (step.text) {
          responseTexts.push(step.text);

          // Verbose: flush the previously-buffered step now that we know it
          // wasn't last — no blocks, no feedback gate. Concise: keep
          // buffering; the dropped steps' tool calls survive on the final
          // message via `allToolCalls`.
          if (verbose && bufferedStep) {
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

      // Stream is done. The buffered step (if any) is the LAST useful text
      // step: attach the accumulated blocks and the feedback decision here.
      // In concise mode this is the turn's ONLY publish, so fold every step's
      // tool calls into it (including trailing tool-only steps) — the
      // tool-call trail survives even though intermediate text doesn't.
      // A terminal error is APPENDED to the useful output rather than
      // replacing it; error-only turns publish just the error text.
      const finalText = bufferedStep && terminalErrorStep
        ? `${bufferedStep.text}\n\n${terminalErrorStep.text}`
        : (bufferedStep?.text ?? terminalErrorStep?.text ?? '');

      if (bufferedStep || terminalErrorStep) {
        const finalToolCalls = verbose ? bufferedToolCalls : allToolCalls;
        // Rating an error turn is noise — skip the feedback gate outright.
        const includeFeedback = terminalErrorStep
          ? false
          : await this.shouldShowFeedback(
              threadId, message, finalText, userId, agentId, input.abortSignal,
            );
        agentMessage = await messageDeliveryService.publish(
          userId,
          threadId,
          finalText,
          'USER_INPUT',
          {
            toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
            blocks: allBlocks.length > 0 ? allBlocks : undefined,
            attachmentIds: allAttachmentIds.length > 0 ? allAttachmentIds : undefined,
            channelContext: channelContext ? { ...channelContext, includeFeedback } : undefined,
          }
        );
      }

      // `response` (the returned `content` + `chat.response_chars` telemetry)
      // must mirror what was actually delivered: verbose published every text
      // step, so join them (plus any appended error); concise published only
      // the combined final message — otherwise the suppressed intermediate
      // narration would leak via the return value / telemetry / POST /agents/chat.
      response = verbose
        ? [...responseTexts, ...(terminalErrorStep ? [terminalErrorStep.text] : [])].join('\n\n')
        : finalText;

      // Fallback: the stream produced no text step. Publish only if there's still
      // something to show (tool calls or UI blocks) — e.g. a tool-only turn. When
      // a turn is canceled before producing anything, skip it rather than render
      // an empty agent bubble. (In this branch `response` is always '' because any
      // text step would have set `agentMessage` via the buffered-step publish.)
      if (!agentMessage && (allToolCalls.length > 0 || allBlocks.length > 0)) {
        agentMessage = await messageDeliveryService.publish(
          userId,
          threadId,
          response,
          'USER_INPUT',
          {
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            blocks: allBlocks.length > 0 ? allBlocks : undefined,
            attachmentIds: allAttachmentIds.length > 0 ? allAttachmentIds : undefined,
            channelContext,
          }
        );
      }
    });

    trackEvent('chat message handled', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'channel.type': metadata?.channel ?? 'api',
      'chat.duration_ms': String(Date.now() - startTime),
      'chat.tool_calls': String(allToolCalls.length),
      'chat.response_chars': String(response.length),
      'chat.verbose': String(verbose),
    });

    return {
      threadId,
      // Empty when the turn was canceled before producing anything (no message
      // was published). The WS gateway ignores this; the HTTP caller on the
      // cancel path has already disconnected.
      messageId: agentMessage?.id ?? '',
      content: response,
      toolCalls: allToolCalls,
      blocks: allBlocks.length > 0 ? allBlocks : undefined,
      durationMs: Date.now() - startTime,
      titleSet,
    };
  }
}

// Export singleton instance
export const conversationEngineService = new ConversationEngineService();
