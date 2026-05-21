/**
 * Nexus LLM Provider
 *
 * Routes LLM inference through the Nexus gateway instead of direct AWS Bedrock.
 * Nexus handles SigV4 signing, token usage tracking, and audit trail recording.
 *
 * Speaks the Bedrock protocol natively (transparent proxy with re-signing), so
 * we mirror the direct-Bedrock provider's family dispatch: Anthropic model IDs
 * use the Anthropic-native provider (InvokeModel + Messages API); anything
 * else uses the generic provider (Converse API). See
 * `bedrock-provider.ts:isAnthropicModelId` for the rationale.
 */
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { config } from '../config';
import { isAnthropicModelId } from './bedrock-provider';

export function createNexusProvider(nexusLlmBaseUrl: string, agentToken: string) {
  const sharedOptions = {
    region: config.awsRegion,
    baseURL: nexusLlmBaseUrl,
    apiKey: agentToken,
  };
  const anthropic = createBedrockAnthropic(sharedOptions);
  const generic = createAmazonBedrock(sharedOptions);
  const dispatcher = (modelId: string) =>
    isAnthropicModelId(modelId) ? anthropic(modelId) : generic(modelId);
  return Object.assign(dispatcher, {
    embedding: (modelId: string) => generic.embedding(modelId),
  });
}

/**
 * Build the classification-gate model instance, routed through Nexus.
 *
 * Callers must resolve a Nexus agent token via
 * `agentWorkspaceService.getNexusMcpAgentToken(agentId)` first and apply
 * their own fallback when the token is missing.
 */
export function getClassificationModel(agentToken: string) {
  return createNexusProvider(config.nexusLlmBaseUrl, agentToken)(config.bedrockClassificationModelId);
}
