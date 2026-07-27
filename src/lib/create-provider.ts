/**
 * Unified LLM provider factory.
 *
 * Two orthogonal choices:
 *  - Vendor: `config.llmProvider` (`bedrock` default, or `azure`).
 *  - Routing: each vendor's factory takes an optional Nexus base URL — set →
 *    route through the Nexus gateway, unset → direct to the vendor.
 *
 * Every underlying factory returns the same call shape — `LlmProvider`, a
 * callable `(modelId) => LanguageModel` with `.embedding(modelId)` attached —
 * so callers don't have to care which vendor or route is in use.
 *
 * A note on **bedrock-mantle** (AWS's Anthropic/OpenAI-compatible Bedrock
 * endpoint at `bedrock-mantle.{region}.api.aws`; a Nexus managed-inference
 * backend since nexus-monorepo#414): it is deliberately NOT a provider here.
 * `LLM_PROVIDER=bedrock` already reaches the same models over Bedrock's
 * native protocol (SigV4/Bearer, Converse + InvokeModel). If mantle is ever
 * needed — e.g. Nexus policies steer managed agents to it — it slots in as a
 * third `llmProvider` branch that REUSES the azure-provider pattern, because
 * mantle's `/anthropic` surface speaks the exact same Anthropic Messages API
 * as Claude-on-Foundry: chat = `createAnthropic` with a baseURL of
 * `https://bedrock-mantle.{region}.api.aws/anthropic/v1` (direct; Bedrock API
 * key as `x-api-key`) or `…/llm/bedrock-mantle/anthropic/{region}/v1` (via
 * Nexus, keyless — the gateway reuses its NEXUS_BEDROCK_TOKEN). Model IDs
 * stay Bedrock model IDs (not deployment names), and embeddings would remain
 * on Titan via the native Bedrock provider (mantle's surfaces are chat-only).
 */

import { config } from '../config';
import { createBedrockProvider, isBedrockConfigured } from './bedrock-provider';
import { createAzureProvider, isAzureConfigured } from './azure-provider';
import type { LlmProvider } from './llm-provider';

export function createProvider(): LlmProvider {
  return config.llmProvider === 'azure'
    ? createAzureProvider(config.nexusAzureBaseUrl ?? undefined)
    : createBedrockProvider(config.nexusLlmBaseUrl ?? undefined);
}

/** Whether the selected provider has the config it needs to serve requests. */
export function isProviderConfigured(): boolean {
  return config.llmProvider === 'azure' ? isAzureConfigured() : isBedrockConfigured();
}
