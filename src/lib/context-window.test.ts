import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../config', () => ({
  config: {
    llmProvider: 'bedrock' as 'bedrock' | 'azure' | 'openai' | 'anthropic',
    contextWindowTokens: null as number | null,
    // Importing context-window now transitively pulls in model-catalog; keep the
    // refresh disabled so nothing here can reach the network.
    modelsDevUrl: null as string | null,
  },
}));

import { config } from '../config';
import { contextWindowFor } from './context-window';

// The IDs `src/config.ts` actually defaults to. If the models.dev snapshot
// ever stops covering these, the indicator silently disappears for every default
// deployment — so assert them explicitly rather than trusting the generator.
const BEDROCK_CHAT_DEFAULT = 'global.anthropic.claude-opus-5-5';
const BEDROCK_CLASSIFICATION_DEFAULT = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const AZURE_CHAT_DEFAULT = 'claude-opus-5';
const AZURE_CLASSIFICATION_DEFAULT = 'claude-haiku-4-5';
const OPENAI_CHAT_DEFAULT = 'gpt-5.6-sol';
const OPENAI_CLASSIFICATION_DEFAULT = 'gpt-5.6-luna';
const ANTHROPIC_CHAT_DEFAULT = 'claude-opus-5';
const ANTHROPIC_CLASSIFICATION_DEFAULT = 'claude-haiku-4-5';

describe('contextWindowFor', () => {
  beforeEach(() => {
    config.llmProvider = 'bedrock';
    config.contextWindowTokens = null;
  });

  describe('the runtime defaults resolve', () => {
    it('resolves the Bedrock chat default', () => {
      expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 1_000_000 });
    });

    it('resolves the Bedrock classification default', () => {
      expect(contextWindowFor(BEDROCK_CLASSIFICATION_DEFAULT)).toEqual({ tokens: 200_000 });
    });

    it('resolves the Azure chat default', () => {
      config.llmProvider = 'azure';
      expect(contextWindowFor(AZURE_CHAT_DEFAULT)).toEqual({ tokens: 1_000_000 });
    });

    it('resolves the Azure classification default', () => {
      config.llmProvider = 'azure';
      expect(contextWindowFor(AZURE_CLASSIFICATION_DEFAULT)).toEqual({ tokens: 200_000 });
    });

    it('resolves the OpenAI chat default', () => {
      config.llmProvider = 'openai';
      expect(contextWindowFor(OPENAI_CHAT_DEFAULT)).toEqual({ tokens: 1_050_000 });
    });

    it('resolves the OpenAI classification default', () => {
      config.llmProvider = 'openai';
      expect(contextWindowFor(OPENAI_CLASSIFICATION_DEFAULT)).toEqual({ tokens: 1_050_000 });
    });

    it('resolves the Anthropic chat default', () => {
      config.llmProvider = 'anthropic';
      expect(contextWindowFor(ANTHROPIC_CHAT_DEFAULT)).toEqual({ tokens: 1_000_000 });
    });

    it('resolves the Anthropic classification default', () => {
      config.llmProvider = 'anthropic';
      expect(contextWindowFor(ANTHROPIC_CLASSIFICATION_DEFAULT)).toEqual({ tokens: 200_000 });
    });
  });

  describe('ID normalization', () => {
    it('strips an unlisted region prefix', () => {
      // `sa.` is a plausible future geo the registry doesn't list yet; it must
      // fall back to the bare ID rather than going dark.
      expect(contextWindowFor('sa.anthropic.claude-opus-5')?.tokens).toBe(1_000_000);
    });

    it('strips a Bedrock version suffix', () => {
      expect(contextWindowFor('us.anthropic.claude-opus-5-v1:0')?.tokens).toBe(1_000_000);
    });

    it('resolves a bare Azure-style name while LLM_PROVIDER is bedrock', () => {
      // Cross-provider fallback: an operator can point either provider at the
      // other's ID spelling, and a known model should still resolve.
      expect(contextWindowFor('claude-haiku-4-5')?.tokens).toBe(200_000);
    });

    it('resolves a Bedrock-style ID while LLM_PROVIDER is azure', () => {
      config.llmProvider = 'azure';
      expect(contextWindowFor('us.anthropic.claude-opus-5')?.tokens).toBe(1_000_000);
    });
  });

  describe('provider-scoped lookup', () => {
    // Every `context` value in the current snapshot agrees across providers and
    // regions, so provider *preference* isn't observable through this API yet.
    // What is worth pinning down is that each provider's own entries resolve, and
    // that a model only one provider lists still resolves from the other.
    it('resolves each region spelling to its own entry', () => {
      for (const region of ['us', 'eu', 'au', 'jp', 'global']) {
        expect(contextWindowFor(`${region}.anthropic.claude-sonnet-4-6`)?.tokens).toBe(1_000_000);
      }
    });

    it('resolves a model only the other provider lists', () => {
      // `claude-opus-4-6` is a bare Azure deployment name with no bare Bedrock
      // counterpart; Bedrock spells it `anthropic.claude-opus-4-6-v1`.
      config.llmProvider = 'bedrock';
      expect(contextWindowFor('claude-opus-4-6')?.tokens).toBe(1_000_000);
    });
  });

  describe('unknown models', () => {
    it('returns null for a custom Azure deployment name', () => {
      config.llmProvider = 'azure';
      expect(contextWindowFor('my-opus-deploy')).toBeNull();
    });

    it('returns null for a non-Claude model', () => {
      expect(contextWindowFor('amazon.titan-embed-text-v2:0')).toBeNull();
    });

    it('returns null for an empty model ID', () => {
      expect(contextWindowFor('')).toBeNull();
    });
  });

  describe('CONTEXT_WINDOW_TOKENS override', () => {
    it('wins over the snapshot and is tagged as env-sourced', () => {
      config.contextWindowTokens = 50_000;
      expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 50_000 });
    });

    it('rescues an otherwise-unknown model', () => {
      config.llmProvider = 'azure';
      config.contextWindowTokens = 400_000;
      expect(contextWindowFor('my-opus-deploy')).toEqual({ tokens: 400_000 });
    });

    it('falls through to the snapshot when config parsed the env var away', () => {
      // config.ts collapses junk / non-positive values to null; this asserts the
      // lookup treats that as "no override" rather than as a zero-token window.
      config.contextWindowTokens = null;
      expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 1_000_000 });
    });
  });

});
