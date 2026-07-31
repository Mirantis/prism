/**
 * Bedrock Mantle Provider for Vercel AI SDK
 *
 * Mantle is AWS's second Bedrock inference endpoint
 * (`https://bedrock-mantle.{region}.api.aws`), separate from `bedrock-runtime`
 * and recommended by AWS for new applications. It exposes three surfaces —
 * OpenAI Responses (`/v1/responses`), OpenAI Chat Completions
 * (`/v1/chat/completions`), and the **Anthropic Messages API**
 * (`/anthropic/v1/messages`) — and serves neither InvokeModel nor Converse.
 *
 * This provider implements the Anthropic surface only, which makes it
 * structurally identical to the Azure provider (Claude-on-Foundry) rather than
 * to the native Bedrock one:
 *
 *  - Chat + classification → `@ai-sdk/anthropic` pointed at mantle. Not
 *    `createBedrockAnthropic`, which appends `/model/{id}/invoke` (a path
 *    mantle does not serve), and not `@ai-sdk/amazon-bedrock/mantle`, which is
 *    OpenAI-compatible-only. vercel/ai#17141 tracks first-class support; until
 *    it lands, `createAnthropic` with a baseURL is the supported route.
 *  - Embeddings → the generic Bedrock provider (Titan on bedrock-runtime).
 *    Mantle has no embedding models, so this leg keys off `nexusLlmBaseUrl`
 *    rather than the mantle route, and is built lazily so a chat-only
 *    deployment never resolves AWS credentials for it.
 *
 * Model IDs are plain Bedrock IDs but must be **bare**: mantle does not
 * support cross-region inference profiles, so `us.anthropic.…` is rejected
 * with a 400. Per-agent overrides stored in the DB (and the `~/.prism`
 * bootstrap seed) carry those prefixes, so the dispatcher strips them — this
 * is the one chokepoint every override flows through, and it keeps the stored
 * value portable if the operator switches back to `LLM_PROVIDER=bedrock`.
 *
 * Routing: a `baseURL` argument (the Nexus mantle mount, computed from
 * `NEXUS_API_URL` as `…/llm/bedrock-mantle/anthropic/{region}/v1`) overrides
 * the direct endpoint; unset → straight to the AWS endpoint.
 *
 * Auth: the Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK` — the same credential
 * the native path uses) is sent as the `x-api-key` header, with
 * `anthropic-version: 2023-06-01` added by the SDK. There is no SigV4 path
 * here: `createAnthropic` cannot sign, so direct mode requires the key. The
 * key may be a `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the
 * wire — transparent here, as on the other two providers.
 *
 * Feature caveat: mantle rejects structured outputs (`output_config.format`)
 * with a 400. `invoke.ts` never asks for them; the one `generateObject` caller
 * (Slack thread classification) already catches and falls back.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { createBedrockEmbeddingProvider, isAnthropicModelId } from '../bedrock-shared';
import type { LlmProvider } from '../llm-provider';

/**
 * Cross-region inference profile prefixes (`us.`, `eu.`, `global.`, …). These
 * are valid on bedrock-runtime and rejected by mantle.
 */
const INFERENCE_PROFILE_PREFIX = /^(us-gov|us|eu|apac|jp|au|ca|global)\./i;

/**
 * Model ids already warned about, so the diagnostic stays a diagnostic.
 *
 * A migrated deployment whose agent row still holds `us.anthropic.…` hits the
 * stripping path on *every* chat turn, heartbeat gate and thread
 * classification — that is the steady state the feature exists to support, not
 * an anomaly, and warning each time buries the signal in its own noise. One
 * line per distinct id per process says the same thing once.
 */
const warnedPrefixedIds = new Set<string>();

/** Same idea for model ids that aren't on mantle's Anthropic surface at all. */
const warnedNonAnthropicIds = new Set<string>();

/**
 * Strip a cross-region inference profile prefix, so a model ID configured for
 * bedrock-runtime still resolves on mantle. Bare IDs and ARNs pass through.
 */
