/**
 * Conversation Engine Service
 *
 * Handles chat conversations with the personal agent.
 * Invokes the LLM directly (no queue, no HTTP hop) and delivers
 * responses via the local MessageDeliveryService.
 */

import { callModel } from '../lib/model-call';
import { messageDeliveryService, PublishOptions } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { threadTurnService, type PendingMessage } from './thread-turn.service';
import { threadTitleService } from './thread-title.service';
import { conversationThreadActivityService } from './conversation-thread-activity.service';
import { attachmentService } from './attachment.service';
import { invokeStream } from '../invoke';
import { ToolCallRecord, InvokeStep, UIBlock, ChannelOrigin } from '../types';
import type { SteeringMessage } from '../prompts/context-builder';
import type { ToolLifecycleListener } from '../lib/tool-lifecycle';
import { logger } from '../logger';
import prisma from '../lib/prisma';
import type { ConversationMessage } from '@prisma/client';
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
  /**
   * The message is already stored, by `acceptUserMessage`, and this call only
   * runs or steers the turn for it. A transport that must confirm a message the
   * moment it is safe — before any turn, and whatever happens to the turn — stores
   * first and hands the row over here.
   */
  stored?: { titleSet: string | null };
  metadata?: {
    channel?: 'websocket' | 'slack' | 'teams';
    channelId?: string;
    /** Human-readable channel name (Slack: no `#`), surfaced to the model. */
    channelName?: string;
    slackThreadTs?: string;
    /** Teams thread-root activity id — becomes the delivery `threadTs`. */
    teamsThreadId?: string;
    /** The sender's id in the originating channel (Slack: `U…`, Teams: AAD object id), stored as-is. */
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
   * How to stop each exchange running on a thread, whoever started it. A person
   * can stop the agent from any client, and a turn the runtime began itself — the
   * continuation after a computer help request — is theirs to stop too.
   */
  private readonly cancellers = new Map<string, Set<AbortController>>();

  /**
   * Stop every exchange on a thread. Answers whether there was one to stop.
   *
   * A turn cancelled this way does not start another for messages still waiting
   * on it; those stay in history, as after any cancel.
   */
  cancel(threadId: string): boolean {
    const running = this.cancellers.get(threadId);
    if (!running?.size) return false;
    for (const controller of running) controller.abort();
    return true;
  }

  private registerCanceller(threadId: string, controller: AbortController): () => void {
    let set = this.cancellers.get(threadId);
    if (!set) {
      set = new Set();
      this.cancellers.set(threadId, set);
    }
    set.add(controller);
    return () => {
      set.delete(controller);
      if (set.size === 0 && this.cancellers.get(threadId) === set) this.cancellers.delete(threadId);
    };
  }

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

    return this.isResponseWorthyOfFeedback(
      threadId,
      userMessage,
      terminalText,
      userId,
      agentId,
      abortSignal,
    );
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
    threadId: string,
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
      const result = await callModel({ purpose: 'feedback-gate', threadId }, {
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
        titleSet: input.stored?.titleSet ?? null,
        steered: false,
      };
    }

    // Store the message now rather than after taking the mutex, so its row keeps
    // its arrival order relative to messages handed to other turns. On the owning
    // path the await lands inside `claim.run()`, where a failed write releases the
    // thread instead of leaving it taken forever — hence the no-op catch: the
    // mutex wait in between can be long, and an unobserved rejection would be an
    // unhandled rejection. A message the caller already stored is not written again.
    const stored: Promise<{ titleSet: string | null }> = input.stored
      ? Promise.resolve(input.stored)
      : this.acceptUserMessage(input, threadId);
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

    // A Slack/Teams channel turn carries its channel's display name so the
    // system prompt can name it; the two travel together as a discriminated
    // union (channelName is guaranteed present wherever isChannelMessage is
    // true). Fall back to the channel id when no name is stored on the mapping.
    const platformChannelId =
      metadata?.channel === 'slack' || metadata?.channel === 'teams'
        ? metadata.channelId
        : undefined;
    const channelOrigin: ChannelOrigin = platformChannelId
      ? {
          isChannelMessage: true,
          channelName: metadata?.channelName ?? platformChannelId,
          channelPlatform: metadata?.channel === 'teams' ? 'teams' : 'slack',
        }
      : { isChannelMessage: false };

    // Build channel context for delivery — scopes response to the originating channel.
    // For Slack/Teams, channelId/threadTs may be undefined (DM case — routing
    // falls back to the adapter's own mapping lookup: SlackMapping.dmChannelId
    // or TeamsMapping.dmConversationId).
    const channelContext = metadata?.channel === 'slack'
      ? {
          channel: 'slack' as const,
          channelId: metadata.channelId,
          threadTs: metadata.slackThreadTs,
          threadId,
        }
      : metadata?.channel === 'teams'
        ? {
            channel: 'teams' as const,
            channelId: metadata.channelId,
            threadTs: metadata.teamsThreadId,
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
    //
    // The thread is working from here, and a turn that waits for the mutex is part of
    // that work. invokeStream marks the thread too, which covers turns that do not
    // come through the engine.
    const endActivity = conversationThreadActivityService.beginThread(threadId, userId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.abortSignal?.aborted) controller.abort();
    else input.abortSignal?.addEventListener('abort', abort, { once: true });
    const unregister = this.registerCanceller(threadId, controller);
    const abortSignal = controller.signal;
    try {
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
            abortSignal,
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
          if (abortSignal.aborted) break;

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
    } finally {
      unregister();
      input.abortSignal?.removeEventListener('abort', abort);
      endActivity();
    }

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
   * Store an incoming user message and do the per-message side work that belongs
   * to it whether or not it gets a turn of its own: naming a new thread, linking
   * any uploaded files, and showing it on every client of a channel that shows
   * the whole conversation.
   *
   * The one place a user message is written. The chat socket calls it directly,
   * before any turn, so it can confirm the message the moment it is stored; every
   * other caller reaches it through `chat()`. `id`, when given, becomes the row's
   * id — see `MessageInput.id`.
   */
  async acceptUserMessage(
    input: Pick<ChatInput, 'agentId' | 'userId' | 'message' | 'attachmentIds' | 'metadata'>,
    threadId: string,
    id?: string,
  ): Promise<{ message: ConversationMessage; titleSet: string | null }> {
    const { agentId, userId, message, metadata } = input;

    // The message text arrives already prefixed with the sender's mention
    // marker when the caller (e.g. the Slack adapter) wants the agent to see it
    // in conversation history — see `slackAdapterService.buildSenderTaggedContent`.
    const { message: userMessage, titleSet } = await conversationService.addMessage(threadId, {
      ...(id ? { id } : {}),
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
    // Gated to web/CLI turns: Slack and Teams messages live in threads keyed by
    // an externalThreadId, which the web Recents and CLI resume picker never
    // show — so a generated title for them would cost a Haiku call + DB write
    // nobody ever sees.
    if (titleSet && metadata?.channel !== 'slack' && metadata?.channel !== 'teams') {
      threadTitleService.onFirstUserMessage(agentId, userId, threadId, message, titleSet);
    }

    // Link any uploaded files (web pre-send uploads / Slack downloads) to the
    // message that carries them so the context builder can expose them.
    if (input.attachmentIds?.length) {
      await attachmentService.linkToMessage(input.attachmentIds, userMessage.id, threadId);
    }

    // Every client of the chat socket shows the whole conversation, so the
    // person's own words reach the other devices — and the sender, which reads
    // the copy as the confirmation that it was stored. Slack shows a message
    // itself.
    if (metadata?.channel === 'websocket') {
      await messageDeliveryService.showInConversation(userId, userMessage);
    }

    return { message: userMessage, titleSet };
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
    let pendingToolCalls: ToolCallRecord[] = [];
    let bufferedStep: InvokeStep | null = null;
    let bufferedToolCalls: ToolCallRecord[] = [];
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
      pendingToolCalls.push(...step.toolCalls);

      if (step.text) {
        responseTexts.push(step.text);

        // Flush previously-buffered step now that we know it wasn't last:
        // no blocks, no feedback gate.
        if (bufferedStep) {
          if (params.verbose) {
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
          } else {
            // Concise mode: persist without delivering to the channel. Marked
            // internalStep so client history hides it, while the model-context
            // read still replays it (tool rounds must survive for the model).
            const { message: persisted } = await conversationService.addMessage(threadId, {
              content: bufferedStep.text,
              role: 'AGENT',
              triggeredBy: 'USER_INPUT',
              toolCalls: bufferedToolCalls.length > 0 ? bufferedToolCalls : undefined,
              internalStep: true,
            });
            agentMessage = persisted;
          }
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
        threadId, prompt, bufferedStep.text, userId, agentId, params.abortSignal,
      );
      agentMessage = await messageDeliveryService.publish(
        userId,
        threadId,
        bufferedStep.text,
        'USER_INPUT',
        {
          toolCalls: bufferedToolCalls.length > 0 ? bufferedToolCalls : undefined,
          blocks: allBlocks.length > 0 ? allBlocks : undefined,
          attachmentIds: allAttachmentIds.length > 0 ? allAttachmentIds : undefined,
          channelContext: channelContext ? { ...channelContext, includeFeedback } : undefined,
        }
      );
    }

    const response = responseTexts.join('\n\n');

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

    return { text: response, toolCalls: allToolCalls, blocks: allBlocks, agentMessage };
  }
}

// Export singleton instance
export const conversationEngineService = new ConversationEngineService();
