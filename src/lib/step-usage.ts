/**
 * Reading a model call's token usage, and adding several together.
 *
 * `toStepUsage` normalizes what a provider reported into the shape the runtime
 * stores and sums; `services/llm-call.service.ts` writes one row per call from
 * it, and `foldStepUsage` adds a turn's steps up for the invocation total the
 * goal loop meters its budget against.
 *
 * Summing across steps counts the prompt once per step, which is what the
 * provider bills: each agentic step resends the conversation. Context occupancy
 * is `services/context-usage.service.ts`, from the latest step alone.
 */

import type { LanguageModelUsage } from 'ai';
import type { StepUsage } from '../types';

/**
 * Convert one model call's SDK usage into the shape that gets stored.
 *
 * Returns nothing only when the provider reported neither a prompt size nor a
 * total. Either figure alone is enough to keep: the goal loop meters its budget
 * against `totalTokens`, so discarding a partial report would leave it counting
 * zero for ever.
 *
 * The three cache details fall back to 0 where the provider omits them, which a
 * reader distinguishes from a real zero by their sum (see
 * `services/llm-usage.service.ts`).
 */
export function toStepUsage(
  model: string,
  usage: LanguageModelUsage | undefined,
): StepUsage | undefined {
  if (typeof usage?.inputTokens !== 'number' && typeof usage?.totalTokens !== 'number') {
    return undefined;
  }

  const details = usage.inputTokenDetails;

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  return {
    model,
    // The provider's own total where it gives one, so a vendor that counts
    // something the split leaves out still adds up here.
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens: details?.cacheReadTokens ?? 0,
    cacheWriteTokens: details?.cacheWriteTokens ?? 0,
    noCacheTokens: details?.noCacheTokens ?? 0,
  };
}

/**
 * Add up several steps' usage. Returns undefined for an empty list.
 *
 * The model is taken from the first entry: an invocation runs one model, and a
 * per-agent override changes between invocations, not within one.
 */
export function foldStepUsage(steps: StepUsage[]): StepUsage | undefined {
  if (steps.length === 0) return undefined;

  return steps.reduce(
    (acc, s) => ({
      model: acc.model,
      totalTokens: acc.totalTokens + s.totalTokens,
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + s.cacheWriteTokens,
      noCacheTokens: acc.noCacheTokens + s.noCacheTokens,
    }),
    {
      ...steps[0],
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
    },
  );
}
