/**
 * Records what every model call cost: one row per call, written when the call
 * returns, so a suppressed heartbeat and a compaction are counted along with a
 * published turn. Writes are fire-and-forget and fail soft — an accounting
 * error costs a log line, and the turn that made the call carries on.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { toStepUsage } from '../lib/step-usage';
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
  | 'delivery-gate'
  | 'feedback-gate'
  | 'goal-gate'
  | 'risk-gate'
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
  'delivery-gate',
  'feedback-gate',
  'goal-gate',
  'risk-gate',
];

interface RecordInput {
  purpose: LlmCallPurpose;
  /** The model id the call went to. */
  model: string;
  /**
   * What the provider reported. Undefined is still recorded, as a row with zero
   * counts: the call happened, and its cost was not reported.
   */
  usage: LanguageModelUsage | undefined;
  /** The thread this call belongs to, where it has one. */
  threadId?: string;
  /**
   * The agent the call ran for. Omit for the runtime's own work; pass the
   * invoked agent where a turn may belong to a subagent, and the row records it
   * as provenance while the spend still lands on the owner.
   */
  agentId?: string;
}

class LlmCallService {
  /**
   * Record one model call.
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
    // The owner pays, whoever ran the call. Filtering reads on this one column
    // keeps a past window's total from moving when a subagent link changes.
    const owner = config.agentId;
    if (!owner) return;

    const usage = toStepUsage(input.model, input.usage);
    const ranFor = input.agentId && input.agentId !== owner ? input.agentId : null;

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
            model: usage?.model ?? input.model,
            threadId: input.threadId ?? null,
            totalTokens: usage?.totalTokens ?? 0,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
            noCacheTokens: usage?.noCacheTokens ?? 0,
          },
        })
        .catch((err) => {
          logger.error({ err, purpose: input.purpose }, '[LlmCall] failed to record a model call');
        });
    } catch (err) {
      logger.error({ err, purpose: input.purpose }, '[LlmCall] failed to record a model call');
    }
  }
}

export const llmCallService = new LlmCallService();
