import { describe, it, expect } from 'vitest';

import { isAnthropicModelId, isOpenAiBedrockModelId } from './bedrock-model-id';

describe('isAnthropicModelId', () => {
  it('matches bare and region-prefixed Anthropic IDs', () => {
    expect(isAnthropicModelId('anthropic.claude-3-sonnet')).toBe(true);
    expect(isAnthropicModelId('us.anthropic.claude-opus-4-7')).toBe(true);
    expect(isAnthropicModelId('eu.anthropic.claude-3-haiku')).toBe(true);
    expect(isAnthropicModelId('apac.anthropic.claude-sonnet-4-6-20250929-v1:0')).toBe(true);
  });

  it('matches Anthropic IDs embedded in an ARN', () => {
    expect(
      isAnthropicModelId(
        'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-4-7',
      ),
    ).toBe(true);
  });

  it('does not match other vendors', () => {
    expect(isAnthropicModelId('moonshotai.kimi-k2.5')).toBe(false);
    expect(isAnthropicModelId('moonshot.kimi-k2-thinking')).toBe(false);
    expect(isAnthropicModelId('meta.llama3-70b-instruct-v1:0')).toBe(false);
    expect(isAnthropicModelId('mistral.mistral-large-2402-v1:0')).toBe(false);
  });
});

describe('isOpenAiBedrockModelId', () => {
  it('matches bare, region-prefixed and ARN OpenAI IDs on Bedrock', () => {
    expect(isOpenAiBedrockModelId('openai.gpt-5.6-luna')).toBe(true);
    expect(isOpenAiBedrockModelId('us.openai.gpt-5.6-terra')).toBe(true);
    expect(
      isOpenAiBedrockModelId('arn:aws:bedrock:us-east-1:123:inference-profile/us.openai.gpt-5.6-sol'),
    ).toBe(true);
  });

  it('does not match OpenAI API IDs or other vendors', () => {
    expect(isOpenAiBedrockModelId('gpt-5.6-luna')).toBe(false);
    expect(isOpenAiBedrockModelId('o4-mini')).toBe(false);
    expect(isOpenAiBedrockModelId('eu.anthropic.claude-haiku-5-5')).toBe(false);
  });
});
