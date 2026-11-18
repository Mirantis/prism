/**
 * Conversation compaction (channel-agnostic).
 *
 * Folds a thread's older history into one structured summary so the context
 * stays inside the model's window while the newest messages (the tail) remain
 * verbatim. The summary is *anchored*: on re-compaction the previous summary is
 * already in the message array (as the summary message `context-builder.ts`
 * injects), and the prompt folds it into the new, complete summary — so one
 * `compactionSummary` column per thread is the whole persistent state.
 *
 * Three entry points:
 *
 * - `maybeAutoCompact(fork)` — called by `invokeStream()` after a thread-bound
 *   turn with the turn's own request ingredients (model, cached system parts,
 *   cached tools, live message array). Reusing them makes the summarize call a
 *   "forked request": the provider's prompt cache already holds the
 *   tools+system+history prefix, so the fork is mostly a cache read.
 * - `compactNow()` — the manual `/compact` path (REST) — the idle path
 *   (`armIdle`, `restoreIdle`) and the stored-run path (`afterMessageStored`, for
 *   rows a run without a turn in the conversation stores) share `compactRebuilt`.
 *   It rebuilds the request from stored rows with the tool list the next chat turn would declare, so it reads the
 *   tools+system+history prefix a recent turn cached: nothing per-turn sits in the
 *   system prompt (the date changes once a day, and a turn's recalled memories are a
 *   stored row this path replays like any other).
 *
 * All serialize on the per-thread mutex (`threadTurnService.run`) so a
 * compaction never rewrites thread state while a turn is building its context.
 * All commit atomically, marking exactly the rows that were in the summarized
 * context (minus the tail) — never "all but last N at commit time" — so a
 * message that lands between fork and commit is never swallowed: it stays
 * uncompacted and verbatim in the next context.
 *
 * Live-read threads (any threadSource but DATABASE): their history is re-read
 * from the channel each turn and the synthesized rows carry hash ids, so row
 * flags cannot hide them. Their compaction instead advances a watermark
 * (`compactedThroughTs`, the newest compacted external message id) that the
 * thread provider passes as `oldest`. Only the interleaved internal-step DB
 * rows are flag-flipped there.
 *
 * Nothing here knows about WebSockets — progress is announced on the `events`
 * emitter as `'compaction'` and transports subscribe, matching
 * `context-usage.service.ts`. Nothing is ever delivered through
 * `messageDeliveryService`: compaction is a context-build concern, and a
 * "summarizing…" artifact must never land in a channel or the web chat as a
 * conversation message.
 */

import { EventEmitter } from 'node:events';
import { type LanguageModel, type ModelMessage, type SystemModelMessage, type Tool } from 'ai';
import { callModel } from '../lib/model-call';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import {
  COMPACTION_FALLBACK_WINDOW_TOKENS,
  COMPACTION_TAIL_TOKENS,
  IDLE_COMPACTION_MIN_TOKENS,
  IDLE_COMPACTION_CACHE_SHARE,
  MAX_OUTPUT_TOKENS,
} from '../constants';
import { COMPACTION_PROMPT } from '../prompts/compaction-prompt';
import { MIN_PLAUSIBLE_CONTEXT } from '../lib/model-catalog';
import { contextWindowFor } from '../lib/context-window';
import { createProvider } from '../lib/llm-providers/create-provider';
import {
  cacheRequestOptions,
  cacheTtlFor,
  cacheTtlMs,
  NO_CACHE_POINT,
  type CachePointFragment,
  type LlmProvider,
  type ProviderOptionsFragment,
} from '../lib/llm-providers/llm-provider';
import { llmCallService, type LlmCallPurpose } from './llm-call.service';
import { conversationService, type MessageStored } from './conversation.service';

import { collectTools, withToolsCacheControl } from '../lib/tool-collection';
import { withToolOutputCapture } from '../lib/tool-output-limiter';
import type { Invoker } from '../lib/task-tool';
import {
  buildSystemPromptParts,
  buildConversationHistory,
  SUMMARY_MESSAGE_OPENING,
} from '../prompts/context-builder';
import { getTaskToolInstructions } from '../prompts/task-tool-prompt';
import { getChannelBehaviorInstructions } from '../prompts/channel-prompt';
import { messageDeliveryService } from './message-delivery.service';
import { isContextOverflowError } from '../lib/llm-errors';
import { agentWorkspaceService } from './agent-workspace.service';
import { compactionModel } from '../lib/model-routing';
import { resolveModelSelection } from '../lib/model-selection';
import { summaryToolOptions, toolLedgerService } from './tool-ledger.service';
import { contextService } from './context.service';
import { contextUsageService, type ContextUsageSnapshot } from './context-usage.service';
import { threadTurnService } from './thread-turn.service';
import { trackEvent, langfuseTelemetry } from '../lib/telemetry';
import { planToolSearch } from '../lib/tool-search/plan';

/**
 * One row of the summarized context, as it stood when the request was built.
 * The commit marks exactly these rows (minus the tail) — see the module doc.
 */
export interface ForkRow {
  id: string;
  /**
   * Channel-native message id for rows read live from an external channel
   * (e.g. a message timestamp); null for DB-native rows.
   */
  externalMessageId: string | null;
  /** Concise-mode internal steps are real DB rows. */
  internalStep: boolean;
  /**
   * A message the user wrote, not a recalled-memory block stored in a user row. The
   * kept tail starts on one, so a reply never opens it without its request.
   */
  fromUser: boolean;
  /** The message's text plus its tool calls and results, for sizing the tail (~4 chars/token). */
  contentChars: number;
}

/** A turn's request ingredients, handed over by invokeStream. */
export interface CompactionFork {
  userId: string;
  agentId: string;
  threadId: string;
  modelId: string;
  /** The exact model instance the turn used. */
  model: LanguageModel;
  /** The provider's prompt-cache breakpoint fragment. */
  cachePoint: CachePointFragment;
  /** The turn's request-level cache options, which the summary sends too. */
  cacheRequest: ProviderOptionsFragment;
  /** cachedSystem — cache breakpoints included. */
  system: SystemModelMessage[];
  /** cachedTools — what the summarize call declares (see `declaredTools`). */
  tools: Record<string, Tool>;
  /**
   * Whether the summary request has to send `tools` under tool choice 'auto':
   * a declared list (tool-ledger.service.ts), or deferred tools that history
   * loads on a vendor whose SDK drops the block under 'none'.
   */
  declaredTools: boolean;
  /** History as sent, summary message included, without the turn's trailing tool-change announcements. */
  messages: ModelMessage[];
  /** Mid-turn steering messages, in arrival order. */
  injections: ModelMessage[];
  /** context.recentMessages at fork time. */
  contextRows: ForkRow[];
}

