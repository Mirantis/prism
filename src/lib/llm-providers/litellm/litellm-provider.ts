/**
 * LiteLLM Provider for Vercel AI SDK — an operator's own LiteLLM proxy
 *
 * LiteLLM serves the Anthropic Messages API at `/v1/messages` and translates
 * it to whichever upstream model an alias routes to, so this is
 * `@ai-sdk/anthropic` at a custom baseURL, like the Azure provider. Model ids
 * are the operator's aliases and go to the proxy unchanged.
 *
 * Routing: the `baseURL` argument is `LITELLM_BASE_URL`, else the Lens Agents
 * `…/llm/litellm/anthropic/v1` mount. `config.litellmEndpoint` decides between
 * them. A proxy has no public host, so with neither there is no endpoint.
 *
 * Auth: `LITELLM_API_KEY`, sent as `x-api-key`. The gateway drops a client key
 * and injects its own, so on the gateway a decoy stands in for the key the SDK
 * insists on. Off the gateway, a missing key fails the model call before any
 * request: given no key, the SDK sends `ANTHROPIC_API_KEY`, a first-party
 * credential, to the proxy.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { config, isGatewayEndpoint } from '../../../config';
import { logger } from '../../../logger';
import { ANTHROPIC_CACHE_POINT, type LlmProvider } from '../llm-provider';

/** How long the startup check waits for the proxy's model list. */
const MODEL_LIST_TIMEOUT_MS = 10_000;
/** How many served model ids a startup warning names. */
const LISTED_MODELS = 50;

export function createLiteLlmProvider(baseURL?: string): LlmProvider {
  const gatewayServesIt = isGatewayEndpoint(baseURL);
  logger.info({ routing: gatewayServesIt ? 'nexus' : 'direct' }, 'Creating LiteLLM provider');

  const apiKey = config.litellmApiKey || (gatewayServesIt ? 'nexus-managed' : undefined);
  const anthropic = createAnthropic({ apiKey, baseURL });

  const dispatcher = (modelId: string) => {
    if (!apiKey) throw new Error('LITELLM_API_KEY is not set');
    return anthropic(modelId);
  };
  return Object.assign(dispatcher, {
    // An alias can route to any upstream. A forced tool call translates to all
    // of them, while native `output_config.format` reaches an Anthropic one only.
    structuredOutputOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
    // No gate temperature, for the same reason: a GPT-5.x upstream rejects an
    // explicit one, and every model accepts its own default.
    classificationSamplingParams: {},
    cachePoint: () => ANTHROPIC_CACHE_POINT,
    ...(baseURL ? { startupCheck: () => checkModels(baseURL, apiKey) } : {}),
  });
}

/**
 * Warn when a configured model is not one the proxy serves, naming the ones it
 * does. The ids are aliases the operator made up, so a default the proxy does
 * not serve, or a typo, is otherwise a failed turn with nothing to say which
 * alias is right.
 */
async function checkModels(baseURL: string, apiKey: string | undefined): Promise<void> {
  if (!apiKey) return;
  let served: string[];
  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET /models answered ${response.status}`);
    const { data } = (await response.json()) as { data: Array<{ id: string }> };
    served = data.map((model) => model.id);
  } catch (err) {
    logger.warn({ err }, '[Startup] could not read the LiteLLM model list; the configured models are unchecked');
    return;
  }

  const checks = [
    { variable: 'LITELLM_MODEL_ID', model: config.litellmModelId },
    { variable: 'LITELLM_CLASSIFICATION_MODEL_ID', model: config.litellmClassificationModelId },
  ];
  for (const { variable, model } of checks) {
    if (served.includes(model)) continue;
    logger.warn(
      { variable, model, served: served.slice(0, LISTED_MODELS), servedCount: served.length },
      `[Startup] the LiteLLM proxy does not serve ${model}; set ${variable} to one of the models it serves`,
    );
  }
}

/**
 * The settings LiteLLM still needs, by variable name; empty when it can serve
 * requests. Through the gateway it needs none, since the gateway holds the key.
 * Direct mode needs the proxy's address and a key.
 */
export function missingLiteLlmSettings(): string[] {
  if (isGatewayEndpoint(config.litellmEndpoint)) return [];
  return [
    ...(config.litellmEndpoint ? [] : ['LITELLM_BASE_URL']),
    ...(config.litellmApiKey ? [] : ['LITELLM_API_KEY']),
  ];
}
