import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateOpenAI, mockAuth } = vi.hoisted(() => {
  const mockOpenAiModel = vi.fn((modelId: string) => ({ provider: 'chatgpt', modelId }));
  return {
    mockCreateOpenAI: vi.fn(() => mockOpenAiModel),
    mockAuth: {
      isSignedIn: vi.fn(),
      getAccessToken: vi.fn(),
    },
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock('../../../services/chatgpt-auth.service', () => ({
  CHATGPT_API_RESOURCE: 'https://api.openai.com/v1',
  chatGptAuthService: mockAuth,
}));

import { createChatGptProvider, missingChatGptSettings } from './chatgpt-provider';
import { OPENAI_DEFERRED_TOOLS } from '../deferred-tools';
import { cacheRequestOptions, cacheTtlMs } from '../llm-provider';

describe('createChatGptProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('targets https://api.openai.com/v1 with a custom OAuth fetch wrapper', () => {
    const provider = createChatGptProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'chatgpt-oauth',
        baseURL: 'https://api.openai.com/v1',
        fetch: expect.any(Function),
      }),
    );
    expect(provider('gpt-5.6-sol')).toEqual({ provider: 'chatgpt', modelId: 'gpt-5.6-sol' });
    expect(provider.deferredTools?.('gpt-5.6-sol')).toEqual(OPENAI_DEFERRED_TOOLS);
    expect(cacheRequestOptions(provider, 'gpt-5.6-sol', '1h', true)).toEqual({
      openai: { promptCacheOptions: { ttl: '12h' } },
    });
    expect(cacheTtlMs(provider, 'gpt-5.6-sol', '1h')).toBe(12 * 60 * 60 * 1000);
  });

  it('injects the OAuth bearer token and retries once after refreshing on 401', async () => {
    createChatGptProvider();
    const customFetch = mockCreateOpenAI.mock.calls[0][0].fetch as typeof globalThis.fetch;

    mockAuth.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');

    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = upstreamFetch;

    const res = await customFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer chatgpt-oauth' },
    });

    expect(res.status).toBe(200);
    expect(mockAuth.getAccessToken).toHaveBeenNthCalledWith(1);
    expect(mockAuth.getAccessToken).toHaveBeenNthCalledWith(2, true);

    const firstHeaders = new Headers(upstreamFetch.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(upstreamFetch.mock.calls[1][1]?.headers);
    expect(firstHeaders.get('Authorization')).toBe('Bearer stale-token');
    expect(secondHeaders.get('Authorization')).toBe('Bearer fresh-token');
  });

  it('missingChatGptSettings reflects sign-in state', () => {
    mockAuth.isSignedIn.mockReturnValue(false);
    expect(missingChatGptSettings()).toEqual(['ChatGPT sign-in']);

    mockAuth.isSignedIn.mockReturnValue(true);
    expect(missingChatGptSettings()).toEqual([]);
  });
});