/** The successful-turn variant: carries the reply and the trigger measurement. */
export interface AutoCompactFork extends CompactionFork {
  /** This turn's collapsed assistant text (tool calls + results included). */
  finalAssistantText: string;
  /** The turn's last per-step occupancy snapshot (a trigger-only fallback is legal). */
  snapshot: ContextUsageSnapshot;
}

/** Emitted as `'compaction'` on `events`; broadcast to clients verbatim. */
export interface CompactionEvent {
  userId: string;
  threadId: string;
  /**
   * `skipped` is a benign no-op (nothing to compact), kept distinct from
   * `failed` so it neither reads as an error in the UI nor counts toward the
   * failure metric.
   */
  status: 'started' | 'completed' | 'failed' | 'skipped';
  trigger: 'auto' | 'manual';
  tokensBefore?: number | null;
  /** chars/4 estimate over the rebuilt context; null when the window is unknown. */
  tokensAfter?: number | null;
  messagesCompacted?: number;
  /** Failed only. Exception text — never the summary. */
  error?: string;
  /** Skipped only. Why there was nothing to do. */
  detail?: string;
  /** Completed only: the conversation was compacted while it sat idle. */
  idle?: true;
}

/** One finished summary, before it is committed: the report plus the rows it covers. */
type CompleteInput = Omit<FinishInput, 'messagesCompacted' | 'tail' | 'laterChars'> & { rows: ForkRow[] };

interface FinishInput {
  userId: string;
  agentId: string;
  threadId: string;
  trigger: 'auto' | 'manual';
  /** Telemetry-only refinement of `trigger`: what actually fired the job. */
  reason: 'threshold' | 'overflow' | 'manual' | 'idle';
  modelId: string;
  threadSource: string;
  tokensBefore: number | null;
  summary: string;
  messagesCompacted: number;
  /** The rows the commit kept verbatim. */
  tail: ForkRow[];
  /** Characters of the rows stored after the summarized context was read. */
  laterChars: number;
}

class CompactionService {
  readonly events = new EventEmitter();

  /**
   * Threads with a compaction queued or running. Collapses the coalesced
   * follow-up turns of one exchange to a single compaction and stops a manual
   * request from double-queuing behind an auto one.
   */
  private readonly inFlight = new Set<string>();

  /**
   * The newest stored row of each thread that a stored run wrote while a compaction
   * of it was queued or running. `settle` sizes that thread again.
   */
  private readonly storedDuringCompaction = new Map<string, MessageStored>();

  /**
   * One timer per idle chat conversation. `restoreIdle` re-arms them at boot from
   * stored data. A thread a session reset left behind still gets its one summary.
   */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();


  /** Whether any compaction is currently running. */
  hasInFlight(): boolean {
    return this.inFlight.size > 0;
  }

  /** Ends a thread's queued or running compaction, and emits `settled`. */
  private settle(threadId: string): void {
    this.inFlight.delete(threadId);
    this.events.emit('settled', threadId);
    const stored = this.storedDuringCompaction.get(threadId);
    if (!stored) return;
    this.storedDuringCompaction.delete(threadId);
    this.afterMessageStored(stored);
  }

  /**
   * Auto path. Synchronous and never throws — invokeStream calls it on the hot
   * path right before closing the step stream. All trigger policy lives here so
   * the caller stays dumb: it hands over the fork unconditionally.
   */
  maybeAutoCompact(fork: AutoCompactFork): void {
    try {
      const threshold = config.compactionThresholdPercent;
      if (threshold === null) return; // disabled by operator
      if (fork.snapshot.usedPercent < threshold) return;
      // A window smaller than the plausibility floor is a poisoned or broken
      // catalog value; refusing to act on it bounds the blast radius of a bad
      // registry entry to a wrong percentage on screen (see model-catalog.ts).
      if (fork.snapshot.windowTokens < MIN_PLAUSIBLE_CONTEXT) return;
      if (splitTail(fork.contextRows).compactable.length === 0) return; // nothing meaningful
      if (this.inFlight.has(fork.threadId)) return; // once per exchange

      this.inFlight.add(fork.threadId);
      // Fire-and-forget: enqueues on the per-thread mutex without awaiting it,
      // so calling from inside the current turn cannot self-deadlock — the
      // compaction runs after the claim releases (precedent: goal.service.ts).
      void threadTurnService
        .run(fork.threadId, () => this.runAutoCompaction(fork))
        .catch((err) => {
          // The runner handles its own failures; this catch only sees
          // mutex-level ones, so the failed event has no other emitter.
          logger.error({ err, threadId: fork.threadId }, '[Compaction] auto-compaction failed');
          this.fail(fork.userId, fork.agentId, fork.threadId, 'auto', errorText(err));
        })
        .finally(() => this.settle(fork.threadId));
    } catch (err) {
      this.settle(fork.threadId);
      logger.error({ err, threadId: fork.threadId }, '[Compaction] auto-compaction enqueue failed');
    }
  }

  /**
   * Idle path. After a chat turn under `CHAT_CACHE_TTL=1h`, a conversation of at
   * least `IDLE_COMPACTION_MIN_TOKENS` is compacted once it has sat idle for most of
   * its cache's lifetime, so the summary reads the turn's warm prefix. Any later
   * invocation of the thread cancels the timer. The due time comes from stored data
   * (`restoreIdle`), so a restart re-arms it. Synchronous, never throws.
   */
  armIdle(input: IdleInput & { provider: LlmProvider; modelId: string; usedTokens: number }): void {
    this.cancelIdle(input.threadId);
    if (!idleCompactionArmed() || input.usedTokens < IDLE_COMPACTION_MIN_TOKENS) return;
    const delayMs = idleDelayMs(input.provider, input.modelId);
    if (delayMs === null) return;
    // Measured from the turn's end; the cache clock started at its last request, at
    // most a few minutes earlier, which the delay leaves room for.
    this.scheduleIdle({ userId: input.userId, agentId: input.agentId, threadId: input.threadId, after: new Date() }, delayMs);
  }

