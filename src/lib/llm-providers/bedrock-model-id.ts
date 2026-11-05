/**
 * Returns true when `modelId` is an Anthropic Claude model on Bedrock — bare
 * (`anthropic.claude-…`), regional inference profile (`us.anthropic.…`,
 * `eu.anthropic.…`, …), or an ARN whose resource is a region-prefixed one (`…/eu.anthropic.…`).
 *
 * Kept free of imports so `config.ts` can use it: `bedrock-shared.ts` reads
 * the config.
 */
export function isAnthropicModelId(modelId: string): boolean {
  return /^anthropic\.|\.anthropic\./i.test(modelId);
}
