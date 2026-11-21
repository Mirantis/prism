/**
 * Records what every model call cost: one row per call, written when the call
 * returns, so a suppressed heartbeat and a compaction are counted along with a
 * published turn. Writes are fire-and-forget and fail soft — an accounting
 * error costs a log line, and the turn that made the call carries on.
 *
 * Each row has its estimated cost (`lib/model-pricing.ts`), and the request and
 * thread from the spend context (`lib/spend-context.ts`) where the caller names none.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { toStepUsage } from '../lib/step-usage';
import { costMicroUsd, priceFor, type PricedTokens } from '../lib/model-pricing';
import type { ModelPrice } from '../lib/model-catalog';
import { cacheTtlFor } from '../lib/llm-providers/llm-provider';
import { currentSpendContext, type SpendSource } from '../lib/spend-context';
import type { LanguageModelUsage } from 'ai';
import type { ChatPlatform } from './channel-adapter.interface';

/**
 * What a call was for: an invoke mode, or a named side call.
 *
 * A union rather than a free string so a new call site has to name itself, and
 * so the set stays greppable when someone asks where the tokens went.
 */
export type LlmCallPurpose =
  // Invoke modes — `InvokeRequest.mode`, recorded per model step.
  | 'chat'
  | 'heartbeat'
  | 'cron'
  | 'goal'
  | 'webhook'
  | 'subagent'
  // Side calls, each one `generateText`/`generateObject` outside the invoke loop.
  | 'early-stopping'
  | 'compaction'
  | 'thread-title'
  | 'feedback-gate'
  | 'goal-gate'
  | 'risk-gate'
  | 'model-routing'
  | 'agent-voice'
  // The usage a coding agent's CLI reported for a task.
  | 'coding-agent'
  // Realtime voice sessions, one row per response or transcription.
  | 'voice-chat'
  | 'meeting'
  | 'dictation'
  // A chat platform's thread reply classifier, named for the platform.
  | `${ChatPlatform}-thread-gate`;

/**
 * Every fixed purpose, so a test can assert the union and the recorders agree.
 * A value here with no recorder is spend nobody is counting.
 */
export const LLM_CALL_PURPOSES: readonly LlmCallPurpose[] = [
  'chat',
  'heartbeat',
  'cron',
  'goal',
  'webhook',
  'subagent',
  'early-stopping',
  'compaction',
  'thread-title',
  'feedback-gate',
  'goal-gate',
  'risk-gate',
  'model-routing',
  'agent-voice',
  'coding-agent',
  'voice-chat',
  'meeting',
  'dictation',
];

/** Which models a call's spend goes to: the agent's own, the coding agent's, or the voice models. */
export type SpendKind = 'main' | 'coding-agent' | 'voice';

const VOICE_PURPOSES: readonly string[] = ['voice-chat', 'meeting', 'dictation'];

/** The purposes whose calls are not the agent's own model's. */
export const OTHER_MODEL_PURPOSES: readonly LlmCallPurpose[] = ['coding-agent', 'voice-chat', 'meeting', 'dictation'];

export function spendKindOf(purpose: string): SpendKind {
  if (purpose === 'coding-agent') return 'coding-agent';
  return VOICE_PURPOSES.includes(purpose) ? 'voice' : 'main';
}

/** One call's tokens, in the columns `llm_calls` stores. */
export interface CallTokens {
  totalTokens: number;
  /** The whole prompt, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  /** The part of `cacheWriteTokens` written with the one-hour lifetime. Priced, not stored. */
  longCacheWriteTokens?: number;
  /** The audio part of `noCacheTokens`. */
  audioInputTokens?: number;
  /** The audio part of `outputTokens`. */
  audioOutputTokens?: number;
}

