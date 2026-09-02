import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConfig: {
  openaiApiKey?: string;
  openaiRealtimeModel: string;
  openaiRealtimeUrl?: string;
} = {
  openaiApiKey: undefined,
  openaiRealtimeModel: 'gpt-realtime',
  openaiRealtimeUrl: undefined,
};
vi.mock('../../../config', () => ({ config: mockConfig }));

const { resolveRealtimeEndpoint, isRealtimeConfigured, buildRealtimeSocketOptions } = await import(
  '../openai-endpoint'
);

const savedProxy = process.env.HTTPS_PROXY;

beforeEach(() => {
  mockConfig.openaiApiKey = 'sk-test-key';
  mockConfig.openaiRealtimeModel = 'gpt-realtime';
  mockConfig.openaiRealtimeUrl = undefined;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
});

afterEach(() => {
  if (savedProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = savedProxy;
});

describe('resolveRealtimeEndpoint', () => {
  it('connects directly to OpenAI — there is no gateway mount for Realtime', () => {
    const endpoint = resolveRealtimeEndpoint();
    expect(endpoint.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
  });

  it('takes the host from OPENAI_REALTIME_URL when it is set', () => {
    mockConfig.openaiRealtimeUrl = 'ws://127.0.0.1:3103/v1/realtime';
    expect(resolveRealtimeEndpoint().url).toBe(
      'ws://127.0.0.1:3103/v1/realtime?model=gpt-realtime',
    );
  });

  it('still requires a key against an overridden host', () => {
    // The host moves; nothing about authentication does, so a local voice model
    // is reached the same way the real one is.
    mockConfig.openaiRealtimeUrl = 'ws://127.0.0.1:3103/v1/realtime';
    mockConfig.openaiApiKey = undefined;
    expect(() => resolveRealtimeEndpoint()).toThrow(/OPENAI_API_KEY is not set/);
  });

  it('sends the key as a header, so a credential sentinel stays rewritable', () => {
    mockConfig.openaiApiKey = '__nexus_cred:0d1a-uuid__';
    const endpoint = resolveRealtimeEndpoint();

    // The sandbox MITM can only swap a sentinel it can see in a header.
    expect(endpoint.headers.Authorization).toBe('Bearer __nexus_cred:0d1a-uuid__');
    expect(endpoint.url).not.toContain('nexus_cred');
  });

  it('does not send the retired preview beta header', () => {
    expect(Object.keys(resolveRealtimeEndpoint().headers)).toEqual(['Authorization']);
  });

  it('honours the configured model and an explicit override', () => {
    mockConfig.openaiRealtimeModel = 'gpt-realtime-mini';
    expect(resolveRealtimeEndpoint().url).toContain('model=gpt-realtime-mini');
    expect(resolveRealtimeEndpoint('gpt-realtime-2.1').url).toContain('model=gpt-realtime-2.1');
  });

  it('url-encodes the model name', () => {
    expect(resolveRealtimeEndpoint('weird/model name').url).toContain('model=weird%2Fmodel%20name');
  });

  it('throws a clear error when no key is configured', () => {
    mockConfig.openaiApiKey = undefined;
    expect(() => resolveRealtimeEndpoint()).toThrow(/OPENAI_API_KEY is not set/);
  });

  it('reports a proxy only when one is explicitly configured', () => {
    expect(resolveRealtimeEndpoint().proxyUrl).toBeUndefined();
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    expect(resolveRealtimeEndpoint().proxyUrl).toBe('http://proxy.internal:3128');
  });
});

describe('isRealtimeConfigured', () => {
  it('follows the presence of a key', () => {
    expect(isRealtimeConfigured()).toBe(true);
    mockConfig.openaiApiKey = undefined;
    expect(isRealtimeConfigured()).toBe(false);
  });
});

describe('buildRealtimeSocketOptions', () => {
  it('passes headers through with no agent when there is no proxy', async () => {
    const options = await buildRealtimeSocketOptions(resolveRealtimeEndpoint());
    expect(options.headers.Authorization).toBe('Bearer sk-test-key');
    expect(options.agent).toBeUndefined();
  });

  it('adds a proxy agent when HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    const options = await buildRealtimeSocketOptions(resolveRealtimeEndpoint());
    expect(options.agent).toBeDefined();
    expect(options.headers.Authorization).toBe('Bearer sk-test-key');
  });
});
