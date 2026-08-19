/**
 * Unified LLM provider factory.
 *
 * Two orthogonal choices:
 *  - Vendor: `config.llmProvider` (`bedrock` default, `azure`,
 *    `bedrock-mantle`, or `openai`).
 *  - Routing: each vendor's factory takes an optional gateway base URL — set →
 *    route through the Lens Agents gateway, unset → direct to the vendor.
 *
 * Every underlying factory returns the same call shape — `LlmProvider`, a
 * callable `(modelId) => LanguageModel` with `.embedding(modelId)` attached —
 * so callers don't have to care which vendor or route is in use.
 *
 * **bedrock-mantle** is AWS's second Bedrock inference endpoint
 * (`bedrock-mantle.{region}.api.aws`; a Lens Agents managed-inference
 * backend), not a variant of the `bedrock` branch: it serves
 * neither InvokeModel nor Converse, so it needs its own factory. Of its three
 * surfaces — OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages
 * — only `/anthropic/v1` is implemented, which makes the provider a structural
 * copy of the Azure one (`createAnthropic` at a custom baseURL) rather than of
 * the native Bedrock one. Neither amazon-bedrock entry point works today:
 * `createBedrockAnthropic` appends `/model/{id}/invoke`, and
 * `@ai-sdk/amazon-bedrock/mantle` is OpenAI-compatible-only — re-evaluate if
 * vercel/ai#17141 lands. Two consequences worth knowing at this seam: model
 * IDs must be **bare** (mantle has no cross-region inference profiles, so the
 * mantle dispatcher strips `us.`/`eu.`/… prefixes), and embeddings do not run
 * on mantle at all — they stay on Titan over bedrock-runtime, so the mantle
 * provider reaches for `nexusLlmBaseUrl`, not its own route.
 *
 * **openai** is the one vendor serving OpenAI models rather than Claude, on a
 * single surface: chat, classification and embeddings all ride one base URL —
 * the Lens Agents `…/llm/openai/v1` mount or api.openai.com direct. Only the
 * voice-meeting Realtime WebSocket stays off the gateway (the mount routes
 * POST only); see `openai/openai-provider.ts`.
 */

import { config } from '../../config';
import { createBedrockProvider, isBedrockConfigured } from './bedrock/bedrock-provider';
import { createAzureProvider, isAzureConfigured } from './azure/azure-provider';
import {
  createBedrockMantleProvider,
  isBedrockMantleConfigured,
} from './bedrock-mantle/bedrock-mantle-provider';
import { createOpenAiProvider, isOpenAiConfigured } from './openai/openai-provider';
import type { LlmProvider } from './llm-provider';

export function createProvider(): LlmProvider {
  switch (config.llmProvider) {
    case 'azure':
      return createAzureProvider(config.nexusAzureBaseUrl ?? undefined);
    case 'bedrock-mantle':
      return createBedrockMantleProvider(config.nexusBedrockMantleBaseUrl ?? undefined);
    case 'openai':
      return createOpenAiProvider(config.nexusOpenAiBaseUrl ?? undefined);
    default:
      return createBedrockProvider(config.nexusLlmBaseUrl ?? undefined);
  }
}

/** Whether the selected provider has the config it needs to serve requests. */
export function isProviderConfigured(): boolean {
  switch (config.llmProvider) {
    case 'azure':
      return isAzureConfigured();
    case 'bedrock-mantle':
      return isBedrockMantleConfigured();
    case 'openai':
      return isOpenAiConfigured();
    default:
      return isBedrockConfigured();
  }
}
