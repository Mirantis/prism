/** Models that accept mid-conversation tool changes on the Messages API. */
const TOOL_CHANGE_MODELS = new Set(['claude-opus-4-8', 'claude-fable-5-1']);

export function supportsToolChanges(modelId: string): boolean {
  const bareId = modelId.replace(/^(?:(?:us|eu|global)\.)?(?:anthropic\.)?/, '');
  return TOOL_CHANGE_MODELS.has(bareId);
}
