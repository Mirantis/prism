/**
 * Conversation Engine Service
 *
 * Handles chat conversations with the personal agent.
 * Invokes the LLM directly (no queue, no HTTP hop) and delivers
 * responses via the local MessageDeliveryService.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { callModel } from '../lib/model-call';
import { messageDeliveryService, PublishOptions } from './message-delivery.service';
import type { ChannelName } from './channel-adapter.interface';
import { conversationService } from './conversation.service';
import { threadTurnService, type PendingMessage } from './thread-turn.service';
import { threadTitleService } from './thread-title.service';
import { conversationThreadActivityService } from './conversation-thread-activity.service';
import { attachmentService } from './attachment.service';
import { pendingWorkService } from './pending-work.service';
import { questionCardService } from './question-cards/question-card.service';
import { ASK_QUESTIONS_TOOL_NAME } from './question-cards/question-card-schema';
import { RESUMED_REPLY_NOTICE } from '../prompts/resume-prompt';
import { agentMessageColumns, renderAgentMessage } from '../prompts/agent-message-prompt';
import { invokeStream } from '../invoke';
import { ToolCallRecord, InvokeStep, InvokeError, ResumedReply, UIBlock, type AgentMessageOrigin } from '../types';
import type { ConversationMessage as HistoryRow, SteeringMessage } from '../prompts/context-builder';
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
  /** Set when the turn ended on an error step, whose text is the published reply. */
  error?: InvokeError;
  /** The model's stream ended on its own, not by an abort, so the reply is the whole answer. */
  completed: boolean;
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
  stored?: { id: string; titleSet: string | null };
  /** The exchange continues one a restart interrupted. `message` is the newest message it owes an answer. */
  resumed?: ResumedReply;
  /**
   * Set when another agent of the project sent the message. It is stored as that
   * agent's, and the model reads it as a colleague's request. Only the runtime's
   * own agent-message route sets it: `metadata` can come from a request body.
   */
  agentMessage?: AgentMessageOrigin;
  /**
   * The runtime wrote this message in the person's name, so it leaves a waiting
   * question card open. Only the runtime's own callers set it: `metadata` can
   * come from a request body.
   */
  runtimeWritten?: true;
  /**
   * The shared-channel label of the thread, read again before each turn of the
   * exchange, so a follow-up turn sees a person who first wrote during the turn
   * before it. Takes precedence over `metadata.channelLabel`.
   */
  channelLabelFor?: (threadId: string) => Promise<string | undefined>;
  metadata?: {
    /** The `name` of the adapter the message came through; the reply goes back there. */
    channel?: ChannelName;
    channelId?: string;
    /** The channel's own thread the message was posted in, where the reply goes. */
    channelThreadId?: string;
    /**
     * The shared channel the message was posted in, as the system prompt names
     * it. Set only for a message in a channel that several people read.
     */
    channelLabel?: string;
    /** The sender's id in the originating channel, stored as-is. */
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

/** How an exchange on a thread ended, emitted as `turnEnded` before the thread stops working. */
export interface ChatTurnEnd {
  threadId: string;
  cancelled: boolean;
  /** Set when the agent could not answer: the exchange ended on an error reply, or threw. */
  error?: InvokeError;
}

/**
 * A message owed an answer, as `pending_work` holds it: where its thread is and
 * how its reply is delivered.
 */
export interface ChatWork {
  threadId: string;
  agentId: string;
  userId: string;
  metadata?: ChatInput['metadata'];
  /**
   * The message itself until its row is stored, so the boot stores it when a
   * restart came first. `acceptUserMessage` writes it.
   */
  message?: Pick<ChatInput, 'message' | 'attachmentIds' | 'agentMessage' | 'runtimeWritten'>;
  /**
   * The tool calls the turn has made that no stored message holds yet: a step's
   * calls are stored with the next text step. A resumed exchange stores them
   * before its first turn, so that turn reads them as its own tool results.
   */
  unsaved?: ToolCallRecord[];
  /**
   * The files the turn shared that no delivered reply holds yet: they go out with
   * the turn's last reply. A resumed exchange's first reply delivers them.
   */
  unsentAttachmentIds?: string[];
}

/**
 * The attachments that chat work holds: the uploads of a message not linked yet,
 * and the files a turn shared that no reply delivered. The orphan sweep keeps them.
 */
export async function attachmentsHeldByChatWork(): Promise<string[]> {
  const rows = await pendingWorkService.rows('chat');
  return rows.flatMap(({ payload }) => {
    const work = payload as unknown as ChatWork;
    return [...(work.message?.attachmentIds ?? []), ...(work.unsentAttachmentIds ?? [])];
  });
}

/**
 * What `pending_work` holds from before a message is stored until the exchange
 * that answers it ends. The row holds the message, so a restart before the
 * insert lands stores it at boot.
 */
export function chatWorkFor(
  input: Pick<ChatInput, 'agentId' | 'userId' | 'message' | 'attachmentIds' | 'metadata' | 'agentMessage' | 'runtimeWritten'>,
  threadId: string,
): ChatWork {
  const { agentId, userId, message, metadata, attachmentIds, agentMessage, runtimeWritten } = input;
  return {
    threadId,
    agentId,
    userId,
    ...(metadata ? { metadata } : {}),
    message: {
      message,
      attachmentIds,
      ...(agentMessage ? { agentMessage } : {}),
      ...(runtimeWritten ? { runtimeWritten } : {}),
    },
  };
}

/** How much of an unsaved tool call the pending-work row keeps: the newest calls, each cut. */
const UNSAVED_MAX_CALLS = 20;
const UNSAVED_MAX_CHARS = 4_000;

function cut(text: string): string {
  return text.length <= UNSAVED_MAX_CHARS ? text : `${text.slice(0, UNSAVED_MAX_CHARS)}…`;
}

/** A message as a turn's prompt holds it: another agent's inside the tag that names that agent. */
function promptText(text: string, origin: AgentMessageOrigin | undefined): string {
  return origin ? renderAgentMessage(origin, text) : text;
}

/** A call's input with each long string in it cut, so it stays JSON and replays with its arguments. */
function cutInput(input: string): string {
  return input.length <= UNSAVED_MAX_CHARS ? input : JSON.stringify(cutStrings(JSON.parse(input)));
}

function cutStrings(value: unknown): unknown {
  if (typeof value === 'string') return cut(value);
  if (Array.isArray(value)) return value.map(cutStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, cutStrings(field)]));
  }
  return value;
}

