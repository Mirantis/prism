/**
 * Step Usage Tests
 *
 * Converting one model call's SDK usage into the shape the runtime records, and
 * adding a turn's steps together for the invocation total the goal loop meters.
 *
 * The distinction that matters throughout: a provider reporting no measurement
 * yields nothing, not a row of zeros, because zeros claim a call that cost
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import { foldStepUsage, toStepUsage } from './step-usage';
import type { StepUsage } from '../types';

function usage(over: Partial<StepUsage> = {}): StepUsage {
  return {
    model: 'claude-opus-5',
    totalTokens: 1100,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    noCacheTokens: 200,
    ...over,
  };
}

describe('toStepUsage', () => {
  it('carries the cache split through', () => {
    const result = toStepUsage('claude-opus-5', {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100, noCacheTokens: 200 },
      outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
    });

    expect(result).toEqual(usage());
  });

  it("keeps the provider's own total when it exceeds input plus output", () => {
    // A model billing reasoning tokens reports a total above the split.
    const result = toStepUsage('claude-opus-5', {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1400,
      inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100, noCacheTokens: 200 },
      outputTokenDetails: { textTokens: 60, reasoningTokens: 40 },
    });

    expect(result?.totalTokens).toBe(1400);
  });

  it('falls back to input plus output when the provider reports no total', () => {
    const result = toStepUsage('claude-opus-5', {
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: undefined,
      inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100, noCacheTokens: 200 },
      outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
    });

    expect(result?.totalTokens).toBe(1100);
  });

  it('returns nothing when the provider reported neither figure', () => {
    expect(toStepUsage('m', undefined)).toBeUndefined();
    expect(
      toStepUsage('m', {
        inputTokens: undefined,
        outputTokens: 5,
        totalTokens: undefined,
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      }),
    ).toBeUndefined();
  });

  it('keeps a total the provider gave without a prompt size', () => {
    // The goal loop meters its budget against totalTokens, so discarding a
    // partial report would leave it counting zero for ever.
    const result = toStepUsage('m', {
      inputTokens: undefined,
      outputTokens: 5,
      totalTokens: 900,
      inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: undefined },
      outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
    });

    expect(result).toEqual({
      model: 'm',
      totalTokens: 900,
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
    });
  });

  it('keeps a Bedrock Converse model whole, cache-free but measured', () => {
    // Captured from `us.meta.llama3-3-70b-instruct-v1:0` over Bedrock Converse —
    // the path every non-Anthropic model takes, Grok included. Converse reports
    // its uncached prompt as `noCacheTokens` and no cache tokens at all, so the
    // three details still sum to the prompt and the rate is a true 0%, not an
    // absent measurement.
    const result = toStepUsage('us.meta.llama3-3-70b-instruct-v1:0', {
      inputTokens: 42,
      outputTokens: 2,
      totalTokens: 44,
      inputTokenDetails: { noCacheTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2, reasoningTokens: undefined },
    });

    expect(result).toEqual({
      model: 'us.meta.llama3-3-70b-instruct-v1:0',
      totalTokens: 44,
      inputTokens: 42,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 42,
    });

    // The identity the cache rate divides by.
    const details =
      result!.cacheReadTokens + result!.cacheWriteTokens + result!.noCacheTokens;
    expect(details).toBe(result!.inputTokens);
  });

  it('zeroes a cache split the provider omits, keeping the prompt size', () => {
    const result = toStepUsage('gpt-5.6-sol', {
      inputTokens: 900,
      outputTokens: 50,
      totalTokens: 950,
      inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: undefined },
      outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
    });

    expect(result).toEqual({
      model: 'gpt-5.6-sol',
      totalTokens: 950,
      inputTokens: 900,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
    });
  });
});

describe('foldStepUsage', () => {
  it('adds every count and keeps the model', () => {
    expect(foldStepUsage([usage(), usage(), usage()])).toEqual({
      model: 'claude-opus-5',
      totalTokens: 3300,
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 2100,
      cacheWriteTokens: 300,
      noCacheTokens: 600,
    });
  });

  it('sums the prompt once per step, since each step resends it', () => {
    // Two steps of a growing conversation: billed input is both prompts, not
    // the larger of the two.
    const folded = foldStepUsage([usage({ inputTokens: 1000 }), usage({ inputTokens: 1400 })]);

    expect(folded?.inputTokens).toBe(2400);
  });

  it('returns nothing for no steps, rather than a row of zeros', () => {
    expect(foldStepUsage([])).toBeUndefined();
  });

  it('leaves a single step untouched', () => {
    expect(foldStepUsage([usage()])).toEqual(usage());
  });
});