interface RecordContext {
  purpose: LlmCallPurpose;
  /** The model id the call went to. */
  model: string;
  /** The thread this call belongs to, where it has one. Defaults to the spend context's. */
  threadId?: string;
  /** The request this call served. Defaults to the spend context's. */
  requestId?: string;
  /** What started the request. Defaults to the spend context's. */
  source?: SpendSource;
  /**
   * The agent the call ran for. Omit for the runtime's own work; pass the
   * invoked agent where a turn may belong to a subagent, and the row records it
   * as provenance while the spend still lands on the owner.
   */
  agentId?: string;
}

interface RecordInput extends RecordContext {
  /**
   * What the provider reported. Undefined is still recorded, as a row with zero
   * counts: the call happened, and its cost was not reported.
   */
  usage: LanguageModelUsage | undefined;
}

interface RecordTokensInput extends RecordContext {
  /** Undefined is recorded as a row with zero counts and no cost. */
  tokens: CallTokens | undefined;
  /** The call ran on a subscription, which bills no tokens: its cost is zero. */
  subscription?: boolean;
  /** A cost in US dollars that the caller's tool reported, used when the catalog has no price for the model. */
  reportedCostUsd?: number;
}

/** A 15-minute bucket, the grain `llm_calls.bucket` stores. */
const BUCKET_MS = 15 * 60 * 1000;

/** Rows priced per transaction when calls recorded without a price are priced again. */
const PRICING_BATCH = 200;

/**
 * The tokens to price. Where the caller does not split the cache writes by lifetime,
 * they have the lifetime the call's mode asks for (`cacheTtlFor`). A row priced again
 * later has no split stored, so it takes that lifetime too.
 */
function pricedTokens(purpose: string, tokens: CallTokens): PricedTokens {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    longCacheWriteTokens: tokens.longCacheWriteTokens ?? (cacheTtlFor(purpose) === '1h' ? tokens.cacheWriteTokens : 0),
    audioInputTokens: tokens.audioInputTokens ?? 0,
    audioOutputTokens: tokens.audioOutputTokens ?? 0,
  };
}

function catalogCost(price: ModelPrice, purpose: string, tokens: CallTokens): number {
  return costMicroUsd(price, pricedTokens(purpose, tokens));
}

function costOf(input: RecordTokensInput): { costMicroUsd: number | null; costSource: string | null } {
  if (input.subscription) return { costMicroUsd: 0, costSource: 'subscription' };
  const price = priceFor(input.model);
  if (price && input.tokens) return { costMicroUsd: catalogCost(price, input.purpose, input.tokens), costSource: 'catalog' };
  if (input.reportedCostUsd !== undefined && Number.isFinite(input.reportedCostUsd)) {
    return { costMicroUsd: Math.round(input.reportedCostUsd * 1_000_000), costSource: 'reported' };
  }
  return { costMicroUsd: null, costSource: null };
}

class LlmCallService {
  /**
   * The newest call recorded on a thread with one of `purposes`, or null when
   * there is none. A read for the caller's own decision, so a failed read is
   * logged and returns null.
   */
  async newestThreadCall(
    threadId: string,
    purposes: readonly LlmCallPurpose[],
  ): Promise<{ purpose: string; model: string; createdAt: Date } | null> {
    const owner = config.agentId;
    if (!owner) return null;
    try {
      return await prisma.llmCall.findFirst({
        where: { agentId: owner, threadId, purpose: { in: [...purposes] } },
        orderBy: { createdAt: 'desc' },
        select: { purpose: true, model: true, createdAt: true },
      });
    } catch (err) {
      logger.warn({ err, threadId }, '[LlmCall] failed to read a thread\'s newest call');
      return null;
    }
  }

  /**
   * Record one model call the AI SDK made.
   *
   * Returns immediately: the insert runs in the background so no call site
   * waits on it.
   *
   * A call the provider reported no usage for still gets a row, with zero
   * counts. The count of rows is what the page calls "model calls", so dropping
   * one would undercount the calls to keep the tokens tidy — and zero tokens is
   * the honest record of a call whose cost the provider did not report.
   */
  record(input: RecordInput): void {
    const { usage, ...context } = input;
    const step = toStepUsage(input.model, usage);
    this.recordTokens({ ...context, model: step?.model ?? input.model, tokens: step });
  }

