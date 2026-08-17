/**
 * Conversation compaction (channel-agnostic).
 *
 * Folds a thread's older history into one structured summary so the context
 * stays inside the model's window while the newest messages (the tail) remain
 * verbatim. The summary is *anchored*: on re-compaction the previous summary is
 * already in the message array (as the synthetic pair `context-builder.ts`
 * injects), and the prompt folds it into the new, complete summary — so one
 * `compactionSummary` column per thread is the whole persistent state.
 *
 * Two entry points:
 *
 * - `maybeAutoCompact(fork)` — called by `invokeStream()` after a thread-bound
 *   turn with the turn's own request ingredients (model, cached system parts,
 *   cached tools, live message array). Reusing them makes the summarize call a
 *   "forked request": the provider's prompt cache already holds the
 *   tools+system+history prefix, so the fork is mostly a cache read.
 * - `compactNow()` — the manual `/compact` path (REST). Rebuilds the context
 *   from stored rows and attaches the same tool set a chat turn sends (with
 *   toolChoice 'none'), so the request shares the tools+stable-system cache
 *   prefix chat turns keep warm. The history block still re-prefills — the
 *   dynamic system part carries a per-invocation timestamp, so history never
 *   cache-hits across invocations; that matches chat turns' own economics.
 *
 * Both serialize on the per-thread mutex (`threadTurnService.run`) so a
 * compaction never rewrites thread state while a turn is building its context.
 * Both commit atomically, marking exactly the rows that were in the summarized
 * context (minus the tail) — never "all but last N at commit time" — so a
 * message that lands between fork and commit is never swallowed: it stays
 * uncompacted and verbatim in the next context.
 *
 * Slack threads: their history is re-read live from the Slack API each turn and
 * the synthesized rows carry hash ids, so row flags cannot hide them. Slack
 * compaction instead advances a Slack-ts watermark (`compactedThroughTs`) that
 * the Slack thread provider passes as `oldest`. Only the interleaved
 * internal-step DB rows are flag-flipped there.
 *
 * Nothing here knows about WebSockets — progress is announced on the `events`
 * emitter as `'compaction'` and transports subscribe, matching
 * `context-usage.service.ts`. Nothing is ever delivered through
 * `messageDeliveryService`: compaction is a context-build concern, and a
 * "summarizing…" artifact must never land in Slack or the web chat as a
 * conversation message.
 */

import { EventEmitter } from 'node:events';
import { generateText, type LanguageModel, type ModelMessage, type SystemModelMessage, type Tool } from 'ai';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { MAX_OUTPUT_TOKENS } from '../constants';
import { COMPACTION_PROMPT } from '../prompts/compaction-prompt';
import { MIN_PLAUSIBLE_CONTEXT } from '../lib/model-catalog';
import { createProvider } from '../lib/llm-providers/create-provider';
import type { CachePointFragment } from '../lib/llm-providers/llm-provider';

import { collectTools, withToolsCacheControl } from '../lib/tool-collection';
import { withOutputLimits } from '../lib/tool-output-limiter';
import type { Invoker } from '../lib/task-tool';
import { buildSystemPromptParts, buildConversationMessages } from '../prompts/context-builder';
import { getTaskToolInstructions } from '../prompts/task-tool-prompt';
import { isContextOverflowError } from '../lib/llm-errors';
import { resolveEffectiveModel } from './agent-workspace.service';
import { contextService } from './context.service';
import { contextUsageService, type ContextUsageSnapshot } from './context-usage.service';
import { threadTurnService } from './thread-turn.service';
import { trackEvent, langfuseTelemetry } from '../lib/telemetry';

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
  /** For the post-compaction size estimate (~4 chars/token). */
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
  /** cachedSystem — cache breakpoints included. */
  system: SystemModelMessage[];
  /** cachedTools — sent with toolChoice 'none' to keep the tools cache segment. */
  tools: Record<string, Tool>;
  /** History as sent, summary pair included. */
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
}