  /**
   * At boot, re-arm the idle compactions a restart dropped: the conversations used
   * in the last day whose newest turn was a chat turn, of at least
   * `IDLE_COMPACTION_MIN_TOKENS`, and not compacted since. One already past its due
   * time is compacted at once.
   */
  async restoreIdle(): Promise<void> {
    if (!idleCompactionArmed()) return;
    const provider = createProvider();
    const candidates = await conversationService.listIdleCompactionCandidates(
      IDLE_COMPACTION_MIN_TOKENS,
      new Date(Date.now() - IDLE_RESTORE_WINDOW_MS),
    );
    for (const thread of candidates) {
      const last = await llmCallService.newestThreadCall(thread.id, THREAD_TURN_PURPOSES);
      if (last?.purpose !== 'chat') continue;
      if (thread.compactedAt && thread.compactedAt >= last.createdAt) continue;
      const delayMs = idleDelayMs(provider, last.model);
      if (delayMs === null) continue;
      const dueAt = last.createdAt.getTime() + delayMs;
      this.scheduleIdle(
        { userId: thread.userId, agentId: thread.agentId, threadId: thread.id, after: last.createdAt },
        Math.max(0, dueAt - Date.now()),
      );
    }
    if (candidates.length > 0) logger.info(`[Compaction] checked ${candidates.length} conversation(s) for idle compaction`);
  }

  /** Drops a conversation's idle timer: it has moved on, or is being compacted now. */
  cancelIdle(threadId: string): void {
    const timer = this.idleTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(threadId);
  }

  private scheduleIdle(due: IdleDue, delayMs: number): void {
    this.cancelIdle(due.threadId);
    const timer = setTimeout(() => this.compactIdle(due), delayMs);
    timer.unref();
    this.idleTimers.set(due.threadId, timer);
  }

  private compactIdle(due: IdleDue): void {
    this.idleTimers.delete(due.threadId);
    if (this.inFlight.has(due.threadId)) return;
    this.inFlight.add(due.threadId);
    void threadTurnService
      .run(due.threadId, async () => {
        // A turn that claimed the thread before the timer fired ran first, so the
        // conversation is no longer idle and this job stops. The tolerance covers a
        // call row stamped just after the turn armed the timer; the next turn starts
        // with a person's message, seconds later at least.
        const last = await llmCallService.newestThreadCall(due.threadId, THREAD_TURN_PURPOSES);
        if (last && last.createdAt.getTime() > due.after.getTime() + STALE_TOLERANCE_MS) return;
        // A compaction committed since then, by the threshold or a person, did the job.
        const thread = await prisma.conversationThread.findUnique({
          where: { id: due.threadId },
          select: { compactedAt: true },
        });
        if (thread?.compactedAt && thread.compactedAt > due.after) return;
        await this.compactRebuilt(due, 'auto', 'idle', last?.createdAt ?? due.after);
      })
      .catch((err) => {
        logger.error({ err, threadId: due.threadId }, '[Compaction] idle compaction failed');
        this.fail(due.userId, due.agentId, due.threadId, 'auto', errorText(err));
      })
      .finally(() => this.settle(due.threadId));
  }

  /**
   * Overflow recovery. Called by invokeStream's error path when a turn's
   * request outgrew the model's context window: that turn never reaches the
   * threshold hook (it only runs on success), and every later turn rebuilds
   * the same oversized context — without this, the thread is stuck rejecting
   * forever. No threshold or window guard on purpose: the provider's own
   * rejection is stronger evidence than any measured percentage, and it also
   * covers models whose window we don't know. Synchronous, never throws.
   */
  maybeCompactAfterOverflow(fork: CompactionFork): void {
    try {
      if (config.compactionThresholdPercent === null) return; // operator disabled auto-compaction
      if (splitTail(fork.contextRows).compactable.length === 0) return;
      if (this.inFlight.has(fork.threadId)) return;

      this.inFlight.add(fork.threadId);
      void threadTurnService
        .run(fork.threadId, () => this.runOverflowCompaction(fork))
        .catch((err) => {
          // The runner handles its own failures; this catch only sees
          // mutex-level ones, so the failed event has no other emitter.
          logger.error({ err, threadId: fork.threadId }, '[Compaction] overflow compaction failed');
          this.fail(fork.userId, fork.agentId, fork.threadId, 'auto', errorText(err));
        })
        .finally(() => this.settle(fork.threadId));
    } catch (err) {
      this.settle(fork.threadId);
      logger.error({ err, threadId: fork.threadId }, '[Compaction] overflow compaction enqueue failed');
    }
  }

  /**
   * Stored-run path. A run without a turn in the conversation, such as a scheduled
   * task, a heartbeat or a webhook, stores rows there that no turn has measured, so
   * `maybeAutoCompact` never sees them. After such a row is stored, the conversation
   * is sized as its last measurement plus an estimate of the rows stored since, and
   * one at or over the threshold is compacted before the next turn reads it. A chat
   * turn's own rows are measured at its end. Synchronous, never throws.
   */
  afterMessageStored(stored: MessageStored): void {
    if (stored.triggeredBy === 'USER_INPUT') return;
    if (config.compactionThresholdPercent === null) return; // disabled by operator
    const { userId, agentId, threadId } = stored;
    if (this.deferWhileCompacting(stored)) return;
    void this.storedGrowth(agentId, threadId)
      .then((due) => {
        if (!due || this.deferWhileCompacting(stored)) return;
        this.inFlight.add(threadId);
        return threadTurnService
          .run(threadId, async () => {
            // A turn or compaction that held the thread first has measured or compacted it.
            const still = await this.storedGrowth(agentId, threadId);
            if (!still) return;
            this.cancelIdle(threadId);
            // A conversation no turn has measured has no warm cache to read.
            const lastCallAt = still.measuredAt ?? new Date(0);
            await this.compactRebuilt({ userId, agentId, threadId }, 'auto', 'threshold', lastCallAt);
          })
          .catch((err) => {
            logger.error({ err, threadId }, '[Compaction] stored-run compaction failed');
            this.fail(userId, agentId, threadId, 'auto', errorText(err));
          })
          .finally(() => this.settle(threadId));
      })
      .catch((err) => logger.warn({ err, threadId }, '[Compaction] could not size a conversation after a stored run'));
  }

