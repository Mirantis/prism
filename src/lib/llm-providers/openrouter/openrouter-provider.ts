/**
 * OpenRouter Provider for Vercel AI SDK
 *
 * OpenRouter is not a fifth cloud but a reseller: one credential reaches
 * hundreds of models across dozens of vendors, which makes it the shortest
 * path to a running agent — no cloud account, no IAM, no region. Its API is
 * OpenAI-compatible (it serves `/responses` alongside `/chat/completions`), so
 * the provider object comes from `../openai-compatible` — the same Responses
 * dispatcher, cache-point fragment and classification declarations the OpenAI
 * provider uses. Its own factory rather than a flag on that one, so the
 * startup log names who is actually serving the call and either vendor can
 * diverge without disturbing the other.
 *
 * What is OpenRouter-specific lives here:
 *
 *  - **The endpoint.** Direct that is `https://openrouter.ai/api/v1` — spelled
 *    out because the SDK's own default is api.openai.com, which is not where
 *    these model ids resolve. Through the gateway it is
 *    `…/llm/openrouter/openai/v1`, *not* `…/llm/openai/v1`: the
 *    managed-inference gate compares the path's backend against the one the
 *    project's policy selected and answers 403 on a mismatch, so borrowing the
 *    openai mount fails every call.
 *  - **Model ids are `vendor/model`** (see `config.openrouterModelId`), so the
 *    bare ids that are correct against api.openai.com are not ones OpenRouter
 *    can route.
 *
 * Auth: `OPENROUTER_API_KEY`, sent as a bearer header, read verbatim so it may
 * be a `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire.
 * Through the gateway no local key is needed — it holds the OpenRouter
 * credential and injects it on the outbound leg — but the SDK insists on one,
 * so fall back to a decoy like the Azure/mantle factories do.
 */

import { config } from '../../../config';
import { logger } from '../../../logger';
import { createOpenAiCompatibleProvider } from '../openai-compatible';
import type { LlmProvider } from '../llm-provider';

/** OpenRouter's own API root. Ends at `/v1`; the SDK appends `/responses`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function createOpenRouterProvider(baseURL?: string): LlmProvider {
  logger.info({ routing: baseURL ? 'nexus' : 'direct' }, 'Creating OpenRouter provider');

  return createOpenAiCompatibleProvider({
    // Through the gateway the real key is injected on the outbound leg, so no
    // local key is needed — but the SDK insists on one, so fall back to a
    // decoy (the same pattern as the Azure and mantle factories).
    apiKey: config.openrouterApiKey || (baseURL ? 'nexus-managed' : undefined),
    baseURL: baseURL ?? config.openrouterBaseUrl ?? OPENROUTER_BASE_URL,
  });
}

/**
 * Check if OpenRouter is configured. Through the gateway only the model id is
 * needed — the gateway holds the key (Azure/mantle/OpenAI parity). Direct mode
 * needs `OPENROUTER_API_KEY`.
 */
export function isOpenRouterConfigured(): boolean {
  if (!config.openrouterModelId) return false;
  if (config.nexusOpenRouterBaseUrl) return true;
  return Boolean(config.openrouterApiKey);
}