interface FinishInput {
  userId: string;
  agentId: string;
  threadId: string;
  trigger: 'auto' | 'manual';
  /** Telemetry-only refinement of `trigger`: what actually fired the job. */
  reason: 'threshold' | 'overflow' | 'manual';
  modelId: string;
  threadSource: string;
  tokensBefore: number | null;
  summary: string;
  rows: ForkRow[];
  messagesCompacted: number;
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
      if (fork.contextRows.length <= config.compactionTailMessages) return; // nothing meaningful
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
        .finally(() => this.inFlight.delete(fork.threadId));
    } catch (err) {
      this.inFlight.delete(fork.threadId);
      logger.error({ err, threadId: fork.threadId }, '[Compaction] auto-compaction enqueue failed');
    }
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
      if (fork.contextRows.length <= config.compactionTailMessages) return;
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
        .finally(() => this.inFlight.delete(fork.threadId));
    } catch (err) {
      this.inFlight.delete(fork.threadId);
      logger.error({ err, threadId: fork.threadId }, '[Compaction] overflow compaction enqueue failed');
    }
  }

  /**
   * Manual path (`/compact` → REST). Rebuilds the context fresh under the
   * thread mutex; the provider cache miss is accepted — there is no live turn
   * to fork from.
   */
  async compactNow(input: { userId: string; agentId: string; threadId: string }): Promise<void> {
    const { userId, agentId, threadId } = input;
    if (this.inFlight.has(threadId)) return; // one already queued/running is enough
    this.inFlight.add(threadId);
    try {
      await threadTurnService.run(threadId, async () => {
        this.start(userId, agentId, threadId, 'manual');

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
        if (rows.length <= config.compactionTailMessages) {
          // A no-op, not a failure: the REST precheck counts DB rows while this
          // counts the context view (attachFiles drops empty rows), so a thread
          // at the tail boundary can pass the 409 gate and land here.
          this.skip(userId, agentId, threadId, 'manual', 'Nothing to compact yet.');
          return;
        }

        const modelId = resolveEffectiveModel(context.model);
        const provider = createProvider();
        const model = provider(modelId);
        const cachePoint = provider.cachePoint;

        // Same tool set as a chat turn, sent with toolChoice 'none': the tools
        // block must match byte-for-byte or the request misses the
        // tools+stable-system cache prefix chat turns keep warm. The Task
        // invoker can never run under toolChoice 'none'.
        const { tools, subagents } = await collectTools({
          userId,
          agentId,
          threadId,
          mode: 'chat',
          workspaceRoot: thread?.workspaceRoot ?? undefined,
          taskInvoker: neverInvoke,
          lockedIn: context.lockedIn,
        });
        const cachedTools = withToolsCacheControl(withOutputLimits(tools), cachePoint);

        const systemParts = await buildSystemPromptParts(
          context,
          'chat',
          undefined,
          '',
          thread?.workspaceRoot ?? undefined,
        );
        // Mirror invoke.ts: task-tool instructions ride the stable part, and
        // cacheable parts carry the Anthropic breakpoints — without them this
        // request neither reads nor refreshes the shared prefix.
        const stablePart = systemParts.find((p) => p.cacheable);
        if (subagents.length > 0 && stablePart) {
          stablePart.text += '\n\n' + getTaskToolInstructions(
            subagents.map((s) => ({ name: s.name, description: s.description })),
          );
        }
        const system: SystemModelMessage[] = systemParts.map((part) => ({
          role: 'system' as const,
          content: part.text,
          ...(part.cacheable ? { providerOptions: cachePoint } : {}),
        }));
        const messages: ModelMessage[] = [
          ...buildConversationMessages(context),
          { role: 'user' as const, content: COMPACTION_PROMPT, providerOptions: cachePoint },
        ];

        const result = await generateText({
          model,
          system,
          messages,
          ...(Object.keys(cachedTools).length > 0
            ? { tools: cachedTools, toolChoice: 'none' as const }
            : {}),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...langfuseTelemetry('compaction', { userId, sessionId: threadId }),
        });
        const summary = result.text.trim();
        if (!summary) {
          this.fail(userId, agentId, threadId, 'manual', 'The model returned an empty summary.');
          return;
        }

        const { messagesCompacted } = await this.commit(threadId, summary, rows);
        await this.finish({
          userId,
          agentId,
          threadId,
          trigger: 'manual',
          reason: 'manual',
          modelId,
          threadSource: thread?.threadSource ?? 'DATABASE',
          tokensBefore: thread?.contextTokens ?? null,
          summary,
          rows,
          messagesCompacted,
        });
      });
    } catch (err) {
      logger.error({ err, threadId }, '[Compaction] manual compaction failed');
      this.fail(userId, agentId, threadId, 'manual', errorText(err));
    } finally {
      this.inFlight.delete(threadId);
    }
  }

  /**
   * Cheap REST precheck. Counts DB rows, which is right for DATABASE threads;
   * Slack threads pass through (their history lives in Slack, and compactNow's
   * own row check covers them).
   */
  async hasCompactableHistory(threadId: string): Promise<boolean> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { threadSource: true },
    });
    // Channel-backed threads pass through — their history lives in the
    // channel, not in DB rows, so a row count says nothing about them.
    if (thread?.threadSource !== 'DATABASE') return true;
    const uncompacted = await prisma.conversationMessage.count({
      where: { threadId, isCompacted: false },
    });
    return uncompacted > config.compactionTailMessages;
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
      // re-prefilled at full price. Budget: 2 system + 1 tools + this = 4,
      // exactly Bedrock's breakpoint limit.
      const messages: ModelMessage[] = [
        ...fork.messages,
        ...fork.injections,
        // An empty assistant block would be rejected by the provider; a turn
        // can end with no visible text (rare), in which case the last real
        // message already closes the exchange.
        ...(assistantText ? [{ role: 'assistant' as const, content: assistantText }] : []),
        { role: 'user' as const, content: COMPACTION_PROMPT, providerOptions: fork.cachePoint },
      ];

      const result = await generateText({
        model: fork.model,
        system: fork.system,
        messages,
        tools: Object.keys(fork.tools).length > 0 ? fork.tools : undefined,
        // Keeps the tools segment of the cached prefix byte-identical to the
        // turn's own request while forbidding tool use in the summary call.
        toolChoice: 'none',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        ...langfuseTelemetry('compaction', { userId, sessionId: threadId }),
      });
      const summary = result.text.trim();
      if (!summary) {
        this.fail(userId, agentId, threadId, 'auto', 'The model returned an empty summary.');
        return;
      }

      const thread = await prisma.conversationThread.findUnique({
        where: { id: threadId },
        select: { threadSource: true },
      });
      const { messagesCompacted } = await this.commit(threadId, summary, fork.contextRows);
      await this.finish({
        userId,
        agentId,
        threadId,
        trigger: 'auto',
        reason: 'threshold',
        modelId: fork.modelId,
        threadSource: thread?.threadSource ?? 'DATABASE',
        tokensBefore: fork.snapshot.usedTokens,
        summary,
        rows: fork.contextRows,
        messagesCompacted,
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
   * price of unsticking a thread that otherwise rejects forever.
   */
  private async runOverflowCompaction(fork: CompactionFork): Promise<void> {
    const { userId, agentId, threadId } = fork;
    try {
      this.start(userId, agentId, threadId, 'auto');

      let history: ModelMessage[] = [...fork.messages, ...fork.injections];
      let summary = '';
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
          const result = await generateText({
            model: fork.model,
            system: fork.system,
            messages: [
              ...history,
              { role: 'user' as const, content: COMPACTION_PROMPT, providerOptions: fork.cachePoint },
            ],
            tools: Object.keys(fork.tools).length > 0 ? fork.tools : undefined,
            toolChoice: 'none',
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            ...langfuseTelemetry('compaction', { userId, sessionId: threadId }),
          });
          summary = result.text.trim();
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
      if (!summary) {
        this.fail(userId, agentId, threadId, 'auto', 'The model returned an empty summary.');
        return;
      }

      const thread = await prisma.conversationThread.findUnique({
        where: { id: threadId },
        select: { threadSource: true, contextTokens: true },
      });
      const { messagesCompacted } = await this.commit(threadId, summary, fork.contextRows);
      await this.finish({
        userId,
        agentId,
        threadId,
        trigger: 'auto',
        reason: 'overflow',
        modelId: fork.modelId,
        threadSource: thread?.threadSource ?? 'DATABASE',
        tokensBefore: thread?.contextTokens ?? null,
        summary,
        rows: fork.contextRows,
        messagesCompacted,
      });
    } catch (err) {
      logger.error({ err, threadId }, '[Compaction] overflow compaction failed');
      this.fail(userId, agentId, threadId, 'auto', errorText(err));
    }
  }

  /**
   * Persist one compaction: the summary + watermark on the thread and the
   * `isCompacted` flags on exactly `rows` minus the tail, in one transaction —
   * a summarizer that produced nothing writes nothing.
   *
   * DATABASE threads: row flags are authoritative; the watermark is stored as
   * the newest compacted row's createdAt ISO for observability. SLACK threads:
   * the watermark (max Slack ts among compacted rows) is authoritative and only
   * the interleaved internal-step DB rows get flags — Slack-derived rows have
   * synthesized hash ids that match nothing in the DB.
   */
  private async commit(
    threadId: string,
    summary: string,
    rows: ForkRow[],
  ): Promise<{ messagesCompacted: number }> {
    const tail = config.compactionTailMessages;
    // slice(0, -0) would be empty — tail 0 means "compact everything".
    const compactable = tail > 0 ? rows.slice(0, -tail) : rows;
    if (compactable.length === 0) return { messagesCompacted: 0 };

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
    } else {
      const ids = compactable.map((r) => r.id);
      const newest = await prisma.conversationMessage.findFirst({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      await prisma.$transaction([
        prisma.conversationMessage.updateMany({
          where: { id: { in: ids } },
          data: { isCompacted: true },
        }),
        prisma.conversationThread.update({
          where: { id: threadId },
          data: {
            compactionSummary: summary,
            compactedAt: new Date(),
            compactedThroughTs: newest?.createdAt.toISOString() ?? null,
          },
        }),
      ]);
    }

    logger.info(
      `[Compaction] compacted ${compactable.length} message(s) in thread ${threadId} (${summary.length} chars of summary)`,
    );
    return { messagesCompacted: compactable.length };
  }

  /** Shared completion: meter estimate, completed event, finished telemetry. */
  private async finish(input: FinishInput): Promise<void> {
    const tail = config.compactionTailMessages;
    const tailRows = tail > 0 ? input.rows.slice(-tail) : [];
    const tailChars = tailRows.reduce((n, r) => n + r.contentChars, 0);
    // ~4 chars/token over the rebuilt context (summary pair + verbatim tail).
    // Undershoots — the system prompt and tools aren't counted — and
    // self-corrects on the next turn's provider-reported usage.
    const estimatedTokens = Math.ceil((input.summary.length + tailChars) / 4);

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

function toForkRows(
  messages: Array<{ id: string; externalMessageId?: string | null; internalStep?: boolean; content: string }>,
): ForkRow[] {
  return messages.map((m) => ({
    id: m.id,
    externalMessageId: m.externalMessageId ?? null,
    internalStep: m.internalStep ?? false,
    contentChars: m.content.length,
  }));
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
 * providers reject. Returns null when nothing meaningful would remain.
 */
function shrinkHistoryHead(history: ModelMessage[]): ModelMessage[] | null {
  const drop = Math.max(1, Math.ceil(history.length / 4));
  const shrunk = history.slice(drop);
  while (shrunk.length > 0 && shrunk[0].role !== 'user') shrunk.shift();
  return shrunk.length >= 1 && shrunk.length < history.length ? shrunk : null;
}

export const compactionService = new CompactionService();
