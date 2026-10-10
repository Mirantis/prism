/**
 * Mid-conversation tool changes on the Anthropic Messages API.
 *
 * A declared tool that is not loaded yet has `deferLoading`, and a system
 * message in the history names each tool that became available or stopped
 * being available. The provider adds the betas itself whenever a request
 * has such a message.
 */

import type { ToolChangeProtocol } from './llm-provider';

/**
 * Claude models measured to accept a tool change and keep the prompt cache
 * across it, on Bedrock's Anthropic Messages path. Matched on the bare id, so
 * one entry covers every inference-profile prefix. A model off the list sends
 * the request it sent before: some reject the change outright, and Opus 5
 * declines to answer a turn that has one.
 */
const TOOL_CHANGE_MODELS = new Set(['claude-opus-5-5', 'claude-opus-4-8', 'claude-sonnet-5-5']);

/**
 * The bare first-party id inside a Bedrock model id: no inference-profile or
 * vendor prefix. An inference-profile ARN names the profile in its last path
 * segment.
 */
function bareModelId(modelId: string): string {
  return modelId
    .slice(modelId.lastIndexOf('/') + 1)
    .replace(/^(?:(?:us-gov|us|eu|apac|jp|au|ca|global)\.)?(?:anthropic\.)?/i, '');
}

export function supportsToolChanges(modelId: string): boolean {
  return TOOL_CHANGE_MODELS.has(bareModelId(modelId));
}

export const ANTHROPIC_TOOL_CHANGES: ToolChangeProtocol = {
  deferredTool: { anthropic: { deferLoading: true } },
  announce: (changes) => ({
    role: 'system',
    content: '',
    providerOptions: { anthropic: { toolChanges: changes } },
  }),
};