export function toBareBedrockModelId(modelId: string): string {
  const bare = modelId.replace(INFERENCE_PROFILE_PREFIX, '');
  if (bare !== modelId && !warnedPrefixedIds.has(modelId)) {
    warnedPrefixedIds.add(modelId);
    logger.warn(
      { modelId, bare },
      'Stripped cross-region inference-profile prefix — bedrock-mantle has no inference profiles',
    );
  }
  return bare;
}

/**
 * Create a Bedrock Mantle provider.
 *
 * Returns a callable `(modelId) => LanguageModel` for chat, plus an
 * `.embedding(modelId)` method that reaches Titan on bedrock-runtime.
 *
 * `baseURL` selects chat routing: unset → direct to the AWS mantle endpoint
 * (requires the Bedrock API key); set → the Nexus gateway, which holds the
 * credential itself.
 */
export function createBedrockMantleProvider(baseURL?: string): LlmProvider {
  logger.info(
    { routing: baseURL ? 'nexus' : 'direct' },
    'Creating Bedrock Mantle provider (Anthropic Messages surface)',
  );

  // Chat/classification — the SDK builds `${baseURL}/messages`, so the base
  // must end at `…/anthropic/v1` (direct) or
  // `…/llm/bedrock-mantle/anthropic/{region}/v1` (Nexus).
  //
  // Through Nexus the gateway injects the real Bedrock credential on the
  // outbound leg, so no local key is needed — but the SDK insists on one, so
  // fall back to a decoy (same pattern as the Azure provider).
  const decoyableKey = config.bedrockApiKey || (baseURL ? 'nexus-managed' : undefined);
  const anthropic = createAnthropic({
    apiKey: decoyableKey,
    baseURL: baseURL ?? config.bedrockMantleBaseUrl,
  });

  // Embeddings — Titan on bedrock-runtime, NOT mantle. So this keys off
  // `nexusLlmBaseUrl` (the `…/llm/bedrock/{region}` mount) rather than the
  // `baseURL` argument. Lazy + memoized: a deployment with embeddings disabled
  // never pays for (or logs) the AWS credential-chain resolution.
  let embeddings: ReturnType<typeof createBedrockEmbeddingProvider> | undefined;
  const getEmbeddings = () =>
    (embeddings ??= createBedrockEmbeddingProvider(config.nexusLlmBaseUrl ?? undefined));

  const dispatcher = (modelId: string) => {
    const bare = toBareBedrockModelId(modelId);
    if (!isAnthropicModelId(bare) && !warnedNonAnthropicIds.has(bare)) {
      // Mantle's other surfaces (OpenAI Responses / Chat Completions) aren't
      // implemented here, so a non-Anthropic model 404s. Warn rather than
      // throw — the model ID is operator config, and a log beats a cryptic 404.
      // Deduped for the same reason as the prefix warning: a misconfigured
      // model id is a standing condition, not a per-request event.
      warnedNonAnthropicIds.add(bare);
      logger.warn(
        { modelId: bare },
        'bedrock-mantle exposes only its Anthropic surface here; a non-Anthropic model will not resolve',
      );
    }
    return anthropic(bare);
  };

  return Object.assign(dispatcher, {
    embedding: (modelId: string) => getEmbeddings().embedding(modelId),
    // Mantle rejects Anthropic's native structured-output path with a 400
    // ("output_config.format: Extra inputs are not permitted"), so ask the SDK
    // for the tool-based JSON path instead.
    structuredOutputOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
  });
}

/**
 * Check if Bedrock Mantle is configured. Through Nexus only a chat model is
 * needed — the gateway holds the Bedrock credential. Direct mode also needs
 * the API key and an endpoint: unlike the native Bedrock provider there is no
 * SigV4 fallback, and without an explicit key `createAnthropic` would silently
 * pick up an ambient `ANTHROPIC_API_KEY` and fail at first request instead.
 * Embedding config is deliberately NOT required — memory embeddings fail-open.
 */
export function isBedrockMantleConfigured(): boolean {
  if (!config.bedrockMantleModelId) return false;
  if (config.nexusBedrockMantleBaseUrl) return true;
  return Boolean(config.bedrockApiKey && config.bedrockMantleBaseUrl);
}
