/**
 * Anthropic Provider for Vercel AI SDK — the first-party Anthropic API
 *
 * Chat and classification speak the Anthropic Messages API at
 * api.anthropic.com (or `ANTHROPIC_BASE_URL`; must end at `/v1` — the SDK
 * appends `/messages`). Model IDs are bare first-party IDs
 * (e.g. `claude-opus-5`). The other Claude vendors are structural copies of
 * this shape at other hosts; here the SDK's own defaults already point at the
 * right place.
 *
 * Per-agent overrides stored in the DB (and the `~/.prism` bootstrap seed)
 * may carry Bedrock spellings from before a deployment switched vendors —
 * `us.anthropic.claude-opus-5`, `anthropic.claude-haiku-4-5-20251001-v1:0` —
 * which api.anthropic.com 404s. The dispatcher maps those to their embedded
 * first-party id, the same chokepoint normalization the mantle provider does
 * for its prefix rule, so switching an existing deployment over does not
 * break its stored model.
 *
 * Routing: direct-only — the factory takes no baseURL argument, and
 * `missingAnthropicSettings()` always requires the key. The key is sent as the
 * `x-api-key` header, with `anthropic-version` added by the SDK.
 *
 * api.anthropic.com accepts the SDK's native structured-output path (unlike
 * Foundry and mantle, which declare `structuredOutputOptions`) and any positive
 * token cap, so those declarations stay unset. The gates send no temperature
 * and turn thinking off, because the default classification model, Haiku 5.5,
 * rejects the first and can do the second unasked.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../../../config';
import { logger } from '../../../logger';
import {
  ANTHROPIC_THINKING_OFF,
  anthropicCachePoint,
  type CacheTtl,
  type LlmProvider,
} from '../llm-provider';

/**
 * A Bedrock spelling of a Claude id: an optional cross-region
 * inference-profile prefix, the `anthropic.` vendor prefix, then the
 * first-party id, with an optional `-v1:0`-style Bedrock version artifact.
 * ARNs don't match and pass through untouched.
 */
const BEDROCK_ID_SHAPE =
  /^(?:(?:us-gov|us|eu|apac|jp|au|ca|global)\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/i;

/**
 * Model ids already warned about, so the diagnostic stays a diagnostic — a
 * migrated deployment whose agent row still holds a Bedrock spelling hits
 * this on every turn (same rationale as the mantle prefix warning).
 */
const warnedBedrockIds = new Set<string>();

/**
 * Map a Bedrock spelling of a Claude id to the first-party id it embeds, so a
 * model ID configured for Bedrock still resolves on api.anthropic.com. Bare
 * first-party ids (and anything else) pass through unchanged.
 */
export function toFirstPartyModelId(modelId: string): string {
  const match = BEDROCK_ID_SHAPE.exec(modelId);
  if (!match) return modelId;
  const bare = match[1];
  if (!warnedBedrockIds.has(modelId)) {
    warnedBedrockIds.add(modelId);
    logger.warn(
      { modelId, bare },
      'Mapped a Bedrock-style model id to its first-party spelling — api.anthropic.com serves bare ids',
    );
  }
  return bare;
}

export function createAnthropicProvider(): LlmProvider {
  logger.info({ routing: 'direct' }, 'Creating Anthropic provider (first-party Messages API)');

  const anthropic = createAnthropic({
    // Explicit rather than the SDK's ambient ANTHROPIC_API_KEY fallback, so
    // the credential in use is the one config reports.
    apiKey: config.anthropicApiKey,
    // undefined → the SDK's own default, https://api.anthropic.com/v1.
    baseURL: config.anthropicBaseUrl,
  });

  const dispatcher = (modelId: string) => anthropic(toFirstPartyModelId(modelId));
  return Object.assign(dispatcher, {
    cachePoint: (_modelId: string, ttl?: CacheTtl) => anthropicCachePoint(ttl),
    classificationProviderOptions: ANTHROPIC_THINKING_OFF,
    classificationSamplingParams: {},
  });
}

/**
 * The settings Anthropic still needs, by variable name; empty when it can serve
 * requests. Direct-only, so the API key is always required.
 */
export function missingAnthropicSettings(): string[] {
  return config.anthropicApiKey ? [] : ['ANTHROPIC_API_KEY'];
}
