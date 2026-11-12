/**
 * Whether a model ID names a model on Bedrock, by the rules the runtime applies to a
 * coding agent's model override: bare (`anthropic.…`), region-prefixed (`us.anthropic.…`)
 * or an ARN whose resource is one of those (`…/us.anthropic.…`).
 */

export function isAnthropicModelId(modelId: string): boolean {
  return /^anthropic\.|\.anthropic\./i.test(modelId);
}

export function isOpenAiBedrockModelId(modelId: string): boolean {
  return /^openai\.|\.openai\./i.test(modelId);
}
