import { describe, expect, it } from 'vitest';
import { anthropicCachePoint, cacheTtlMs } from './llm-provider';

describe('anthropicCachePoint', () => {
  it('asks for the lifetime it is given, which cacheTtlMs reads back', () => {
    expect(anthropicCachePoint('1h')).toEqual({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } });
    expect(anthropicCachePoint('5m')).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(cacheTtlMs(anthropicCachePoint('1h'))).toBe(60 * 60 * 1000);
    expect(cacheTtlMs(anthropicCachePoint())).toBe(5 * 60 * 1000);
    expect(cacheTtlMs({})).toBe(5 * 60 * 1000);
  });
});
