/**
 * Unified LLM provider factory.
 *
 * Two orthogonal choices:
 *  - Vendor: `config.llmProvider` (`bedrock` default, `azure`,
 *    `bedrock-mantle`, `openai`, `openrouter`, `anthropic`, `litellm`, or
 *    `codex-subscription`).
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
 *
 * **litellm** is an operator's own LiteLLM proxy, spoken to in the Anthropic
 * Messages format at `LITELLM_BASE_URL` or the `…/llm/litellm/anthropic/v1`
 * mount. Model IDs are the operator's aliases.
 *
 * **codex-subscription** runs each model call through the Codex CLI's app-server
 * in the execution environment, signed in with a ChatGPT subscription. It takes no
 * endpoint and no key: the Codex home holds the login, and an API-key login is
 * refused. Model IDs are Codex's own model names; see `codex-subscription/`.
 */

import { config } from '../../config';
import { createBedrockProvider } from './bedrock/bedrock-provider';
import { createAzureProvider, missingAzureSettings } from './azure/azure-provider';
import {
  createBedrockMantleProvider,
  missingBedrockMantleSettings,
} from './bedrock-mantle/bedrock-mantle-provider';
import { createOpenAiProvider, missingOpenAiSettings } from './openai/openai-provider';
import {
  createOpenRouterProvider,
  missingOpenRouterSettings,
} from './openrouter/openrouter-provider';
import { createAnthropicProvider, missingAnthropicSettings } from './anthropic/anthropic-provider';
import { createLiteLlmProvider, missingLiteLlmSettings } from './litellm/litellm-provider';
import { createCodexSubscriptionProvider } from './codex-subscription/codex-subscription-provider';
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
    case 'litellm':
      return createLiteLlmProvider(config.litellmEndpoint);
    case 'codex-subscription':
      return createCodexSubscriptionProvider();
    default:
      return createBedrockProvider(config.nexusLlmBaseUrl ?? undefined);
  }
}

/**
 * The settings the selected provider still needs, by variable name; empty when
 * it can serve requests. Every model id has a default, so what can be missing
 * is a key or an endpoint.
 */
export function missingProviderSettings(): string[] {
  switch (config.llmProvider) {
    case 'azure':
      return missingAzureSettings();
    case 'bedrock-mantle':
      return missingBedrockMantleSettings();
    case 'openai':
      return missingOpenAiSettings();
    case 'openrouter':
      return missingOpenRouterSettings();
    case 'anthropic':
      return missingAnthropicSettings();
    case 'litellm':
      return missingLiteLlmSettings();
    case 'codex-subscription':
      // The login lives in the Codex home, and the first turn names a missing one.
      return [];
    default:
      // Bedrock finds its credentials through the AWS SDK's own chain (the task
      // role in ECS) when a request is made.
      return [];
  }
}