  /**
   * Keeps a row stored while the thread's compaction is queued or running for
   * `settle`, which sizes the thread again once that compaction has committed.
   */
  private deferWhileCompacting(stored: MessageStored): boolean {
    if (!this.inFlight.has(stored.threadId)) return false;
    this.storedDuringCompaction.set(stored.threadId, stored);
    return true;
  }

  /**
   * A DATABASE thread's size as its last measurement plus the rows stored after it,
   * at `CHARS_PER_TOKEN`, when that reaches the threshold; null otherwise. The
   * measurement is the newer of the thread's last turn and its last compaction. A
   * thread no turn has measured is sized from all its uncompacted rows, against the
   * window of the model its compaction would run on.
   */
  private async storedGrowth(
    agentId: string,
    threadId: string,
  ): Promise<{ measuredAt: Date | undefined } | null> {
    const threshold = config.compactionThresholdPercent;
    if (threshold === null) return null;
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true, contextTokens: true, contextModel: true, compactedAt: true },
    });
    if (thread?.threadSource !== 'DATABASE') return null;
    const lastTurn = await llmCallService.newestThreadCall(threadId, THREAD_TURN_PURPOSES);
    const measuredAt = [lastTurn?.createdAt, thread.compactedAt ?? undefined]
      .filter((at): at is Date => at !== undefined)
      .reduce<Date | undefined>((newest, at) => (newest && newest >= at ? newest : at), undefined);
    const modelId = thread.contextModel ?? (await unmeasuredCompactionModel(agentId, threadId));
    const windowTokens = contextWindowFor(modelId)?.tokens ?? COMPACTION_FALLBACK_WINDOW_TOKENS;
    if (windowTokens < MIN_PLAUSIBLE_CONTEXT) return null;
    const rows = await prisma.conversationMessage.findMany({
      where: { threadId, isCompacted: false, ...(measuredAt && { createdAt: { gt: measuredAt } }) },
      select: { content: true, toolCalls: true, blocks: true },
    });
    const chars = storedChars(rows);
    const measured = measuredAt ? (thread.contextTokens ?? 0) : 0;
    const usedTokens = measured + Math.ceil(chars / CHARS_PER_TOKEN);
    return (100 * usedTokens) / windowTokens >= threshold ? { measuredAt } : null;
  }

  /**
   * Manual path (`/compact` → REST): a compaction rebuilt from the stored thread
   * under the thread mutex (see `compactRebuilt`).
   */
  async compactNow(input: { userId: string; agentId: string; threadId: string }): Promise<void> {
    const { userId, agentId, threadId } = input;
    // A queued idle compaction does what was asked, so it is left to run.
    if (this.inFlight.has(threadId)) return; // one already queued/running is enough
    this.cancelIdle(threadId);
    this.inFlight.add(threadId);
    try {
      await threadTurnService.run(threadId, () => this.compactRebuilt(input, 'manual', 'manual'));
    } catch (err) {
      logger.error({ err, threadId }, '[Compaction] manual compaction failed');
      this.fail(userId, agentId, threadId, 'manual', errorText(err));
    } finally {
      this.settle(threadId);
    }
  }

  /**
   * One compaction whose request is rebuilt from the stored thread, as the next chat
   * turn would send it, so it reads the prefix that turn's cache holds. Runs under
   * the thread's lock; the caller owns `inFlight`.
   */
  private async compactRebuilt(
    input: { userId: string; agentId: string; threadId: string },
    trigger: 'auto' | 'manual',
    reason: 'manual' | 'idle' | 'threshold',
    lastCallAt?: Date,
  ): Promise<void> {
    const { userId, agentId, threadId } = input;
    this.start(userId, agentId, threadId, trigger);

    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true, contextTokens: true, workspaceRoot: true },
    });
    const context = await contextService.getAgentContext(userId, {
      agentId,
      threadId,
      includeConversation: true,
    });
    const rows = toForkRows(context.recentMessages);
    if (splitTail(rows).compactable.length === 0) {
      // A no-op, not a failure: the REST precheck cannot size the tail, so a
      // short thread lands here.
      this.skip(userId, agentId, threadId, trigger, 'Nothing to compact yet.');
      return;
    }

    const provider = createProvider();
    const modelId = await compactionModel(context, threadId, provider);
    const model = provider(modelId);
    // The chat turns' lifetime, since on some vendors an entry of another lifetime
    // replaces the thread's entry instead of reading it. An idle summary whose cache
    // has expired reads the thread at full price whatever it asks for, and nothing
    // reuses its prefix, so it writes no entry at all.
    const ttl = cacheTtlFor('chat');
    const cold = lastCallAt !== undefined && Date.now() - lastCallAt.getTime() > cacheTtlMs(provider, modelId, ttl);
    const cachePoint = cold ? NO_CACHE_POINT : provider.cachePoint(modelId, ttl);
    const cacheRequest = cacheRequestOptions(provider, modelId, ttl, !cold);

    // A conversation with a declared tool list sends that list: its cached
    // prefix starts with it, and its tool-change announcements name it.
    const protocol = provider.toolChanges?.(modelId);
    const known = protocol ? toolLedgerService.peek({ threadId, modelId, protocol }) : undefined;

    // Same tool set as a chat turn: the tools block must match byte-for-byte
    // or the request misses the tools+stable-system cache prefix chat turns
    // keep warm. The Task invoker can never run here. A declared list is the
    // tools block itself, but deferred tools still need the collected set for
    // the catalog and the replayed loads.
    const deferredToolProtocol = provider.deferredTools?.(modelId);
    const collected = known && !deferredToolProtocol
      ? undefined
      : await collectTools({
          userId,
          agentId,
          threadId,
          mode: 'chat',
          workspaceRoot: thread?.workspaceRoot ?? undefined,
          taskInvoker: neverInvoke,
          lockedIn: context.lockedIn,
        });
    const subagents = collected?.subagents ?? (await agentWorkspaceService.getSubagents(agentId));
    // Nothing executes here, so saving is off — the wrap exists only so this
    // request's tools block is built exactly like a chat turn's, which is what the
    // provider's cache prefix is keyed on.
    const toolSearch = await planToolSearch({
      tools: collected ? withToolOutputCapture(collected.tools, { spill: false }) : {},
      deferrable: collected?.deferrable ?? [],
      protocol: deferredToolProtocol,
      modelId,
      telemetry: { userId, agentId, mode: 'compaction' },
    });
    // A conversation the ledger has no record of, as after a restart, gets the
    // list its next chat turn would declare. Without a declared list the
    // request goes out under tool choice 'none', which sends no tools block and
    // so misses the prefix the chat turns cached.
    const declared = protocol
      ? (known ??
        (await toolLedgerService.declare({
          threadId,
          modelId,
          protocol,
          available: toolSearch.tools,
          rowIds: context.recentMessages.map((row) => row.id),
        })))
      : undefined;
    // A declared list is already the tools block the chat turns send.
    const cachedTools = withToolsCacheControl(declared?.tools ?? toolSearch.tools, cachePoint, declared?.deferred);

    const systemParts = await buildSystemPromptParts(
      context,
      'chat',
      undefined,
      thread?.workspaceRoot ?? undefined,
    );
    // Mirror invoke.ts: task-tool instructions, and a shared web chat's
    // channel instructions, ride the stable part, and cacheable parts carry
    // the Anthropic breakpoints — without them this request neither reads nor
    // refreshes the shared prefix. The thread records no origin channel, so
    // its label comes as for a continuation.
    const { channelLabel } = await messageDeliveryService.threadContext(threadId);
    const stablePart = systemParts.find((p) => p.cacheable);
    if (channelLabel && stablePart) {
      stablePart.text += '\n\n' + getChannelBehaviorInstructions(channelLabel);
    }
    if (subagents.length > 0 && stablePart) {
      stablePart.text += '\n\n' + getTaskToolInstructions(
        subagents.map((s) => ({ name: s.name, description: s.description })),
      );
    }
    const toolSearchPrompt = declared
      ? await toolSearch.promptFor(declared.tools, declared.deferred)
      : toolSearch;
    if (toolSearchPrompt.catalog && stablePart) stablePart.text += '\n\n' + toolSearchPrompt.catalog;
    const system: SystemModelMessage[] = systemParts.map((part) => ({
      role: 'system' as const,
      content: part.text,
      ...(part.cacheable ? { providerOptions: cachePoint } : {}),
    }));
    const history = buildConversationHistory(
      context,
      declared?.toolChanges,
      toolSearchPrompt.replayToolCall,
      Boolean(channelLabel),
    );
    const messages: ModelMessage[] = [
      ...history.messages,
      { role: 'user' as const, content: COMPACTION_PROMPT, providerOptions: cachePoint },
      ...history.trailingToolChanges,
    ];

    const result = await callModel({ purpose: 'compaction', threadId }, {
      model,
      system,
      messages,
      ...(declared || toolSearch.summaryDeclaresTools
        ? summaryToolOptions(cachedTools)
        : Object.keys(cachedTools).length > 0
          ? { tools: cachedTools, toolChoice: 'none' as const }
          : {}),
      maxOutputTokens: summaryOutputBudget(contextWindowFor(modelId)?.tokens, thread?.contextTokens),
      providerOptions: cacheRequest,
      ...langfuseTelemetry('compaction', { userId, sessionId: threadId }),
    });
    const summary = readSummary(result);
    if ('error' in summary) {
      this.fail(userId, agentId, threadId, trigger, summary.error);
      return;
    }

    await this.complete({
      userId,
      agentId,
      threadId,
      trigger,
      reason,
      modelId,
      threadSource: thread?.threadSource ?? 'DATABASE',
      tokensBefore: thread?.contextTokens ?? null,
      summary: summary.text,
      rows,
    });
  }

  /**
   * Cheap REST precheck. Counts DB rows, which is right for DATABASE threads;
   * live-read threads pass through (their history lives in the channel, and
   * compactNow's own row check covers them).
   */
  async hasCompactableHistory(threadId: string): Promise<boolean> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true },
    });
    // Channel-backed threads pass through — their history lives in the
    // channel, not in DB rows, so a row count says nothing about them.
    if (thread?.threadSource !== 'DATABASE') return true;
    // A row count cannot size the tail, which is measured in tokens, so this asks only
    // for some history. compactNow's own check decides the rest.
    const uncompacted = await prisma.conversationMessage.count({
      where: { threadId, isCompacted: false },
    });
    return uncompacted > 0;
  }

  /** The forked summarize request — see the module doc for the cache story. */
  private async runAutoCompaction(fork: AutoCompactFork): Promise<void> {
    const { userId, agentId, threadId } = fork;
    try {
      this.start(userId, agentId, threadId, 'auto');

      const assistantText = fork.finalAssistantText.trim();
      // The cache breakpoint on the final message is what makes this a cheap
      // forked request: Anthropic/Bedrock only cache-READ at explicit
      // breakpoints, and the longest-prefix lookup reaches back past the few
      // appended blocks to the cache entry the turn's own last step wrote
      // (prepareStep marks its last message). Without it the tools+system
      // prefix would hit but the history — the bulk of the prompt — would be
      // re-prefilled at full price. Budget: 1 system + 1 tools + this = 3, inside
      // Bedrock's limit of 4.
      const messages: ModelMessage[] = [
        ...fork.messages,
        ...fork.injections,
        // An empty assistant block would be rejected by the provider; a turn
        // can end with no visible text (rare), in which case the last real
        // message already closes the exchange.
        ...(assistantText ? [{ role: 'assistant' as const, content: assistantText }] : []),
        { role: 'user' as const, content: COMPACTION_PROMPT, providerOptions: fork.cachePoint },
      ];

      const result = await callModel({ purpose: 'compaction', threadId }, {
        model: fork.model,
        system: fork.system,
        messages,
        ...(fork.declaredTools
          ? summaryToolOptions(fork.tools)
          : {
              tools: Object.keys(fork.tools).length > 0 ? fork.tools : undefined,
              // Forbids tool use in the summary call. Where the SDK still sends
              // the tools block under 'none', it keeps the turn's tools segment.
              toolChoice: 'none' as const,
            }),
        maxOutputTokens: summaryOutputBudget(fork.snapshot.windowTokens, fork.snapshot.usedTokens),
        providerOptions: fork.cacheRequest,
        ...langfuseTelemetry('compaction', { userId, sessionId: threadId }),
      });
      const summary = readSummary(result);
      if ('error' in summary) {
        this.fail(userId, agentId, threadId, 'auto', summary.error);
        return;
      }

      const thread = await prisma.conversationThread.findUnique({
        where: { id: threadId },
        select: { threadSource: true },
      });
      await this.complete({
        userId,
        agentId,
        threadId,
        trigger: 'auto',
        reason: 'threshold',
        modelId: fork.modelId,
        threadSource: thread?.threadSource ?? 'DATABASE',
        tokensBefore: fork.snapshot.usedTokens,
        summary: summary.text,
        rows: fork.contextRows,
      });
    } catch (err) {
      logger.error({ err, threadId }, '[Compaction] auto-compaction failed');
      this.fail(userId, agentId, threadId, 'auto', errorText(err));
    }
  }

  /**
   * Overflow-recovery summarize: like the threshold fork, but the request that
   * just failed proves the full history + prompt does NOT fit — so on a
   * context-overflow rejection of the summarize call itself, the oldest
   * quarter of the history is dropped and the call retried (the array is
   * re-anchored on a user message so tool-call pairs never split). The commit
   * still marks every fork row minus the tail: rows whose content fell out of
   * the shrunken summarize input lose their detail, which is the accepted
   * price of unsticking a thread that otherwise rejects forever. When even the
   * previous summary has to go, the new one replaces it without having read it,
   * and the history before it is gone from the context.
   */
  private async runOverflowCompaction(fork: CompactionFork): Promise<void> {
    const { userId, agentId, threadId } = fork;
    try {
      this.start(userId, agentId, threadId, 'auto');

      let history: ModelMessage[] = [...fork.messages, ...fork.injections];
      let summary: SummaryOutcome;
      // Each shrink drops a quarter, so the reachable floor is 0.75^(n-1) of
      // the original: 5 attempts bottom out at ~32%, which still overflows a
      // history several times the window — and that is exactly the first turn
      // on a thread whose full history was never compacted before. 10 attempts
      // reach ~7.5%, enough for a thread carrying ~10x the window. The cap is
      // only a runaway guard; shrinkHistoryHead's null return is the real
      // terminating condition.
      const MAX_ATTEMPTS = 10;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await callModel({ purpose: 'compaction', threadId }, {
            model: fork.model,
            system: fork.system,
            messages: [
              ...history,
              { role: 'user' as const, content: COMPACTION_PROMPT, providerOptions: fork.cachePoint },
            ],
            ...(fork.declaredTools
              ? summaryToolOptions(fork.tools)
              : {
                  tools: Object.keys(fork.tools).length > 0 ? fork.tools : undefined,
                  toolChoice: 'none' as const,
                }),
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            providerOptions: fork.cacheRequest,
            ...langfuseTelemetry('compaction', { userId, sessionId: threadId }),
          });
          summary = readSummary(result);
          break;
        } catch (err) {
          if (attempt >= MAX_ATTEMPTS - 1 || !isContextOverflowError(err)) throw err;
          const shrunk = shrinkHistoryHead(history);
          if (!shrunk) throw err;
          logger.info(
            `[Compaction] summarize overflowed for thread ${threadId}; retrying with ${shrunk.length}/${history.length} messages`,
          );
          history = shrunk;
        }
      }
      if ('error' in summary) {
        this.fail(userId, agentId, threadId, 'auto', summary.error);
        return;
      }

      const thread = await prisma.conversationThread.findUnique({
        where: { id: threadId },
        select: { threadSource: true, contextTokens: true },
      });
      await this.complete({
        userId,
        agentId,
        threadId,
        trigger: 'auto',
        reason: 'overflow',
        modelId: fork.modelId,
        threadSource: thread?.threadSource ?? 'DATABASE',
        tokensBefore: thread?.contextTokens ?? null,
        summary: summary.text,
        rows: fork.contextRows,
      });
    } catch (err) {
      logger.error({ err, threadId }, '[Compaction] overflow compaction failed');
      this.fail(userId, agentId, threadId, 'auto', errorText(err));
    }
  }

  /** Shared last step of every runner: commit the summary, report it. */
  private async complete(input: CompleteInput): Promise<void> {
    const { messagesCompacted, tail, laterChars } = await this.commit(input.threadId, input.summary, input.rows);
    await this.finish({ ...input, messagesCompacted, tail, laterChars });
  }

  /**
   * Persist one compaction: the summary + watermark on the thread and the
   * `isCompacted` flags on exactly `rows` minus the tail, in one transaction —
   * a summarizer that produced nothing writes nothing.
   *
   * DATABASE threads: row flags are authoritative; the watermark is stored as
   * the newest compacted row's createdAt ISO for observability. Live-read
   * threads: the watermark (the newest external message id among compacted
   * rows) is authoritative and only the interleaved internal-step DB rows get
   * flags — rows read from the channel have synthesized hash ids that match
   * nothing in the DB.
   */
  private async commit(
    threadId: string,
    summary: string,
    rows: ForkRow[],
  ): Promise<{ messagesCompacted: number; tail: ForkRow[]; laterChars: number }> {
    const { compactable, tail } = splitTail(rows);
    if (compactable.length === 0) return { messagesCompacted: 0, tail, laterChars: 0 };

    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true },
    });

    if (thread?.threadSource !== 'DATABASE') {
      const externalMessageIds = compactable
        .map((r) => r.externalMessageId)
        .filter((ts): ts is string => Boolean(ts));
      const watermark = externalMessageIds.length
        ? externalMessageIds.reduce((max, ts) => (parseFloat(ts) > parseFloat(max) ? ts : max))
        : null;
      const internalIds = compactable.filter((r) => r.internalStep).map((r) => r.id);
      await prisma.$transaction([
        prisma.conversationMessage.updateMany({
          where: { id: { in: internalIds } },
          data: { isCompacted: true },
        }),
        prisma.conversationThread.update({
          where: { id: threadId },
          data: {
            compactionSummary: summary,
            compactedAt: new Date(),
            ...(watermark ? { compactedThroughTs: watermark } : {}),
          },
        }),
      ]);
      logger.info(
        `[Compaction] compacted ${compactable.length} message(s) in thread ${threadId} (${summary.length} chars of summary)`,
      );
      return { messagesCompacted: compactable.length, tail, laterChars: 0 };
    } else {
      const ids = compactable.map((r) => r.id);
      const newest = await prisma.conversationMessage.findFirst({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const compactedAt = new Date();
      await prisma.$transaction([
        prisma.conversationMessage.updateMany({
          where: { id: { in: ids } },
          data: { isCompacted: true },
        }),
        prisma.conversationThread.update({
          where: { id: threadId },
          data: {
            compactionSummary: summary,
            compactedAt,
            compactedThroughTs: newest?.createdAt.toISOString() ?? null,
          },
        }),
      ]);
      // A stored run can write rows after the summarized context was read. They stay
      // verbatim, and the size this compaction stores counts them, because the stored-run
      // sizing reads only the rows stored after `compactedAt`.
      const later = await prisma.conversationMessage.findMany({
        where: {
          threadId,
          isCompacted: false,
          createdAt: { lte: compactedAt },
          id: { notIn: rows.map((r) => r.id) },
        },
        select: { content: true, toolCalls: true, blocks: true },
      });
      logger.info(
        `[Compaction] compacted ${compactable.length} message(s) in thread ${threadId} (${summary.length} chars of summary)`,
      );
      return { messagesCompacted: compactable.length, tail, laterChars: storedChars(later) };
    }
  }

  /** Shared completion: meter estimate, completed event, finished telemetry. */
  private async finish(input: FinishInput): Promise<void> {
    const tailChars = input.tail.reduce((n, r) => n + r.contentChars, 0);
    // ~4 chars/token over the rebuilt context (summary message, verbatim tail and
    // the rows stored after the summarized context was read).
    // Undershoots — the system prompt and tools aren't counted — and
    // self-corrects on the next turn's provider-reported usage.
    const estimatedTokens = Math.ceil((input.summary.length + tailChars + input.laterChars) / 4);

    const snapshot = contextUsageService.applyEstimate({
      userId: input.userId,
      threadId: input.threadId,
      modelId: input.modelId,
      usedTokens: estimatedTokens,
    });

    this.events.emit('compaction', {
      userId: input.userId,
      threadId: input.threadId,
      status: 'completed',
      trigger: input.trigger,
      tokensBefore: input.tokensBefore,
      tokensAfter: snapshot ? estimatedTokens : null,
      messagesCompacted: input.messagesCompacted,
      ...(input.reason === 'idle' ? { idle: true as const } : {}),
    } satisfies CompactionEvent);

    trackEvent('compaction finished', input.userId, {
      'agent.id': input.agentId,
      'thread.id': input.threadId,
      'thread.source': input.threadSource,
      'compaction.trigger': input.trigger,
      'compaction.reason': input.reason,
      'compaction.messages_compacted': String(input.messagesCompacted),
      ...(input.tokensBefore != null ? { 'context.tokens_before': String(input.tokensBefore) } : {}),
      ...(snapshot ? { 'context.tokens_after': String(estimatedTokens) } : {}),
      ...(snapshot ? { 'context.window_tokens': String(snapshot.windowTokens) } : {}),
    });
  }

  private start(userId: string, agentId: string, threadId: string, trigger: 'auto' | 'manual'): void {
    this.events.emit('compaction', {
      userId,
      threadId,
      status: 'started',
      trigger,
    } satisfies CompactionEvent);
    trackEvent('compaction started', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'compaction.trigger': trigger,
    });
  }

  /**
   * Terminal no-op: there was nothing to compact. Distinct from `fail()` so a
   * benign outcome doesn't surface as an error to the user or inflate the
   * `compaction failed` metric — the one you'd actually alert on.
   */
  private skip(
    userId: string,
    agentId: string,
    threadId: string,
    trigger: 'auto' | 'manual',
    detail: string,
  ): void {
    this.events.emit('compaction', {
      userId,
      threadId,
      status: 'skipped',
      trigger,
      detail,
    } satisfies CompactionEvent);
    trackEvent('compaction skipped', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'compaction.trigger': trigger,
    });
  }

  private fail(
    userId: string,
    agentId: string,
    threadId: string,
    trigger: 'auto' | 'manual',
    error: string,
  ): void {
    this.events.emit('compaction', {
      userId,
      threadId,
      status: 'failed',
      trigger,
      error,
    } satisfies CompactionEvent);
    trackEvent('compaction failed', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'compaction.trigger': trigger,
      'error.message': error,
    });
  }

}

