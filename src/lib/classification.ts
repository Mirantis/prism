/**
 * Classification-gate model factory.
 *
 * Goes through the unified `createProvider()`, so it inherits whatever vendor
 * and routing (direct or gateway) the runtime is configured for. The classifier
 * uses a fast model (`classificationModelId`) supported on either provider.
 *
 * Kept in its own module (rather than in `create-provider.ts`) so the provider
 * factories never transitively import `create-provider`, keeping that a leaf
 * factory with no import cycle.
 */

import type { LanguageModel } from 'ai';
import { config } from '../config';
import { createProvider } from './llm-providers/create-provider';
import { mergeProviderOptions, type ProviderOptionsFragment } from './llm-providers/llm-provider';

/**
 * Everything a plain-text (`generateText`) gate call needs: the model, and
 * the active vendor's classification `providerOptions` — empty when the
 * model's defaults already suit the gates.
 *
 * Both come from **one** `createProvider()`. That matters: the factory is not a
 * cheap accessor. On Bedrock it builds a fresh AWS credential-provider chain
 * and instantiates two SDK clients, so resolving the model and the options
 * separately would pay that twice on what is a per-message hot path.
 *
 * Callers take `providerOptions` as given rather than naming a vendor: that
 * a GPT-5.x classification model needs reasoning pinned off for the gates'
 * `temperature: 0` and tiny token budgets to hold is the provider's business,
 * not theirs.
 */
export function getGateRequest(): {
  model: LanguageModel;
  providerOptions: ProviderOptionsFragment;
  /**
   * Smallest legal `maxOutputTokens` on the active vendor (0 = any). Most
   * gates simply cap at 16 — the highest floor any vendor has — but a
   * latency-tuned site can take `Math.max(itsCap, minOutputTokens)` to keep
   * a tighter cap where that is legal.
   */
  minOutputTokens: number;
  /**
   * Spread into the call where `temperature: 0` used to be hardcoded:
   * deterministic verdicts on the vendors that accept the param, omitted
   * entirely on the ones that reject or strip it.
   */
  samplingParams: { temperature?: number };
} {
  const provider = createProvider();
  return {
    model: provider(config.classificationModelId),
    providerOptions: provider.classificationProviderOptions ?? {},
    minOutputTokens: provider.classificationMinOutputTokens ?? 0,
    samplingParams: provider.classificationSamplingParams ?? { temperature: 0 },
  };
}

/**
 * Everything a structured-output (`generateObject`) classification call needs:
 * the model, and the active vendor's `providerOptions` — the classification
 * options (see `getGateRequest`) plus whatever the vendor needs for
 * structured output specifically (some platforms reject the SDK's native
 * path — which ones is the provider's business, not the caller's).
 */
export function getClassificationRequest(): {
  model: LanguageModel;
  providerOptions: ProviderOptionsFragment;
  /** See `getGateRequest().samplingParams` — same contract. */
  samplingParams: { temperature?: number };
} {
  const provider = createProvider();
  return {
    model: provider(config.classificationModelId),
    providerOptions: mergeProviderOptions(
      provider.classificationProviderOptions,
      provider.structuredOutputOptions,
    ),
    samplingParams: provider.classificationSamplingParams ?? { temperature: 0 },
  };
}
