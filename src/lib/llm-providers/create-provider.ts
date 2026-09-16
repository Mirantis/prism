/**
 * Unified LLM provider factory.
 *
 * Two orthogonal choices:
 *  - Vendor: `config.llmProvider` (`bedrock` default, `azure`,
 *    `bedrock-mantle`, `openai`, `openrouter`, or `anthropic`).
 *  - Endpoint: each vendor's factory takes the endpoint `config.ts` resolved for
 *    it — the explicit `*_BASE_URL` override, else the Lens Agents gateway mount,
 *    else the vendor's own host. The factory receives one endpoint and chooses
 *    nothing, so the precedence is written once.
 *
 * Every underlying factory returns the same call shape — `LlmProvider`, a
 * callable `(modelId) => LanguageModel` — so callers don't have to care which
 * vendor or route is in use.
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
 * vercel/ai#17141 lands. One consequence worth knowing at this seam: model
 * IDs must be **bare** (mantle has no cross-region inference profiles, so the
 * mantle dispatcher strips `us.`/`eu.`/… prefixes).
 *
 * **openai** is the one vendor serving OpenAI models rather than Claude, on a
 * single surface: chat and classification ride one base URL — the Lens Agents
 * `…/llm/openai/v1` mount or api.openai.com direct. Realtime voice resolves its
 * managed or direct endpoint separately in config.ts. **openrouter** rides the same OpenAI-compatible
 * surface at openrouter.ai (or the `…/llm/openrouter/openai/v1` mount) with
 * `vendor/model` ids; see `openrouter/openrouter-provider.ts`.
 *
 * **anthropic** is the first-party Anthropic API, and the one vendor that is
 * **direct-only**: no gateway mount serves api.anthropic.com, so its factory
 * takes no baseURL and `ANTHROPIC_API_KEY` is always required. Model IDs are
 * bare first-party IDs (`claude-opus-5`).
 */

import { config } from '../../config';
import { createBedrockProvider, isBedrockConfigured } from './bedrock/bedrock-provider';
import { createAzureProvider, isAzureConfigured } from './azure/azure-provider';
import {
  createBedrockMantleProvider,
  isBedrockMantleConfigured,
} from './bedrock-mantle/bedrock-mantle-provider';
import { createOpenAiProvider, isOpenAiConfigured } from './openai/openai-provider';
import {
  createOpenRouterProvider,
  isOpenRouterConfigured,
} from './openrouter/openrouter-provider';
import { createAnthropicProvider, isAnthropicConfigured } from './anthropic/anthropic-provider';
import type { LlmProvider } from './llm-provider';

export function createProvider(): LlmProvider {
  switch (config.llmProvider) {
    case 'azure':
      return createAzureProvider(config.azureChatEndpoint);
    case 'bedrock-mantle':
      return createBedrockMantleProvider(config.bedrockMantleChatEndpoint);
    case 'openai':
      return createOpenAiProvider(config.openaiEndpoint);
    case 'openrouter':
      return createOpenRouterProvider(config.openrouterEndpoint);
    case 'anthropic':
      return createAnthropicProvider();
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
    case 'openrouter':
      return isOpenRouterConfigured();
    case 'anthropic':
      return isAnthropicConfigured();
    default:
      return isBedrockConfigured();
  }
}
