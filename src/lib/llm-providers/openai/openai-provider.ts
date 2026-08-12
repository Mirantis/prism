/**
 * OpenAI Provider for Vercel AI SDK — the official OpenAI API
 *
 * Unlike the other three vendors this one serves OpenAI models, not Claude,
 * on a single surface: chat, classification and embeddings all speak the
 * OpenAI API at one base URL. `createOpenAI()(modelId)` dispatches to the
 * **Responses API** (the SDK's default), so a custom endpoint — direct
 * override or gateway — must serve `/responses`, not just
 * `/chat/completions`.
 *
 * Routing: a `baseURL` argument (the Nexus OpenAI mount, computed from
 * `NEXUS_API_URL` as `…/llm/openai/v1`; nexus-monorepo#483) routes everything
 * through the gateway, which appends the client path to its configured OpenAI
 * root and injects the API key on the outbound leg; unset → direct to
 * api.openai.com (or `OPENAI_BASE_URL`). The one OpenAI call that never rides
 * Nexus is the voice-meeting Realtime WebSocket — the mount routes POST only —
 * which stays pinned in `services/meeting/openai-endpoint.ts`.
 *
 * Auth: the same `OPENAI_API_KEY` the voice-meeting stack uses, sent as a
 * bearer header. It may be a `__nexus_cred:<uuid>__` sentinel the MITM proxy
 * rewrites on the wire — read verbatim, never trimmed or validated. Through
 * Nexus no local key is needed (the gateway holds its own), but the SDK
 * insists on one, so fall back to a decoy like the Azure/mantle factories do.
 *
 * Prompt caching is automatic on OpenAI — no breakpoint concept — so this
 * provider declares the empty cache-point fragment; spreading it into
 * `providerOptions` is a no-op on the wire. Structured output works on the
 * SDK's native path, so no `structuredOutputOptions` either.
 *
 * Classification caveat: elsewhere the gates run the classification model
 * with `temperature: 0` and tiny output-token budgets — assumptions GPT-5.x
 * breaks three ways, so this provider declares all three gate knobs:
 * `reasoningEffort: 'none'` (reasoning tokens would eat the budgets before
 * the verdict), a 16-token output floor (the Responses API rejects any
 * `max_output_tokens` below 16, and a gate whose every call 400s is a gate
 * disabled), and empty sampling params — GPT-5.x models reject an explicit
 * temperature outside effort 'none', and whether the SDK even forwards it
 * there depends on its per-model support matrix (< 3.0.91 strips it for
 * gpt-5.6 with a warning). Omitting the param beats tracking any of that,
 * which is the same rule the main invoke path applies: it sends no sampling
 * params at all and runs the chat model at its default reasoning effort.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { NO_CACHE_POINT, type LlmProvider } from '../llm-provider';

export function createOpenAiProvider(baseURL?: string): LlmProvider {
  logger.info({ routing: baseURL ? 'nexus' : 'direct' }, 'Creating OpenAI provider');

  // Through Nexus the gateway injects the real key on the outbound leg, so no
  // local key is needed — but the SDK insists on one, so fall back to a decoy
  // (the same pattern as the Azure and mantle factories).
  const decoyableKey = config.openaiApiKey || (baseURL ? 'nexus-managed' : undefined);
  const openai = createOpenAI({
    apiKey: decoyableKey,
    // undefined → the SDK's own default, https://api.openai.com/v1.
    baseURL: baseURL ?? config.openaiBaseUrl,
  });

  const dispatcher = (modelId: string) => openai(modelId);
  return Object.assign(dispatcher, {
    // Same client, same mount: OpenAI has no split surface for embeddings.
    embedding: (modelId: string) => openai.embedding(modelId),
    cachePoint: NO_CACHE_POINT,
    // See the classification caveat in the header: reasoning off, or the
    // gates' tiny token budgets are spent on reasoning instead of the
    // verdict.
    classificationProviderOptions: { openai: { reasoningEffort: 'none' } },
    // The Responses API rejects max_output_tokens < 16.
    classificationMinOutputTokens: 16,
    // No explicit temperature: GPT-5.x rejects or strips it (see header).
    classificationSamplingParams: {},
  });
}

/**
 * Check if OpenAI is configured. Through Nexus only the model id is needed —
 * the gateway holds the key (Azure/mantle parity). Direct mode needs the key
 * too. Embedding config is deliberately NOT required — memory embeddings
 * fail-open without it.
 */
export function isOpenAiConfigured(): boolean {
  if (!config.openaiModelId) return false;
  if (config.nexusOpenAiBaseUrl) return true;
  return Boolean(config.openaiApiKey);
}