const CHARS_PER_TOKEN = 4;

/** How much later than an idle timer's arm time a call row may be stamped and still be the same turn's. */
const STALE_TOLERANCE_MS = 5_000;

/** How far back `restoreIdle` looks for a conversation someone still uses. */
const IDLE_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The turns that use a conversation; a newer one than an idle timer's means it moved on.
 * A compaction is known by the thread's `compactedAt`, which its commit writes, so a
 * summary call that a restart stopped before its commit leaves the conversation due.
 */
const THREAD_TURN_PURPOSES: readonly LlmCallPurpose[] = ['chat', 'cron', 'goal', 'webhook'];

interface IdleInput {
  userId: string;
  agentId: string;
  threadId: string;
}

/**
 * Whether idle compaction runs: it and threshold compaction are on, and chat turns
 * ask for the one-hour cache. A five-minute cache has expired long before a person
 * who paused comes back, so there is no warm prefix for the summary to read.
 */
function idleCompactionArmed(): boolean {
  return config.idleCompaction && config.compactionThresholdPercent !== null && config.chatCacheTtl === '1h';
}

/**
 * How long a chat conversation on `modelId` sits idle before it is compacted, or
 * null when the vendor keeps the cache no longer under `1h` than by default.
 */
function idleDelayMs(provider: LlmProvider, modelId: string): number | null {
  const lifetimeMs = cacheTtlMs(provider, modelId, '1h');
  if (lifetimeMs <= cacheTtlMs(provider, modelId, '5m')) return null;
  return IDLE_COMPACTION_CACHE_SHARE * lifetimeMs;
}

