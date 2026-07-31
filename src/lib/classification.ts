/**
 * Classification-gate model factory.
 *
 * Goes through the unified `createProvider()`, so it inherits whatever vendor
 * and routing (direct or Nexus) the runtime is configured for. The classifier
 * uses a fast model (`classificationModelId`) supported on either provider.
 *
 * Kept in its own module (rather than in `create-provider.ts`) so the provider
 * factories never transitively import `create-provider`, keeping that a leaf
 * factory with no import cycle.
 */

import type { LanguageModel } from 'ai';
import { config } from '../config';
import { createProvider } from './llm-providers/create-provider';
import type { ProviderOptionsFragment } from './llm-providers/llm-provider';

export function getClassificationModel() {
  return createProvider()(config.classificationModelId);
}

/**
 * Everything a structured-output (`generateObject`) classification call needs:
 * the model, and the active vendor's `providerOptions` — empty when it needs
 * nothing special.
 *
 * Both come from **one** `createProvider()`. That matters: the factory is not a
 * cheap accessor. On Bedrock it builds a fresh AWS credential-provider chain
 * and instantiates two SDK clients, so resolving the model and the options
 * separately would pay that twice on what is a per-message hot path.
 *
 * Callers take `providerOptions` as given rather than naming a vendor: which
 * platforms reject the SDK's native structured-output path is the provider's
 * business, not theirs.
 */
export function getClassificationRequest(): {
  model: LanguageModel;
  providerOptions: ProviderOptionsFragment;
} {
  const provider = createProvider();
  return {
    model: provider(config.classificationModelId),
    providerOptions: provider.structuredOutputOptions ?? {},
  };
}