  /** Record one call whose tokens the caller read itself, such as a CLI's or a Realtime session's. */
  recordTokens(input: RecordTokensInput): void {
    // The owner pays, whoever ran the call. Filtering reads on this one column
    // keeps a past window's total from moving when a subagent link changes.
    const owner = config.agentId;
    if (!owner) return;

    const spend = currentSpendContext();
    const source = input.source ?? spend?.source;
    const ranFor = input.agentId && input.agentId !== owner ? input.agentId : null;
    const tokens = input.tokens;
    const now = Date.now();

    // The whole call is guarded, not just the promise: a synchronous throw here
    // — a client that is not what we assume, a serialization error — would
    // otherwise propagate into the turn that made the model call.
    try {
      void prisma.llmCall
        .create({
          data: {
            agentId: owner,
            subagentId: ranFor,
            purpose: input.purpose,
            model: input.model,
            threadId: input.threadId ?? spend?.threadId ?? null,
            requestId: input.requestId ?? spend?.requestId ?? null,
            sourceKind: source?.kind ?? null,
            sourceId: source?.id ?? null,
            totalTokens: tokens?.totalTokens ?? 0,
            inputTokens: tokens?.inputTokens ?? 0,
            outputTokens: tokens?.outputTokens ?? 0,
            cacheReadTokens: tokens?.cacheReadTokens ?? 0,
            cacheWriteTokens: tokens?.cacheWriteTokens ?? 0,
            noCacheTokens: tokens?.noCacheTokens ?? 0,
            audioInputTokens: tokens?.audioInputTokens ?? 0,
            audioOutputTokens: tokens?.audioOutputTokens ?? 0,
            ...costOf(input),
            createdAt: new Date(now),
            bucket: new Date(now - (now % BUCKET_MS)),
          },
        })
        .catch((err) => {
          logger.error({ err, purpose: input.purpose }, '[LlmCall] failed to record a model call');
        });
    } catch (err) {
      logger.error({ err, purpose: input.purpose }, '[LlmCall] failed to record a model call');
    }
  }

  /**
   * Price the calls recorded without a price whose model the catalog now prices.
   * A call the provider reported no tokens for stays unpriced. Never rejects: a
   * failure is logged, and the next catalog install tries again.
   */
  async priceUnpricedCalls(): Promise<void> {
    const owner = config.agentId;
    if (!owner) return;
    try {
      const models = await prisma.llmCall.groupBy({
        by: ['model'],
        where: { agentId: owner, costMicroUsd: null, totalTokens: { gt: 0 } },
      });
      let priced = 0;
      for (const { model } of models) {
        const price = priceFor(model);
        if (price) priced += await this.priceModel(owner, model, price);
      }
      if (priced > 0) logger.info(`[LlmCall] priced ${priced} model call(s) recorded without a price`);
    } catch (err) {
      logger.warn({ err }, '[LlmCall] failed to price the calls recorded without a price');
    }
  }

  private async priceModel(owner: string, model: string, price: ModelPrice): Promise<number> {
    let priced = 0;
    for (;;) {
      const rows = await prisma.llmCall.findMany({
        where: { agentId: owner, model, costMicroUsd: null, totalTokens: { gt: 0 } },
        take: PRICING_BATCH,
        select: {
          id: true,
          purpose: true,
          totalTokens: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          noCacheTokens: true,
          audioInputTokens: true,
          audioOutputTokens: true,
        },
      });
      if (rows.length === 0) return priced;
      await prisma.$transaction(
        rows.map(({ id, purpose, ...tokens }) =>
          prisma.llmCall.update({
            where: { id },
            data: { costMicroUsd: catalogCost(price, purpose, tokens), costSource: 'catalog' },
          }),
        ),
      );
      priced += rows.length;
    }
  }
}

export const llmCallService = new LlmCallService();