/** A pending idle compaction, and the time after which a call on the thread cancels it. */
interface IdleDue extends IdleInput {
  after: Date;
}

/** A context's rows as the commit marks them. */
export function toForkRows(
  messages: Array<{
    id: string;
    role: string;
    externalMessageId?: string | null;
    internalStep?: boolean;
    content: string;
    toolCalls?: unknown;
  }>,
): ForkRow[] {
  return messages.map((m) => ({
    id: m.id,
    externalMessageId: m.externalMessageId ?? null,
    internalStep: m.internalStep ?? false,
    fromUser: m.role === 'USER' && !m.internalStep,
    contentChars: m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
  }));
}

/** The characters stored rows add to a request: text, tool calls and blocks. */
function storedChars(rows: Array<{ content: string; toolCalls: unknown; blocks: unknown }>): number {
  return rows.reduce<number>(
    (sum, row) =>
      sum +
      row.content.length +
      (row.toolCalls === null ? 0 : JSON.stringify(row.toolCalls).length) +
      (row.blocks === null ? 0 : JSON.stringify(row.blocks).length),
    0,
  );
}

/**
 * The model a compaction of a thread no turn has measured would run on: the agent's
 * model in Fixed mode, the largest tier in Auto mode.
 */
async function unmeasuredCompactionModel(agentId: string, threadId: string): Promise<string> {
  const agent = await prisma.agentWorkspace.findUniqueOrThrow({
    where: { id: agentId },
    select: { model: true, modelMode: true, smallModel: true, mediumModel: true, largeModel: true },
  });
  return compactionModel({ model: agent.model, modelSelection: resolveModelSelection(agent) }, threadId, createProvider());
}

