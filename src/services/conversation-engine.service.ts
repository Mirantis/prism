/**
 * Conversation Engine Service
 *
 * Handles chat conversations with the personal agent.
 * Invokes the LLM directly (no queue, no HTTP hop) and delivers
 * responses via the local MessageDeliveryService.
 */

import { generateText } from 'ai';
import { messageDeliveryService, PublishOptions } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { threadTurnService, type PendingMessage } from './thread-turn.service';
import { threadTitleService } from './thread-title.service';
import { attachmentService } from './attachment.service';
import { invokeStream } from '../invoke';
import { ToolCallRecord, InvokeStep, UIBlock, ChannelOrigin } from '../types';
import type { SteeringMessage } from '../prompts/context-builder';
import type { ToolLifecycleListener } from '../lib/tool-lifecycle';
import { logger } from '../logger';
import prisma from '../lib/prisma';
import { getGateRequest } from '../lib/classification';

import { isTelemetryEnabled, trackEvent, langfuseTelemetry } from '../lib/telemetry';
import { agentWorkspaceService } from './agent-workspace.service';

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
// Turn steering
// ============================================================================

/** Aggregate of one `invokeStream` pass, published as it streamed. */
interface StreamedTurn {
  text: string;
  toolCalls: ToolCallRecord[];
  blocks: UIBlock[];
  agentMessage: Awaited<ReturnType<typeof messageDeliveryService.publish>> | undefined;
}

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
  onToolEvent?: ToolLifecycleListener;
  /**
   * Only hand this message to a turn already running on its thread; never start
   * one. When no turn is live, nothing is stored and nothing is invoked, and the
   * response comes back with `steered: false` — for transports that keep their
   * own queue (the WS gateway) and want to fall back to it.
   */
  steerOnly?: boolean;
  metadata?: {
    channel?: 'websocket' | 'slack';
    channelId?: string;
    /** Human-readable Slack channel name (no `#`), surfaced to the model. */
    channelName?: string;
    slackThreadTs?: string;
    /** The sender's id in the originating channel (Slack: `U…`), stored as-is. */
    senderExternalId?: string;
    senderName?: string;
  };
}

