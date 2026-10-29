import { describe, expect, it } from 'vitest';
import { anthropicCachePoint, cacheRequestOptions, cacheTtlMs, NO_CACHE_POINT, type LlmProvider } from './llm-provider';

const withPoint = (cachePoint: LlmProvider['cachePoint']) => Object.assign(() => ({}) as never, { cachePoint }) as LlmProvider;

describe('anthropicCachePoint', () => {
  it('asks for the lifetime it is given, which cacheTtlMs reads back', () => {
    const anthropic = withPoint((_id, ttl) => anthropicCachePoint(ttl));
    expect(anthropicCachePoint('1h')).toEqual({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } });
    expect(anthropicCachePoint('5m')).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(cacheTtlMs(anthropic, 'm', '1h')).toBe(60 * 60 * 1000);
    expect(cacheTtlMs(anthropic, 'm', '5m')).toBe(5 * 60 * 1000);
    expect(cacheTtlMs(withPoint(() => NO_CACHE_POINT), 'm', '1h')).toBe(5 * 60 * 1000);
  });

  it('sends no request-level options for a vendor that declares none', () => {
    expect(cacheRequestOptions(withPoint((_id, ttl) => anthropicCachePoint(ttl)), 'm', '1h')).toEqual({});
  });
});