/**
 * The rows a compaction keeps verbatim, and the ones before them it summarizes.
 * The tail is the longest run of newest rows that starts on a user's message, holds
 * at most `compactionTailMessages` rows and fits `COMPACTION_TAIL_TOKENS`. The row
 * cap gives way for the newest exchange, since one reply can be many step rows.
 * When even the newest exchange does not fit the token budget, everything is
 * summarized. A thread with no user message keeps its newest rows that fit both.
 */
export function splitTail(rows: ForkRow[]): { compactable: ForkRow[]; tail: ForkRow[] } {
  if (config.compactionTailMessages === 0) return { compactable: rows, tail: [] };
  const budget = COMPACTION_TAIL_TOKENS * CHARS_PER_TOKEN;
  // A thread with no user message at all, such as a goal's, has no request to anchor on.
  const anchored = rows.some((r) => r.fromUser);
  let start = rows.length;
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    chars += rows[i].contentChars;
    if (chars > budget) break;
    if (rows.length - i > config.compactionTailMessages && (start < rows.length || !anchored)) break;
    if (rows[i].fromUser || !anchored) start = i;
  }
  return { compactable: rows.slice(0, start), tail: rows.slice(start) };
}

/** Room left for the forked request's own additions: the turn's reply and the prompt. */
const SUMMARY_REQUEST_MARGIN_TOKENS = 4_000;
const MIN_SUMMARY_OUTPUT_TOKENS = 4_096;

