/**
 * OpenAI Provider for Vercel AI SDK — the official OpenAI API
 *
 * Unlike the other vendors this one serves OpenAI models, not Claude.
 * `createOpenAI()(modelId)` dispatches to the **Responses API** (the SDK's
 * default), so a custom endpoint — direct override or gateway — must serve
 * `/responses`, not just `/chat/completions`.
 *
 * Routing: the `baseURL` argument is the resolved endpoint — `OPENAI_BASE_URL`,
 * else the Lens Agents OpenAI mount (`…/llm/openai/v1`), else undefined for
 * api.openai.com. `config.openaiEndpoint` decides between them, so nothing is
 * chosen here. The gateway appends the client path to its configured OpenAI root
 * and injects the API key on the outbound leg. Realtime voice resolves its own
 * endpoint and credential in config.ts; it can also use managed OpenAI.
 *
 * Auth: OPENAI_API_KEY for chat/embeddings, sent as a
 * bearer header. It may be a `__nexus_cred:<uuid>__` sentinel the MITM proxy
 * rewrites on the wire — read verbatim, never trimmed or validated. An endpoint
 * on the gateway needs no local key (the gateway holds its own), but the SDK
 * insists on one, so fall back to a decoy like the Azure/mantle factories do.
 *
 * The provider object itself — the Responses dispatcher, the empty
 * cache-point fragment (OpenAI caching is automatic) and the three
 * classification declarations GPT-5.x needs — comes from
 * `../openai-compatible`, which is the SDK surface rather than this vendor.
 * Everything decided here is what makes it *OpenAI*: the endpoint, the key
 * and the bare model ids.
 */

import { config, isGatewayEndpoint } from '../../../config';
import { logger } from '../../../logger';
import { createOpenAiCompatibleProvider } from '../openai-compatible';
import type { LlmProvider } from '../llm-provider';

export function createOpenAiProvider(baseURL?: string): LlmProvider {
  const gatewayServesIt = isGatewayEndpoint(baseURL);
  logger.info({ routing: gatewayServesIt ? 'nexus' : 'direct' }, 'Creating OpenAI provider');

  return createOpenAiCompatibleProvider({
    // On the gateway the real key is injected on the outbound leg, so no local
    // key is needed — but the SDK insists on one, so fall back to a decoy (the
    // same pattern as the Azure and mantle factories).
    apiKey: config.openaiApiKey || (gatewayServesIt ? 'nexus-managed' : undefined),
    // undefined → the SDK's own default, https://api.openai.com/v1.
    baseURL,
  });
}

/**
 * The settings OpenAI still needs, by variable name; empty when it can serve
 * requests. Through the gateway it needs none, since the gateway holds the key.
 */
export function missingOpenAiSettings(): string[] {
  if (config.nexusOpenAiBaseUrl) return [];
  return config.openaiApiKey ? [] : ['OPENAI_API_KEY'];
}
