/**
 * Bedrock Provider for Vercel AI SDK
 *
 * Chat generation dispatches on the model family: Anthropic models go through
 * the Anthropic-native Bedrock provider (Messages API via InvokeModel), and
 * any other model — Kimi, Llama, Mistral, etc. — goes through the generic
 * provider which uses Bedrock's Converse API (which normalizes tool/message
 * shapes across vendors).
 *
 * Why this matters: the Anthropic-native provider hardcodes Anthropic's tool
 * wire format (`{ name, description, input_schema }`). Pointing it at a Kimi
 * model surfaces a Bedrock deserialization error ("Invalid 'tools': missing
 * field type") because Kimi expects OpenAI-shaped tool definitions.
 *
 * On the Converse branch, `converseToolImages` moves each tool-result image into
 * the user turn beside it, since most Converse models read no image in a result.
 *
 * Routing: `createBedrockProvider(baseURL?)` runs direct to AWS (unset) or
 * through the Mirantis Agent Platform LLM gateway (a `baseURL` — the gateway re-signs,
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
import { wrapLanguageModel } from 'ai';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { createSharedBedrockOptions } from '../bedrock-shared';
import { isAnthropicModelId } from '../bedrock-model-id';
import {
  ANTHROPIC_THINKING_OFF,
  anthropicCachePoint,
  BEDROCK_CACHE_POINT,
  NO_CACHE_POINT,
  type CachePointFragment,
  type CacheTtl,
  type LlmProvider,
} from '../llm-provider';
import { converseToolImages } from './converse-tool-images';
import { hasAwsCredentialSource } from './aws-credential-source';
import {
  ANTHROPIC_DEFERRED_TOOLS,
  deferredToolsWhen,
  supportsAnthropicDeferredTools,
} from '../deferred-tools';
import { ANTHROPIC_TOOL_CHANGES, supportsToolChanges } from '../tool-changes';

/**
 * Create an Amazon Bedrock provider that dispatches on model family.
 *
 * Returns a callable `(modelId) => LanguageModel` for chat:
 *  - Anthropic chat model IDs route through the Anthropic-native provider.
 *  - Anything else routes through the generic Converse-API provider.
 *
 * `baseURL` selects routing: unset → direct AWS (credentials via explicit keys
 * or the default credential chain); set → the Mirantis Agent Platform gateway, which does
 * its own signing (so no local credentials are attached).
 */
export function createBedrockProvider(baseURL?: string): LlmProvider {
  logger.info({ routing: baseURL ? 'nexus' : 'direct' }, 'Creating Bedrock provider');

  const sharedOptions = baseURL ? { region: config.awsRegion, baseURL } : createSharedBedrockOptions();
  const anthropic = createBedrockAnthropic(sharedOptions);
  const generic = createAmazonBedrock(sharedOptions);

  const dispatcher = (modelId: string) =>
    isAnthropicModelId(modelId)
      ? anthropic(modelId)
      : wrapLanguageModel({ model: generic(modelId), middleware: converseToolImages });
  return Object.assign(dispatcher, {
    cachePoint: promptCacheFragment,
    // Haiku 5.5, the classification default, rejects an explicit temperature
    // and can think unasked. The Anthropic SDK reads `anthropic.thinking` for Bedrock models too.
    classificationProviderOptions: ANTHROPIC_THINKING_OFF,
    classificationSamplingParams: {},
    // Derived from the fragment rather than repeating the rule, so the startup
    // line cannot disagree with what the request carries.
    promptCacheState: (modelId: string): 'on' | 'off' =>
      Object.keys(promptCacheFragment(modelId)).length > 0 ? 'on' : 'off',
    // Every model on the list is a Claude id, so it runs on the Anthropic
    // Messages branch; Converse never gets one.
    toolChanges: (modelId: string) =>
      supportsToolChanges(modelId) ? ANTHROPIC_TOOL_CHANGES : undefined,
    deferredTools: deferredToolsWhen(supportsAnthropicDeferredTools, ANTHROPIC_DEFERRED_TOOLS),
  });
}

/**
 * The settings Bedrock still needs: none through the gateway, with a bearer token
 * or explicit keys, or when the AWS default chain has a source. The bearer token
 * is the one the docs ask for.
 */
export async function missingBedrockSettings(): Promise<string[]> {
  if (config.nexusLlmBaseUrl || config.bedrockApiKey) return [];
  if (config.awsAccessKeyId && config.awsSecretAccessKey) return [];
  return (await hasAwsCredentialSource()) ? [] : ['AWS_BEARER_TOKEN_BEDROCK'];
}

/**
 * Bedrock model families known to accept a Converse prompt-cache breakpoint.
 *
 * Empty, which is the honest answer and not an oversight. A Bedrock model
 * without prompt-cache support answers a request that has a `cachePoint` block
 * with "You invoked an unsupported model or your request did not allow prompt
 * caching", so every turn fails, and no source this runtime can read says which
 * model supports one: AWS publishes no per-model capability,
 * `@ai-sdk/amazon-bedrock` carries none (its one model-support module answers
 * tool and structured-output questions), and the model catalog holds context
 * windows only. A guess here is a dead agent.
 *
 * This list is the extension point. Add the family fragment — matched inside the
 * model id, so one entry covers the `us.`/`eu.`/`global.` inference profiles and
 * the version suffixes — once a citable source establishes that family's
 * support.
 */
const CONVERSE_PROMPT_CACHE_FAMILIES: readonly string[] = [];

/**
 * The prompt-cache breakpoint fragment for one Bedrock model.
 *
 * Dispatched like the model itself, because the breakpoint belongs to the
 * protocol rather than to the vendor: the Anthropic-native provider reads
 * Anthropic's namespace, Converse reads Bedrock's, and a fragment in the wrong
 * one is discarded without an error.
 *
 * Claude always gets its breakpoint. A Converse model gets one only when its
 * family is on the list above, so a model whose support is unknown runs uncached
 * instead of failing every turn.
 */
function promptCacheFragment(modelId: string, ttl?: CacheTtl): CachePointFragment {
  if (isAnthropicModelId(modelId)) return anthropicCachePoint(ttl);
  const knownToCache = CONVERSE_PROMPT_CACHE_FAMILIES.some((family) => modelId.includes(family));
  return knownToCache ? BEDROCK_CACHE_POINT : NO_CACHE_POINT;
}