/**
 * The summary call's output budget: a chat turn's, which every catalog model
 * accepts. The Anthropic Messages API refuses a request whose input plus
 * `max_tokens` exceeds the window, so a nearly full window gets the room it has
 * left instead.
 */
function summaryOutputBudget(windowTokens: number | null | undefined, usedTokens: number | null | undefined): number {
  if (!windowTokens || usedTokens == null) return MAX_OUTPUT_TOKENS;
  // Under the floor the request fails on its size, and overflow recovery takes the thread
  // on its next turn.
  const room = windowTokens - usedTokens - SUMMARY_REQUEST_MARGIN_TOKENS;
  return Math.max(MIN_SUMMARY_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, room));
}

type SummaryOutcome = { text: string } | { error: string };

/** A summary the commit may use: not empty, and not cut off at the output budget. */
function readSummary(result: { text: string; finishReason: string }): SummaryOutcome {
  if (result.finishReason === 'length') {
    return { error: 'The summary was cut off at the output limit, so nothing was compacted.' };
  }
  const text = result.text.trim();
  return text ? { text } : { error: 'The model returned an empty summary.' };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Task-tool invoker for compaction requests. They send toolChoice 'none', so
 * the tool's execute can never run; this exists only so the tool's wire schema
 * matches a chat turn's.
 */
const neverInvoke: Invoker = async () => {
  throw new Error('Subagent tasks cannot run during compaction');
};

/**
 * Drop the oldest quarter of a summarize history that did not fit, then
 * re-anchor on a user message: an array sliced mid tool-exchange could start
 * on an assistant tool-call or a dangling tool result, both of which the
 * providers reject. A previous summary opens the history and stays, since it
 * stands for everything before it. Returns null when nothing meaningful would
 * remain.
 */
function shrinkHistoryHead(history: ModelMessage[]): ModelMessage[] | null {
  const head = isSummaryMessage(history[0]) ? history.slice(0, 1) : [];
  const rest = history.slice(head.length);
  const shrunk = anchorOnUser(rest.slice(Math.max(1, Math.ceil(rest.length / 4))));
  if (shrunk.length >= 1 && shrunk.length < rest.length) return [...head, ...shrunk];
  // Nothing is left to drop behind the summary, so the summary goes last.
  const withoutSummary = anchorOnUser(rest);
  return head.length > 0 && withoutSummary.length > 0 ? withoutSummary : null;
}

function anchorOnUser(messages: ModelMessage[]): ModelMessage[] {
  const first = messages.findIndex((m) => m.role === 'user');
  return first === -1 ? [] : messages.slice(first);
}

function isSummaryMessage(message: ModelMessage | undefined): boolean {
  return (
    message?.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(SUMMARY_MESSAGE_OPENING)
  );
}

export const compactionService = new CompactionService();
