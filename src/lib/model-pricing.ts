/**
 * What a model call cost, estimated from its token counts and the model's prices
 * in the catalog (`lib/model-catalog.ts`).
 *
 * A price is US dollars per million tokens, so a token count times a price is a
 * cost in millionths of a dollar, the unit `llm_calls.costMicroUsd` stores.
 */

import { findCatalogEntry, type ModelPrice } from './model-catalog';

/** One call's tokens, as `llm_calls` stores them. */
export interface PricedTokens {
  /** The whole prompt, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` written with the one-hour lifetime, whose price the registry does not list. */
  longCacheWriteTokens: number;
  /** The audio part of the uncached prompt. */
  audioInputTokens: number;
  /** The audio part of the output. */
  audioOutputTokens: number;
}

/** The price of a cache write with the one-hour lifetime, as a multiple of the input price. */
const LONG_CACHE_WRITE_FACTOR = 2;

/** The catalog's price for `modelId`, or null when it lists none. */
export function priceFor(modelId: string): ModelPrice | null {
  return findCatalogEntry(modelId)?.cost ?? null;
}

/** The cost of one call at `price`, in millionths of a dollar. */
export function costMicroUsd(price: ModelPrice, tokens: PricedTokens): number {
  // The highest tier whose threshold the prompt is above.
  const tier = price.tiers?.filter((t) => tokens.inputTokens > t.above).at(-1);
  const input = tier?.input ?? price.input;
  const output = tier?.output ?? price.output;
  const cacheRead = tier?.cacheRead ?? price.cacheRead ?? input;
  const cacheWrite = tier?.cacheWrite ?? price.cacheWrite ?? input;
  const longCacheWrites = Math.min(tokens.longCacheWriteTokens, tokens.cacheWriteTokens);

  const uncached = Math.max(0, tokens.inputTokens - tokens.cacheReadTokens - tokens.cacheWriteTokens);
  const textInput = Math.max(0, uncached - tokens.audioInputTokens);
  const textOutput = Math.max(0, tokens.outputTokens - tokens.audioOutputTokens);

  return Math.round(
    textInput * input +
    tokens.audioInputTokens * (price.inputAudio ?? input) +
    tokens.cacheReadTokens * cacheRead +
    (tokens.cacheWriteTokens - longCacheWrites) * cacheWrite +
    longCacheWrites * input * LONG_CACHE_WRITE_FACTOR +
    textOutput * output +
    tokens.audioOutputTokens * (price.outputAudio ?? output)
  );
}
