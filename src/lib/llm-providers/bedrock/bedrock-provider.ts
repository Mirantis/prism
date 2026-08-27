/**
 * Bedrock Provider for Vercel AI SDK
 *
 * Chat generation dispatches on the model family: Anthropic models go through
 * the Anthropic-native Bedrock provider (Messages API via InvokeModel), and
 * any other model — Kimi, Llama, Mistral, etc. — goes through the generic
 * provider which uses Bedrock's Converse API (which normalizes tool/message
 * shapes across vendors). Embeddings always use the generic provider.
 *
 * Why this matters: the Anthropic-native provider hardcodes Anthropic's tool
 * wire format (`{ name, description, input_schema }`). Pointing it at a Kimi
 * model surfaces a Bedrock deserialization error ("Invalid 'tools': missing
 * field type") because Kimi expects OpenAI-shaped tool definitions.
 *
 * Routing: `createBedrockProvider(baseURL?)` runs direct to AWS (unset) or
 * through the Lens Agents LLM gateway (a `baseURL` — the gateway re-signs,
 * tracks usage, and audits, so no local credentials are used). Direct mode has
 * two auth paths, picked automatically by the SDK from the environment:
 *
 * 1. Bearer token: when `AWS_BEARER_TOKEN_BEDROCK` is set,
 *    `@ai-sdk/amazon-bedrock` short-circuits SigV4 and sends
 *    `Authorization: Bearer <token>` directly to Bedrock. The env var
 *    may hold a `__nexus_cred:<uuid>__` sentinel that the MITM proxy
 *    rewrites on the wire to the real Bedrock API key.
 *
 * 2. SigV4: when no bearer token is set, the SDK uses the shared
 *    credential provider options below — ECS task role / container
 *    metadata in production, explicit access keys for local dev.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { createSharedBedrockOptions, isAnthropicModelId } from '../bedrock-shared';
import { ANTHROPIC_CACHE_POINT, BEDROCK_CACHE_POINT, type LlmProvider } from '../llm-provider';

/**
 * Create an Amazon Bedrock provider that dispatches on model family.
 *
 * Returns a callable `(modelId) => LanguageModel` for chat, plus an
 * `.embedding(modelId)` method for text embeddings:
 *  - Anthropic chat model IDs route through the Anthropic-native provider.
 *  - Anything else routes through the generic Converse-API provider.
 *  - Embeddings always route through the generic provider (the Anthropic
 *    provider doesn't expose embedding models).
 *
 * `baseURL` selects routing: unset → direct AWS (credentials via explicit keys
 * or the default credential chain); set → the Lens Agents gateway, which does
 * its own signing (so no local credentials are attached).
 */
export function createBedrockProvider(baseURL?: string): LlmProvider {
  logger.info({ routing: baseURL ? 'nexus' : 'direct' }, 'Creating Bedrock provider');

  const sharedOptions = baseURL ? { region: config.awsRegion, baseURL } : createSharedBedrockOptions();
  const anthropic = createBedrockAnthropic(sharedOptions);
  const generic = createAmazonBedrock(sharedOptions);

  const dispatcher = (modelId: string) =>
    isAnthropicModelId(modelId) ? anthropic(modelId) : generic(modelId);
  return Object.assign(dispatcher, {
    embedding: (modelId: string) => generic.embedding(modelId),
    // Dispatched like the model itself, because the breakpoint belongs to the
    // protocol rather than to the vendor: the Anthropic-native provider reads
    // Anthropic's namespace, Converse reads Bedrock's, and a fragment in the
    // wrong one is discarded without an error.
    //
    // Every Converse model gets the breakpoint, cache-capable or not. AWS
    // ignores a checkpoint a model cannot use, and the alternative — a list of
    // vendors known to support caching — leaves each new one uncached until
    // someone remembers to extend it, which is the failure this dispatch was
    // written to end.
    cachePoint: (modelId: string) =>
      isAnthropicModelId(modelId) ? ANTHROPIC_CACHE_POINT : BEDROCK_CACHE_POINT,
  });
}

/**
 * Check if Bedrock is configured.
 *
 * In ECS, credentials come from the task role (no explicit keys needed).
 * Only AWS_REGION and BEDROCK_MODEL_ID are required as env vars.
 */
export function isBedrockConfigured(): boolean {
  return Boolean(config.awsRegion && config.bedrockModelId);
}