export interface ChatResponse {
  threadId: string;
  /**
   * Id of the agent message this call published, when it published one. Absent
   * when there is nothing to point at: the turn was canceled before producing
   * output, or this message was handed to a turn already running (`steered`) and
   * that turn publishes the reply under its own call.
   */
  messageId?: string;
  content: string;
  toolCalls: ToolCallRecord[];
  blocks?: unknown[];
  durationMs: number;
  /** The title just assigned to the thread from this message, else null. */
  titleSet: string | null;
  /**
   * True when this message was handed to a turn already running on the thread
   * rather than answered by a turn of its own — no LLM call was made here, and
   * the reply streams out of that other turn (see `threadTurnService`).
   */
  steered?: boolean;
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
   * thumbs-up/down carries useful signal? Routes through the gateway (same as
   * the main `invoke()` path) using the agent's platform token. Returns `false`
   * (fail-closed) on any classifier error or when no platform token is available
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
      const { model, providerOptions, samplingParams } = getGateRequest();
      const result = await generateText({
        model,
        providerOptions,
        system: systemPrompt,
        messages: [
          {
            role: 'user' as const,
            content: `## User message\n${userMessage}\n\n## Agent reply\n${agentResponse}`,
          },
        ],
        // 16 is the OpenAI Responses API minimum (a cap — the verdict is one word).
        maxOutputTokens: 16,
        ...samplingParams,
        abortSignal,
        ...langfuseTelemetry('feedback-worthiness-gate', { userId }),
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

    // A turn may already own this thread — the user sent this while the agent was
    // working. Hand it over instead of starting a second turn: that turn picks
    // the message up at its next step boundary, so the user can redirect work in
    // flight. Queuing a turn of its own would instead leave the history ending on
    // the running turn's replies, which the provider rejects as assistant prefill
    // (see thread-turn.service.ts).
    //
    // Otherwise this call takes the thread, and does so here — synchronously,
    // before it stores anything or waits for the mutex. Hand-over and claim are
    // one act, so a message arriving during our own setup finds the thread taken
    // and is handed to us instead of starting a turn that would race us. Files
    // travel as ids: whoever takes the message loads their bytes on its own side.
    //
    // Transports with their own queue (the WS gateway) ask steer-only: hand over
    // to a turn that owns the thread, but never take the thread themselves. When
    // nothing owns it, nothing is stored and nothing is invoked, so they queue the
    // message exactly as before.
    // Held as one object so a failed store can name it again and withdraw it.
    const pending: PendingMessage = { text: message, attachmentIds: input.attachmentIds ?? [] };
    const claim = input.steerOnly ? null : threadTurnService.claimOrOffer(threadId, pending);

    if (input.steerOnly && !threadTurnService.offer(threadId, pending)) {
      return {
        threadId,
        content: '',
        toolCalls: [],
        durationMs: Date.now() - startTime,
        titleSet: null,
        steered: false,
      };
    }

    // Store the message now rather than after taking the mutex, so its row keeps
    // its arrival order relative to messages handed to other turns. On the owning
    // path the await lands inside `claim.run()`, where a failed write releases the
    // thread instead of leaving it taken forever — hence the no-op catch: the
    // mutex wait in between can be long, and an unobserved rejection would be an
    // unhandled rejection.
    const stored = this.storeUserMessage(input, threadId);
    stored.catch(() => {});

    if (!claim) {
      let titleSet: string | null;
      try {
        ({ titleSet } = await stored);
      } catch (error) {
        // The message is already in the owning turn's inbox — it had to go there
        // in the same act as the decision. Now the write has failed, so take it
        // back: left there, the turn would answer text that never became
        // history, and the next turn would read a reply to nothing.
        if (!threadTurnService.withdraw(threadId, pending)) {
          logger.error(
            'Thread %s: storing a handed-over message failed after the running turn took it; its reply will have no user message in history',
            threadId,
          );
        }
        throw error;
      }
      logger.info(
        'Handed the message to the turn that owns thread %s (%d message(s) pending) instead of starting a new one',
        threadId,
        threadTurnService.pendingCount(threadId),
      );
      return {
        threadId,
        content: '',
        toolCalls: [],
        durationMs: Date.now() - startTime,
        titleSet,
        steered: true,
      };
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

    const responseTexts: string[] = [];
    const allBlocks: UIBlock[] = [];
    const allToolCalls: ToolCallRecord[] = [];
    let agentMessage: StreamedTurn['agentMessage'];
    let verbose = false;
    let titleSet: string | null = null;

    // Hold the thread for the whole exchange — the first turn and any coalesced
    // follow-ups — so a background goal turn can't interleave between them.
    // A `create_goal` call made during this turn kicks its loop fire-and-forget;
    // that loop's first turn queues behind this and runs once we release.
    await claim.run(async () => {
      titleSet = (await stored).titleSet;

      // Snapshot the verbose flag once inside the lock and thread it through the
      // whole exchange (InvokeRequest → context → delivery gating in streamTurn),
      // so prompt construction and delivery never diverge if it is toggled
      // mid-turn — including across any coalesced follow-up.
      const agent = await agentWorkspaceService.getAgent();
      verbose = agent.verbose;

      let prompt = message;
      let appendPrompt = false;
      // Notices describe events from preparing *this* message (e.g. an
      // attachment that failed to download), so they belong to the first turn
      // only — repeating them in a follow-up would re-report stale events.
      let runtimeNotices = input.runtimeNotices;

      for (;;) {
        const streamed = await this.streamTurn({
          userId,
          agentId,
          threadId,
          workspaceRoot,
          prompt,
          appendPrompt,
          verbose,
          channelOrigin,
          channelContext,
          metadata,
          runtimeNotices,
          abortSignal: input.abortSignal,
          onToolEvent: input.onToolEvent,
          // Drained at every step boundary, so a message handed to us — even one
          // that arrived while we were still storing or waiting for the mutex —
          // reaches the model on the next step.
          steering: () => this.loadSteering(claim.drain()),
        });

        if (streamed.text) responseTexts.push(streamed.text);
        allToolCalls.push(...streamed.toolCalls);
        allBlocks.push(...streamed.blocks);
        if (streamed.agentMessage) agentMessage = streamed.agentMessage;

        // A canceled turn must not auto-start another one — the user asked to
        // stop. Anything still pending is cleared when the claim releases, and
        // stays in history for the next turn (see thread-turn.service.ts).
        if (input.abortSignal?.aborted) break;

        // Messages that landed after the last step boundary never reached the
        // model. Answer them in ONE coalesced follow-up rather than a turn each,
        // restating them as the trailing user message (see `appendPrompt`).
        //
        // An empty inbox ends the exchange and releases the thread in the same
        // synchronous act, so no message can be handed to a claim that is about
        // to end — the next one starts a turn of its own.
        const leftover = claim.drainOrRelease();
        if (leftover.length === 0) break;

        // Text only: any files these carried are already linked to their stored
        // message rows, so the follow-up's context build picks them up.
        prompt = leftover.map((p) => p.text).join('\n\n');
        appendPrompt = true;
        runtimeNotices = undefined;
      }
    });

    const response = responseTexts.join('\n\n');

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
      // Absent when the turn was canceled before producing anything, so no
      // message was published. The WS gateway ignores this; the HTTP caller on
      // the cancel path has already disconnected.
      messageId: agentMessage?.id,
      content: response,
      toolCalls: allToolCalls,
      blocks: allBlocks.length > 0 ? allBlocks : undefined,
      durationMs: Date.now() - startTime,
      titleSet,
    };
  }

  /**
   * Store the incoming user message and do the per-message side work that
   * belongs to it regardless of whether it gets a turn of its own: naming a new
   * thread and linking any uploaded files.
   */
  private async storeUserMessage(
    input: ChatInput,
    threadId: string,
  ): Promise<{ titleSet: string | null }> {
    const { agentId, userId, message, metadata } = input;

    // The message text arrives already prefixed with the sender's mention
    // marker when the caller (e.g. the Slack adapter) wants the agent to see it
    // in conversation history — see `slackAdapterService.buildSenderTaggedContent`.
    const { message: userMessage, titleSet } = await conversationService.addMessage(threadId, {
      content: message,
      role: 'USER',
      triggeredBy: 'USER_INPUT',
      senderExternalId: metadata?.senderExternalId,
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

    return { titleSet };
  }

  /**
   * Load attachment metadata for messages handed to a running turn, so the
   * turn can fold them in as full user turns — a screenshot shared mid-work
   * reaches the model as a stub on the next step, exactly as it would had it
   * been sent at the turn's start.
   *
   * Runs on the consumer side because `offer()` is synchronous: the ids are
   * queued without an await, and only whoever takes them pays for the read.
   */
  private async loadSteering(pending: PendingMessage[]): Promise<SteeringMessage[]> {
    return Promise.all(
      pending.map(async (p) => ({
        text: p.text,
        attachments: p.attachmentIds.length
          ? await attachmentService.getMetaByIds(p.attachmentIds)
          : undefined,
      })),
    );
  }

  /**
   * Drive one model invocation to completion, publishing each text-bearing step
   * as it arrives, and return what the whole invocation produced.
   *
   * "One invocation" is the unit, not the whole exchange: `invokeStream` runs the
   * model until it stops (up to `STEP_LIMIT` steps, plus the early-stopping
   * summary), and this drains that stream to its end. An exchange calls this
   * again for each coalesced follow-up.
   *
   * A one-step buffer lets us tag the LAST text step with the accumulated UI
   * blocks and the feedback decision — we can't know a step was last until the
   * next step (or the stream end) arrives.
   */
  private async streamTurn(params: {
    userId: string;
    agentId: string;
    threadId: string;
    workspaceRoot?: string;
    /** The user text this turn answers; also the feedback gate's input. */
    prompt: string;
    /** Restate `prompt` as the trailing user message (coalesced follow-up). */
    appendPrompt: boolean;
    /** Snapshot taken once inside the lock; gates intermediate delivery. */
    verbose: boolean;
    channelOrigin: ChannelOrigin;
    channelContext: PublishOptions['channelContext'];
    metadata: ChatInput['metadata'];
    runtimeNotices?: string[];
    abortSignal?: AbortSignal;
    onToolEvent?: ToolLifecycleListener;
    steering: () => Promise<SteeringMessage[]>;
  }): Promise<StreamedTurn> {
    const { userId, agentId, threadId, prompt, channelContext, metadata } = params;

    let agentMessage: StreamedTurn['agentMessage'];
    // Calls made by steps that stored no delivered row yet. They ride out on the
    // next delivered row so the client's tool chips still cover the whole turn,
    // while each step's own row carries its own calls for the model.
    let pendingToolCalls: ToolCallRecord[] = [];
    let bufferedStep: InvokeStep | null = null;
    // Whether anything has reached the reader yet. A turn that only called tools
    // still shows the reader what it did, so the final row is delivered when
    // nothing before it was.
    let delivered = false;
    const responseTexts: string[] = [];
    const allBlocks: UIBlock[] = [];
    const allToolCalls: ToolCallRecord[] = [];
    // Files the agent shared (share_file) accrue across steps and ride out on
    // the final delivered message, so they appear alongside the answer.
    const allAttachmentIds: string[] = [];

    for await (const step of invokeStream({
      userId,
      agentId,
      mode: 'chat',
      prompt,
      appendPrompt: params.appendPrompt,
      threadId,
      workspaceRoot: params.workspaceRoot,
      verbose: params.verbose,
      ...params.channelOrigin,
      originChannel: metadata?.channel,
      originChannelId: metadata?.channelId,
      runtimeNotices: params.runtimeNotices,
      abortSignal: params.abortSignal,
      onToolEvent: params.onToolEvent,
      steering: params.steering,
    })) {
      allToolCalls.push(...step.toolCalls);
      if (step.blocks) allBlocks.push(...step.blocks);
      if (step.attachmentIds) allAttachmentIds.push(...step.attachmentIds);

      if (step.text) responseTexts.push(step.text);

      // One row per step, written in step order, because one row holds one
      // assistant turn: a tool loop is N assistant/tool pairs to the provider,
      // and folding them into a single row replays a history where the agent
      // answered first and called every tool afterwards.
      //
      // The buffer is one step deep: a step is written once the next one
      // arrives, so the last step — the one that carries the turn's blocks and
      // the feedback decision — is known by then.
      if (bufferedStep) {
        const written = await this.persistStep(bufferedStep, {
          userId,
          threadId,
          verbose: params.verbose,
          channelContext,
          pendingToolCalls,
        });
        if (written?.delivered) {
          agentMessage = written.message;
          delivered = true;
          pendingToolCalls = [];
        } else {
          if (written) agentMessage = written.message;
          pendingToolCalls.push(...bufferedStep.toolCalls);
        }
      }

      bufferedStep = step;
    }

    // Stream is done. The last step carries the turn's blocks, its shared files
    // and the feedback decision — it is the answer in every turn that produced
    // one, and `persistStep` delivers it as long as there is anything to show.
    if (bufferedStep) {
      const written = await this.persistStep(bufferedStep, {
        userId,
        threadId,
        verbose: params.verbose,
        channelContext,
        pendingToolCalls,
        final: {
          delivered,
          blocks: allBlocks,
          attachmentIds: allAttachmentIds,
          prompt,
          agentId,
          abortSignal: params.abortSignal,
        },
      });
      if (written) agentMessage = written.message;
    }

    const response = responseTexts.join('\n\n');

    return { text: response, toolCalls: allToolCalls, blocks: allBlocks, agentMessage };
  }

  /**
   * Write one step's row, and deliver it when there is something for the reader.
   *
   * A row holds two records with different readers, which is why the tool-call
   * list differs between them:
   *
   * - **The model** reads `assistantParts` — this step's assistant turn as the
   *   provider produced it — and takes each call's result from `toolCalls` by id.
   *   That is why a step needs its own row: one row is one assistant turn.
   * - **The client** draws chips from `toolCalls`, and only sees delivered rows.
   *   A delivered row therefore carries the calls of the hidden steps before it
   *   too. The model ignores those: their ids are in another row's parts.
   *
   * Returns null when the step left nothing worth a row.
   */
  private async persistStep(
    step: InvokeStep,
    ctx: {
      userId: string;
      threadId: string;
      verbose: boolean;
      channelContext: PublishOptions['channelContext'];
      pendingToolCalls: ToolCallRecord[];
      final?: {
        /** Whether an earlier step already delivered something to the reader. */
        delivered: boolean;
        blocks: UIBlock[];
        attachmentIds: string[];
        prompt: string;
        agentId: string;
        abortSignal?: AbortSignal;
      };
    }
  ): Promise<{ message: StreamedTurn['agentMessage']; delivered: boolean } | null> {
    const blocks = ctx.final?.blocks ?? [];
    const attachmentIds = ctx.final?.attachmentIds ?? [];
    const hasParts = Boolean(step.assistantParts?.length);

    if (!step.text && step.toolCalls.length === 0 && !hasParts && attachmentIds.length === 0) {
      return null;
    }

    // Text is what a reader came for. A file the agent shared and a block it
    // built are delivered too, whatever else this turn already said: only
    // `publish` links an attachment to a message, and a file left unlinked is
    // one the janitor sweeps as an orphan. Tool chips are the weakest claim —
    // they are worth an otherwise empty bubble only when the turn said nothing
    // else at all.
    const deliver = Boolean(
      step.text ||
        (ctx.final && (attachmentIds.length > 0 || blocks.length > 0)) ||
        (ctx.final &&
          !ctx.final.delivered &&
          ctx.pendingToolCalls.length + step.toolCalls.length > 0)
    );

    if (!deliver || (!ctx.verbose && !ctx.final)) {
      // Hidden from client history, replayed for the model. In concise mode that
      // covers every intermediate step; in both modes it covers a step that only
      // called tools.
      const { message } = await conversationService.addMessage(ctx.threadId, {
        content: step.text,
        role: 'AGENT',
        triggeredBy: 'USER_INPUT',
        toolCalls: step.toolCalls.length > 0 ? step.toolCalls : undefined,
        assistantParts: step.assistantParts,
        internalStep: true,
      });
      return { message, delivered: false };
    }

    const clientToolCalls = [...ctx.pendingToolCalls, ...step.toolCalls];
    const includeFeedback = ctx.final
      ? await this.shouldShowFeedback(
          ctx.threadId,
          ctx.final.prompt,
          step.text,
          ctx.userId,
          ctx.final.agentId,
          ctx.final.abortSignal
        )
      : false;

    const message = await messageDeliveryService.publish(
      ctx.userId,
      ctx.threadId,
      step.text,
      'USER_INPUT',
      {
        toolCalls: clientToolCalls.length > 0 ? clientToolCalls : undefined,
        assistantParts: step.assistantParts,
        ...(ctx.final && blocks.length > 0 ? { blocks } : {}),
        ...(ctx.final && attachmentIds.length > 0 ? { attachmentIds } : {}),
        channelContext: ctx.channelContext
          ? { ...ctx.channelContext, includeFeedback }
          : undefined,
      }
    );
    return { message, delivered: true };
  }
}

// Export singleton instance
export const conversationEngineService = new ConversationEngineService();