// ============================================================================
// Conversation Engine Service
// ============================================================================

class ConversationEngineService {
  readonly events = new EventEmitter();

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
   *    Counts the person's messages (one per turn) rather than AGENT messages
   *    (one per text-producing step), so multi-step responses don't throw the
   *    cadence off. Another agent's message and a hidden row the runtime wrote
   *    for the model are not the person's. The current turn's user message has
   *    already been stored by the caller, so `userCount` is 1 on the very
   *    first turn — hence `(n - 1) % N === 0`.
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
        internalStep: false,
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
    const systemPrompt = `You decide whether to ask the user to rate an agent's reply with thumbs up or down. A rating is useful only when the user can judge the substance of the reply.

Answer WORTHY for a substantive reply: an analysis, explanation, plan, code, investigation summary or recommendation, or anything else the user can find helpful or not.

Answer SKIP when a rating would be noise: a short acknowledgement ("Done.", "On it."), a question back to the user, an error or a refusal, a trivial lookup or confirmation, or a progress update with no new conclusion.

Answer with one word: WORTHY or SKIP.`;

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
    const agentOrigin = input.agentMessage;

    // Get or create thread, capturing its persisted workspace root so shell
    // tools run with the thread's cwd (falling back to the global root when
    // unset — see resolveWorkspace).
    let threadId = input.threadId && (await conversationService.writableThreadId(input.threadId));
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
    // Held as one object so a failed store can name it again and withdraw it. The
    // id is chosen now, before the store, because a hand-over happens first.
    const messageId = input.stored?.id ?? randomUUID();
    const pending: PendingMessage = {
      id: messageId,
      text: message,
      attachmentIds: input.attachmentIds ?? [],
      ...(agentOrigin ? { agentMessage: agentOrigin } : {}),
    };
    // A reply a restart interrupted is never handed over: what its exchange stores
    // and delivers first belongs to that exchange alone, so it waits for the thread.
    const claim = input.steerOnly
      ? null
      : input.resumed
        ? await threadTurnService.claimWhenFree(threadId)
        : threadTurnService.claimOrOffer(threadId, pending);

