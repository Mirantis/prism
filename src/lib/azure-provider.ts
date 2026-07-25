/**
 * Azure Provider for Vercel AI SDK — Claude via Microsoft Foundry
 *
 * Azure serves Claude through the **Anthropic Messages API** on Microsoft
 * Foundry (`https://{resource}.services.ai.azure.com/anthropic/v1/messages`),
 * NOT through an OpenAI-compatible endpoint. So this provider is
 * split-surface, directly analogous to Bedrock's anthropic-native + generic
 * split:
 *
 *  - Chat + classification → `@ai-sdk/anthropic` pointed at the Foundry
 *    Anthropic endpoint. Model IDs are Foundry *deployment names* (which
 *    default to Claude model IDs, e.g. `claude-opus-5`).
 *  - Embeddings → `@ai-sdk/azure` (Azure OpenAI, a `text-embedding-3`
 *    deployment) — Anthropic has no embedding model. Optional: without an
 *    embedding deployment, memory search fail-opens (embedding.service
 *    catches and returns null).
 *
 * One resource + one key serves both surfaces: an AI Services/Foundry
 * resource exposes both `{res}.services.ai.azure.com` (Anthropic) and
 * `{res}.openai.azure.com` (OpenAI) hosts with resource-level keys.
 * `AZURE_FOUNDRY_BASE_URL` is the escape hatch when an operator splits them.
 *
 * Routing: a `baseURL` argument (the Nexus Azure gateway chat route, computed
 * from `NEXUS_API_URL` as `…/llm/azure/anthropic/v1`, mirroring Bedrock's
 * `…/llm/bedrock/{region}`) overrides the Foundry chat endpoint, and
 * embeddings then ride the gateway's `…/llm/azure/openai/v1` mount; unset →
 * both surfaces go direct to the Foundry resource.
 *
 * Auth: the key is sent as the `x-api-key` header (Foundry accepts both
 * `api-key` and `x-api-key`); `anthropic-version: 2023-06-01` is added by the
 * SDK. The key may be a `__nexus_cred:<uuid>__` sentinel that the MITM proxy
 * rewrites on the wire — transparent here, like the Bedrock bearer token.
 *
 * Feature caveat: Foundry deployments hosted on Azure reject structured
 * outputs, server-side tools, the MCP connector, and the Files API (400 by
 * design). `invoke.ts` only uses client-side tools, which are fully supported.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import type { LanguageModelV3, EmbeddingModelV3 } from '@ai-sdk/provider';
import { config } from '../config';
import { logger } from '../logger';

// The shared provider shape (mirrors bedrock-provider's inferred return). An
// explicit annotation keeps the return type portable (the SDKs re-export
// nested `@ai-sdk/provider` copies that would otherwise trip TS2742).
type LlmProvider = ((modelId: string) => LanguageModelV3) & {
  embedding: (modelId: string) => EmbeddingModelV3;
};

export function createAzureProvider(baseURL?: string): LlmProvider {
  logger.info(
    { routing: baseURL ? 'nexus' : 'direct' },
    'Creating Azure provider (Claude via Microsoft Foundry)',
  );

  // Chat/classification — Anthropic Messages API. The SDK builds
  // `${baseURL}/messages`, so the base must end at `…/anthropic/v1` (direct)
  // or `…/llm/azure/anthropic/v1` (Nexus).
  //
  // Through Nexus the gateway injects the real Foundry key (`api-key` from
  // its NEXUS_AZURE_TOKEN) on the outbound leg, so no local key is needed —
  // but the SDKs insist on one, so fall back to a decoy (the same pattern the
  // Nexus sandbox uses for its provisioned ANTHROPIC_API_KEY).
  const decoyableKey = config.azureApiKey || (baseURL ? 'nexus-managed' : undefined);
  const anthropic = createAnthropic({
    apiKey: decoyableKey,
    baseURL: baseURL ?? config.azureFoundryBaseUrl,
  });

  // Embeddings — Azure OpenAI (text-embedding-3 deployment). In Nexus mode
  // they route through the gateway's `…/llm/azure/openai/v1` mount (the SDK
  // treats a non-*.openai.azure.com base as a custom gateway and appends
  // `/embeddings` bare, landing on the resource's `/openai/v1/embeddings`);
  // direct mode derives the endpoint from the resource name.
  const openai = baseURL && config.nexusAzureOpenAiBaseUrl
    ? createAzure({
        apiKey: decoyableKey,
        baseURL: config.nexusAzureOpenAiBaseUrl,
      })
    : createAzure({
        apiKey: config.azureApiKey,
        resourceName: config.azureResourceName,
        // undefined → SDK default
        apiVersion: config.azureApiVersion || undefined,
      });

  const dispatcher = (modelId: string) => anthropic(modelId);
  return Object.assign(dispatcher, {
    embedding: (modelId: string) => openai.embedding(modelId),
  });
}

/**
 * Check if Azure is configured. Through Nexus only a chat deployment is
 * needed — the gateway holds the Foundry key (Bedrock parity: no local
 * credentials when routed via Nexus). Direct mode needs the deployment, an
 * api-key, and a Foundry endpoint (resource name or explicit base URL).
 * Embedding config is deliberately NOT required — memory embeddings
 * fail-open without it.
 */
export function isAzureConfigured(): boolean {
  if (!config.azureModelId) return false;
  if (config.nexusAzureBaseUrl) return true;
  return Boolean(config.azureApiKey && config.azureFoundryBaseUrl);
}
