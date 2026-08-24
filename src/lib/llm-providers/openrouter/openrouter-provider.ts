/**
 * OpenRouter Provider for Vercel AI SDK
 *
 * OpenRouter is not a fifth cloud but a reseller: one credential reaches
 * hundreds of models across dozens of vendors. Its API is OpenAI-compatible,
 * so the provider object comes from `../openai-compatible` — the same
 * Responses dispatcher, embeddings client, cache-point fragment and
 * classification knobs the OpenAI provider uses. Its own factory rather than a
 * flag on that one, so the startup log names who is actually serving the call
 * and either vendor can diverge without disturbing the other.
 *
 *
 * What is OpenRouter-specific lives here:
 *
 *  - **The mount.** `…/llm/openrouter/openai/v1`, not `…/llm/openai/v1`. That
 *    distinction is the point: the managed-inference gate compares the path's
 *    backend against the one the project's policy selected and answers 403 on
 *    a mismatch, so borrowing the openai mount fails every call.
 *  - **Model ids are `vendor/model`** (see `config.openrouterModelId`), so the
 *    bare ids that are correct against api.openai.com are not ones OpenRouter
 *    can route.
 *  - **Gateway only** (see `isOpenRouterConfigured`).
 *
 * Auth: none locally. The gateway holds the OpenRouter credential and injects
 * it on the outbound leg; the SDK still insists on a key, so it gets the same
 * decoy the Azure and mantle factories use.
 */

import { config } from '../../../config';
import { logger } from '../../../logger';
import { createOpenAiCompatibleProvider } from '../openai-compatible';
import type { LlmProvider } from '../llm-provider';

export function createOpenRouterProvider(baseURL?: string): LlmProvider {
  logger.info({ routing: baseURL ? 'nexus' : 'direct' }, 'Creating OpenRouter provider');

  return createOpenAiCompatibleProvider({
    // Always a decoy: there is no direct OpenRouter path (see below), so no
    // local credential exists to send.
    apiKey: 'nexus-managed',
    baseURL,
  });
}

/**
 * Whether OpenRouter can serve requests.
 *
 * Requires the gateway mount, not merely a key: the gateway is what holds the
 * OpenRouter credential, and a sandbox is never given one. Talking to
 * openrouter.ai directly would also be unmetered spend that the sandbox's
 * egress policy normally denies, so "configured" here means "routed through
 * the gateway".
 */
export function isOpenRouterConfigured(): boolean {
  if (!config.openrouterModelId) return false;
  return Boolean(config.nexusOpenRouterBaseUrl);
}