    if (input.steerOnly && (input.resumed || !threadTurnService.offer(threadId, pending))) {
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
      : this.acceptUserMessage(input, threadId, messageId);
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

    // Build channel context for delivery — scopes response to the originating
    // channel. channelId and channelThreadId may be undefined (a direct
    // message), and the adapter then routes to the user's own conversation.
    const channelContext: PublishOptions['channelContext'] = metadata?.channel
      ? {
          channel: metadata.channel,
          channelId: metadata.channelId,
          channelThreadId: metadata.channelThreadId,
          threadId,
        }
      : undefined;

    const responseTexts: string[] = [];
    const allBlocks: UIBlock[] = [];
    const allToolCalls: ToolCallRecord[] = [];
    let agentMessage: StreamedTurn['agentMessage'];
    let turnError: InvokeError | undefined;
    let verbose = false;
    let titleSet: string | null = null;
    // Every message this exchange answers. Each is owed an answer until the
    // exchange ends, and a restart before then continues the exchange.
    const owed = input.resumed ? [...input.resumed.messageIds] : [messageId];
    // The messages a turn answered in full: its stream ended on its own, so its
    // reply goes out even when a shutdown starts during the delivery.
    const answered: string[] = [];
    let turnIds = [...owed];
    const take = (handed: PendingMessage[]) => {
      const ids = handed.map((p) => p.id);
      owed.push(...ids);
      turnIds.push(...ids);
      return handed;
    };
    // The rows this exchange's turns read as history, each with the files it held
    // then. A message handed over that is among them reached the model there, so
    // the turn answers it without injecting it again — even one offered after the
    // read, as the chat socket does with a message it stored first. A row read
    // before its files were linked to it has not: steering still sends those.
    const read = new Map<string, Set<string>>();
    const isRead = (handed: PendingMessage) => {
      const files = read.get(handed.id);
      return files !== undefined && handed.attachmentIds.every((id) => files.has(id));
    };
    const unread = (handed: PendingMessage[]) => handed.filter((p) => !isRead(p));
    const work: ChatWork = { threadId, agentId, userId, ...(metadata ? { metadata } : {}) };
    // Kept as a turn goes on the row of the first message it answers, which stays
    // until the turn's reply is out. A restart stores what the turn did before the
    // resumed turn reads its history, and delivers the files it shared.
    const recordUnsaved = (key: string) => (calls: ToolCallRecord[], attachmentIds: string[]) => {
      const unsaved = calls
        .slice(-UNSAVED_MAX_CALLS)
        .map((call) => ({ ...call, input: cutInput(call.input), output: cut(call.output) }));
      pendingWorkService.update('chat', key, {
        ...work,
        ...(unsaved.length > 0 ? { unsaved } : {}),
        ...(attachmentIds.length > 0 ? { unsentAttachmentIds: attachmentIds } : {}),
      });
    };
    let unsentAttachmentIds = input.resumed?.unsentAttachmentIds ?? [];

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
    // A cancelled exchange takes no more hand-overs, so a message sent after the
    // stop gets a turn of its own.
    controller.signal.addEventListener('abort', () => claim.close(), { once: true });
    const abort = () => controller.abort();
    // A shutdown stops the exchange too. Its messages stay owed, so the next boot
    // continues it.
    const stoppers = [input.abortSignal, pendingWorkService.shutdownSignal];
    if (stoppers.some((signal) => signal?.aborted)) controller.abort();
    else for (const signal of stoppers) signal?.addEventListener('abort', abort, { once: true });
    const unregister = this.registerCanceller(threadId, controller);
    const abortSignal = controller.signal;
    try {
      await claim.run(async () => {
        try {
          titleSet = (await stored).titleSet;

          if (input.resumed) {
            // The tool calls the interrupted turn made after its last stored step
            // become history, then leave the rows. A restart between the two
            // stores them twice, and the model reads each call twice. The files it
            // shared stay owed on the row the first turn keeps.
            if (input.resumed.unsaved.length > 0) {
              await conversationService.addMessage(threadId, {
                content: '',
                role: 'AGENT',
                triggeredBy: 'USER_INPUT',
                toolCalls: input.resumed.unsaved,
                internalStep: true,
              });
            }
            // The first row takes every owed file before the others give theirs up.
            recordUnsaved(owed[0])([], unsentAttachmentIds);
            await pendingWorkService.flush();
            for (const key of owed.slice(1)) pendingWorkService.update('chat', key, work);
            // The notice is the history's last message, stored like the recalled
            // memories: every later turn replays it, so the cached prefix holds.
            await conversationService.addMessage(threadId, {
              content: RESUMED_REPLY_NOTICE,
              role: 'USER',
              triggeredBy: 'USER_INPUT',
              internalStep: true,
            });
          }

          // Snapshot the verbose flag once inside the lock and thread it through the
          // whole exchange (InvokeRequest → context → delivery gating in streamTurn),
          // so prompt construction and delivery never diverge if it is toggled
          // mid-turn — including across any coalesced follow-up.
          const agent = await agentWorkspaceService.getAgent();
          verbose = agent.verbose;

          let prompt = promptText(message, agentOrigin);
          let appendPrompt = false;
          // Feedback is the person's to give, on a reply to something they asked.
          let fromPerson = !agentOrigin;
          let appendedMessageIds: string[] = [];
          // A resumed exchange stores rows after its message on purpose, and its
          // history ends on the resume notice.
          let promptMessageId = input.resumed ? undefined : messageId;
          // Notices describe events from preparing *this* message (e.g. an
          // attachment that failed to download), so they belong to the first turn
          // only — repeating them in a follow-up would re-report stale events.
          let runtimeNotices = input.runtimeNotices;

          for (;;) {
            const turnMetadata = input.channelLabelFor
              ? { ...metadata, channelLabel: await input.channelLabelFor(threadId) }
              : metadata;
            const streamed = await this.streamTurn({
              userId,
              agentId,
              threadId,
              workspaceRoot,
              prompt,
              appendPrompt,
              fromPerson,
              appendedMessageIds,
              promptMessageId,
              verbose,
              channelContext,
              metadata: turnMetadata,
              runtimeNotices,
              abortSignal,
              onToolEvent: input.onToolEvent,
              onUnsaved: recordUnsaved(turnIds[0]),
              unsentAttachmentIds,
              // Drained at every step boundary, so a message handed to us — even one
              // that arrived while we were still storing or waiting for the mutex —
              // reaches the model on the next step.
              steering: () => this.loadSteering(unread(take(claim.drain()))),
              // A handed-over message the history holds is answered from there.
              onHistoryRead: (rows) => {
                for (const row of rows) read.set(row.id, new Set((row.attachments ?? []).map((att) => att.id)));
                take(claim.drain(isRead));
              },
            });

            if (streamed.text) responseTexts.push(streamed.text);
            allToolCalls.push(...streamed.toolCalls);
            allBlocks.push(...streamed.blocks);
            if (streamed.agentMessage) agentMessage = streamed.agentMessage;
            turnError = streamed.error;
            if (streamed.completed) answered.push(...turnIds);
            turnIds = [];
            unsentAttachmentIds = [];

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
            //
            // A message the turn read as history it has answered. An inbox that held
            // only those is asked again, so the claim releases when nothing else waits.
            let handed = take(claim.drainOrRelease());
            while (handed.length > 0 && unread(handed).length === 0) handed = take(claim.drainOrRelease());
            const leftover = unread(handed);
            if (leftover.length === 0) break;

            // Text only: any files these carried are already linked to their stored
            // message rows, so the follow-up's context build picks them up.
            prompt = leftover.map((p) => promptText(p.text, p.agentMessage)).join('\n\n');
            appendPrompt = true;
            fromPerson = leftover.some((p) => !p.agentMessage);
            appendedMessageIds = leftover.map((p) => p.id);
            promptMessageId = undefined;
            runtimeNotices = undefined;
          }
        } finally {
          // A cancel or a throw ends the exchange with messages no turn took. They
          // stay in history unanswered, as after any cancel, and are owed nothing.
          take(claim.end());
        }
      });
      const ended: ChatTurnEnd = { threadId, cancelled: abortSignal.aborted, error: turnError };
      this.events.emit('turnEnded', ended);
    } catch (error) {
      // A throw, such as a reply that cannot be stored, leaves the user without an answer.
      const ended: ChatTurnEnd = { threadId, cancelled: abortSignal.aborted, error: turnError ?? { type: 'generic' } };
      this.events.emit('turnEnded', ended);
      throw error;
    } finally {
      // A shutdown leaves owed what no turn answered in full, so the next boot
      // answers it. Any other end, a cancel or a throw included, owes nothing.
      pendingWorkService.finish('chat', pendingWorkService.shutdownSignal.aborted ? answered : owed);
      unregister();
      for (const signal of stoppers) signal?.removeEventListener('abort', abort);
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
    input: Pick<ChatInput, 'agentId' | 'userId' | 'message' | 'attachmentIds' | 'metadata' | 'agentMessage' | 'runtimeWritten'>,
    threadId: string,
    id?: string,
  ): Promise<{ message: ConversationMessage; titleSet: string | null }> {
    const { agentId, userId, message, metadata, agentMessage } = input;
    const messageId = id ?? randomUUID();

    // Owed an answer from before it is stored until the exchange that answers it
    // ends, so no restart in between loses it.
    await pendingWorkService.begin('chat', messageId, chatWorkFor(input, threadId));

    // A reply the person typed stands in for the answers to any card still waiting.
    if (!agentMessage && !input.runtimeWritten) await questionCardService.closeWaitingInChat(agentId, userId, threadId);

    // The message text arrives already prefixed with the sender's mention
    // marker when the channel adapter wants the agent to see it in conversation
    // history.
    const { message: userMessage, titleSet } = await conversationService.addMessage(threadId, {
      id: messageId,
      content: message,
      role: 'USER',
      ...(agentMessage
        ? agentMessageColumns(agentMessage)
        : {
            triggeredBy: 'USER_INPUT' as const,
            senderExternalId: metadata?.senderExternalId,
            senderName: metadata?.senderName,
          }),
    });

    // First user message named the thread: announce the placeholder title and
    // kick off the cheap-model upgrade (fire-and-forget, never blocks the
    // turn). Channel-agnostic — transports subscribe to threadTitleService.
    //
    // Skipped for a channel that posts only the agent's replies: its threads are
    // keyed by an externalThreadId, which the web Recents and CLI resume picker
    // never show, so a generated title would cost a model call and a DB write
    // nobody sees.
    const origin = metadata?.channel ? messageDeliveryService.getAdapter(metadata.channel) : undefined;
    if (titleSet && (!origin || origin.showsWholeConversation)) {
      threadTitleService.onFirstUserMessage(agentId, userId, threadId, message, titleSet);
    }

    // Link any uploaded files (pre-send uploads, files a channel downloaded) to
    // the message that carries them so the context builder can expose them.
    if (input.attachmentIds?.length) {
      await attachmentService.linkToMessage(input.attachmentIds, userMessage.id, threadId);
    }

    // A channel that shows the whole conversation gets the person's own words
    // on every device — the sender's included, which reads the copy as the
    // confirmation that it was stored. Any other channel shows the message
    // itself.
    if (origin?.showsWholeConversation) {
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
        ...(p.agentMessage ? { agentMessage: p.agentMessage } : {}),
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
    /** The turn answers the person, not only other agents, so the person may rate it. */
    fromPerson: boolean;
    appendedMessageIds: string[];
    /** Snapshot taken once inside the lock; gates intermediate delivery. */
    verbose: boolean;
    channelContext: PublishOptions['channelContext'];
    metadata: ChatInput['metadata'];
    runtimeNotices?: string[];
    abortSignal?: AbortSignal;
    onToolEvent?: ToolLifecycleListener;
    /** After each step: the tool calls no stored message holds yet, and the files no delivered reply holds yet. */
    onUnsaved: (calls: ToolCallRecord[], attachmentIds: string[]) => void;
    /** Files an interrupted turn shared, which this turn's reply delivers. */
    unsentAttachmentIds?: string[];
    steering: () => Promise<SteeringMessage[]>;
    onHistoryRead: (rows: ReadonlyArray<HistoryRow>) => void;
    promptMessageId?: string;
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
    const allAttachmentIds: string[] = [...(params.unsentAttachmentIds ?? [])];
    let error: InvokeError | undefined;
    // Whether the row holds calls or files that this turn's reply takes over.
    let owes = allAttachmentIds.length > 0;

    for await (const step of invokeStream({
      userId,
      agentId,
      mode: 'chat',
      prompt,
      promptFromAgent: !params.fromPerson,
      appendPrompt: params.appendPrompt,
      appendedMessageIds: params.appendedMessageIds,
      promptMessageId: params.promptMessageId,
      threadId,
      workspaceRoot: params.workspaceRoot,
      verbose: params.verbose,
      channelLabel: metadata?.channelLabel,
      originChannel: metadata?.channel,
      originChannelId: metadata?.channelId,
      runtimeNotices: params.runtimeNotices,
      abortSignal: params.abortSignal,
      onToolEvent: params.onToolEvent,
      steering: params.steering,
      onHistoryRead: params.onHistoryRead,
    })) {
      allToolCalls.push(...step.toolCalls);
      if (step.blocks) allBlocks.push(...step.blocks);
      if (step.attachmentIds) allAttachmentIds.push(...step.attachmentIds);
      pendingToolCalls.push(...step.toolCalls);
      error = step.error;

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
      if (step.toolCalls.length > 0 || step.text) {
        const unsaved = [...bufferedToolCalls, ...pendingToolCalls];
        params.onUnsaved(unsaved, [...allAttachmentIds]);
        owes = unsaved.length > 0 || allAttachmentIds.length > 0;
      }
    }

    // Read before the delivery: an abort that lands during it stops no answer.
    const completed = !params.abortSignal?.aborted;
    const response = responseTexts.join('\n\n');

    // A turn a shutdown stopped delivers nothing. Its row keeps what the turn did,
    // and the next boot continues the turn from there.
    if (!completed && pendingWorkService.shutdownSignal.aborted) {
      return { text: response, toolCalls: allToolCalls, blocks: allBlocks, agentMessage, completed, error };
    }

    // Stream is done. The buffered step (if any) is the LAST text step:
    // attach the accumulated blocks and the feedback decision here.
    if (bufferedStep) {
      const includeFeedback = params.fromPerson && await this.shouldShowFeedback(
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

    // Fallback: the stream produced no text step. Publish only if there's still
    // something to show (tool calls, UI blocks or files) — e.g. a tool-only turn. When
    // a turn is canceled before producing anything, skip it rather than render
    // an empty agent bubble. (In this branch `response` is always '' because any
    // text step would have set `agentMessage` via the buffered-step publish.)
    // A question card is the turn's whole reply: the row keeps its tool call for the
    // model and shows nothing under the card.
    const asked = allToolCalls.some((call) => call.tool === ASK_QUESTIONS_TOOL_NAME);
    if (!agentMessage && asked && allBlocks.length === 0 && allAttachmentIds.length === 0) {
      const { message: persisted } = await conversationService.addMessage(threadId, {
        content: response,
        role: 'AGENT',
        triggeredBy: 'USER_INPUT',
        toolCalls: allToolCalls,
        internalStep: true,
      });
      agentMessage = persisted;
    }

    if (!agentMessage && (allToolCalls.length > 0 || allBlocks.length > 0 || allAttachmentIds.length > 0)) {
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
    // The reply holds the turn's calls and files now.
    if (owes) params.onUnsaved([], []);

    return { text: response, toolCalls: allToolCalls, blocks: allBlocks, agentMessage, completed, error };
  }
}

// Export singleton instance
export const conversationEngineService = new ConversationEngineService();
