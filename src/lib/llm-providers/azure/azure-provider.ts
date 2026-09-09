import { supportsToolChanges } from '../tool-changes';
/**
 * Azure Provider for Vercel AI SDK — Claude via Microsoft Foundry
 *
 * Azure serves Claude through the **Anthropic Messages API** on Microsoft
 * Foundry (`https://{resource}.services.ai.azure.com/anthropic/v1/messages`),
 * NOT through an OpenAI-compatible endpoint: `@ai-sdk/anthropic` pointed at
 * the Foundry Anthropic endpoint. Model IDs are Foundry *deployment names*
 * (which default to Claude model IDs, e.g. `claude-opus-5`).
 * `AZURE_FOUNDRY_BASE_URL` is the escape hatch when an operator splits the
 * resource's hosts.
 *
 * Routing: the `baseURL` argument is the resolved chat endpoint —
 * `AZURE_FOUNDRY_BASE_URL`, else the Lens Agents Azure gateway chat route
 * (`…/llm/azure/anthropic/v1`, mirroring Bedrock's `…/llm/bedrock/{region}`),
 * else the Foundry resource. `config.azureChatEndpoint` decides between them.
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
import { config, isGatewayEndpoint } from '../../../config';
import { logger } from '../../../logger';
import { ANTHROPIC_CACHE_POINT, type LlmProvider } from '../llm-provider';

export function createAzureProvider(baseURL?: string): LlmProvider {
  const gatewayServesIt = isGatewayEndpoint(baseURL);
  logger.info(
    { routing: gatewayServesIt ? 'nexus' : 'direct' },
    'Creating Azure provider (Claude via Microsoft Foundry)',
  );

  // Chat/classification — Anthropic Messages API. The SDK builds
  // `${baseURL}/messages`, so the base must end at `…/anthropic/v1` (direct)
  // or `…/llm/azure/anthropic/v1` (gateway).
  //
  // On the gateway the real Foundry key (`api-key` from its NEXUS_AZURE_TOKEN)
  // is injected on the outbound leg, so no local key is needed — but the SDKs
  // insist on one, so fall back to a decoy (the same pattern the Lens Agents
  // sandbox uses for its provisioned ANTHROPIC_API_KEY).
  const decoyableKey = config.azureApiKey || (gatewayServesIt ? 'nexus-managed' : undefined);
  const anthropic = createAnthropic({
    apiKey: decoyableKey,
    baseURL,
  });

  const dispatcher = (modelId: string) => anthropic(modelId);
  return Object.assign(dispatcher, {
    supportsToolChanges,
    // Foundry-hosted deployments reject structured outputs (see the feature
    // caveat above), so ask the SDK for the tool-based JSON path rather than
    // Anthropic's native `output_config.format`.
    structuredOutputOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
    cachePoint: () => ANTHROPIC_CACHE_POINT,
  });
}

/**
 * Check if Azure is configured. Through the Lens Agents gateway only a chat
 * deployment is needed — the gateway holds the Foundry key (Bedrock parity: no
 * local credentials when routed that way). Direct mode needs the deployment, an
 * api-key, and a Foundry endpoint (resource name or explicit base URL).
 */
export function isAzureConfigured(): boolean {
  if (!config.azureModelId) return false;
  if (config.nexusAzureBaseUrl) return true;
  return Boolean(config.azureApiKey && config.azureDirectEndpoint);
}
