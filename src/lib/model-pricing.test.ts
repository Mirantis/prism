/**
 * Model Pricing Tests
 *
 * The cost math, checked against a cost a coding agent's CLI reported for the same
 * tokens, and the catalog lookup the costs use.
 */

import { describe, it, expect } from 'vitest';
import { costMicroUsd, priceFor, type PricedTokens } from './model-pricing';
import type { ModelPrice } from './model-catalog';

function tokens(over: Partial<PricedTokens>): PricedTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    longCacheWriteTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    ...over,
  };
}

describe('costMicroUsd', () => {
  it('matches the cost Claude Code reported for a run that wrote its cache for an hour', () => {
    // models.dev's price for claude-haiku-5-5, and the `modelUsage` of a captured result
    // line: 2 + 143,355 prompt tokens put the call above the 100k tier, and the CLI
    // reported costUSD 0.14336600000000002.
    const haiku: ModelPrice = {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    };

    expect(
      costMicroUsd(
        haiku,
        tokens({ inputTokens: 143_357, cacheWriteTokens: 143_355, longCacheWriteTokens: 143_355, outputTokens: 4 }),
      ),
    ).toBe(143_366);
  });

  it('uses the base price at and below a tier threshold', () => {
    const price: ModelPrice = { input: 1, output: 2, tiers: [{ above: 1000, input: 10, output: 20 }] };

    expect(costMicroUsd(price, tokens({ inputTokens: 1000, outputTokens: 10 }))).toBe(1000 + 20);
    expect(costMicroUsd(price, tokens({ inputTokens: 1001, outputTokens: 10 }))).toBe(10_010 + 200);
  });

  it('charges the input price for cache reads and writes a model lists no price for', () => {
    expect(costMicroUsd({ input: 2, output: 8 }, tokens({ inputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 100 }))).toBe(600);
  });
});

describe('priceFor', () => {
  it('finds a model under the spellings the providers and coding agents use', () => {
    expect(priceFor('claude-haiku-5-5')).not.toBeNull();
    expect(priceFor('claude-haiku-5-5[1m]')).toEqual(priceFor('claude-haiku-5-5'));
    expect(priceFor('anthropic/claude-haiku-5-5')).toEqual(priceFor('claude-haiku-5-5'));
    expect(priceFor('openai.gpt-5.6-terra')).toEqual(priceFor('gpt-5.6-terra'));
    expect(priceFor('gpt-realtime-2.1')).toMatchObject({ inputAudio: expect.any(Number), outputAudio: expect.any(Number) });
  });

  it('answers null for a model the catalog does not price', () => {
    expect(priceFor('my-litellm-alias')).toBeNull();
    expect(priceFor('gpt-live-transcribe')).toBeNull();
  });
});
