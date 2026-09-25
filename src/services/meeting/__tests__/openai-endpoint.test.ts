import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConfig: {
  openaiRealtimeApiKey?: string;
  openaiRealtimeModel: string;
  openaiRealtimeUrl?: string;
} = {
  openaiRealtimeApiKey: undefined,
  openaiRealtimeModel: 'gpt-live-1',
  openaiRealtimeUrl: undefined,
};
vi.mock('../../../config', () => ({ config: mockConfig }));

const {
  resolveLiveEndpoint,
  resolveTranscriptionEndpoint,
  isRealtimeConfigured,
  buildRealtimeSocketOptions,
} = await import(
  '../openai-endpoint'
);

const savedProxy = process.env.HTTPS_PROXY;

beforeEach(() => {
  mockConfig.openaiRealtimeApiKey = 'sk-test-key';
  mockConfig.openaiRealtimeModel = 'gpt-live-1';
  mockConfig.openaiRealtimeUrl = undefined;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
});

afterEach(() => {
  if (savedProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = savedProxy;
});

describe('resolveLiveEndpoint', () => {
  it('connects directly to OpenAI when no voice endpoint is configured', () => {
    expect(resolveLiveEndpoint().url).toBe('wss://api.openai.com/v1/live/sessions');
  });

  it('opens beside a managed Realtime endpoint, with its scoped placeholder for auth', () => {
    mockConfig.openaiRealtimeUrl = 'wss://lens.example/prefix/v1/projects/p/llm/openai/v1/realtime';
    mockConfig.openaiRealtimeApiKey = '__lens_cred:nexus-llm-openai__';
    expect(resolveLiveEndpoint()).toMatchObject({
      url: 'wss://lens.example/prefix/v1/projects/p/llm/openai/v1/live/sessions',
      headers: { Authorization: 'Bearer __lens_cred:nexus-llm-openai__' },
    });
    expect(isRealtimeConfigured()).toBe(true);
  });

  it('takes the host from OPENAI_REALTIME_URL when it is set', () => {
    mockConfig.openaiRealtimeUrl = 'ws://127.0.0.1:3103/v1/realtime';
    expect(resolveLiveEndpoint().url).toBe('ws://127.0.0.1:3103/v1/live/sessions');
  });

  it('accepts an encrypted override to any host', () => {
    mockConfig.openaiRealtimeUrl = 'wss://voice.internal/v1/realtime';
    expect(resolveLiveEndpoint().url).toBe('wss://voice.internal/v1/live/sessions');
  });

  it('accepts a plaintext override to each loopback spelling', () => {
    for (const host of ['localhost:3103', '127.0.0.1:3103', '[::1]:3103']) {
      mockConfig.openaiRealtimeUrl = `ws://${host}/v1/realtime`;
      expect(resolveLiveEndpoint().url).toBe(`ws://${host}/v1/live/sessions`);
    }
  });

  it('refuses a plaintext override to any other host, which would send the key in the clear', () => {
    mockConfig.openaiRealtimeUrl = 'ws://voice.internal/v1/realtime';
    expect(() => resolveLiveEndpoint()).toThrow(/must be wss:\/\/, or ws:\/\/ to localhost/);
  });

  it('refuses an override that is not a URL', () => {
    mockConfig.openaiRealtimeUrl = '127.0.0.1:3103/v1/realtime';
    expect(() => resolveLiveEndpoint()).toThrow(/Realtime endpoint is not a valid URL/);
  });

  it('keeps a query string the override already carries', () => {
    mockConfig.openaiRealtimeUrl = 'wss://voice.internal/v1/realtime?tenant=alpha';
    expect(resolveLiveEndpoint().url).toBe('wss://voice.internal/v1/live/sessions?tenant=alpha');
  });

  it('puts no model in the URL, since the model travels in session.start', () => {
    mockConfig.openaiRealtimeModel = 'gpt-live-1';
    expect(resolveLiveEndpoint().url).not.toContain('model=');
  });

  it('still requires a key against an overridden host', () => {
    // The host moves; nothing about authentication does, so a local voice model
    // is reached the same way the real one is.
    mockConfig.openaiRealtimeUrl = 'ws://127.0.0.1:3103/v1/realtime';
    mockConfig.openaiRealtimeApiKey = undefined;
    expect(() => resolveLiveEndpoint()).toThrow(/No Realtime credential configured/);
  });

  it('sends the key as a header, so a credential sentinel stays rewritable', () => {
    mockConfig.openaiRealtimeApiKey = '__nexus_cred:0d1a-uuid__';
    const endpoint = resolveLiveEndpoint();

    // The sandbox MITM can only swap a sentinel it can see in a header.
    expect(endpoint.headers.Authorization).toBe('Bearer __nexus_cred:0d1a-uuid__');
    expect(endpoint.url).not.toContain('nexus_cred');
  });

  it('sends the key the way both OpenAI and an Azure resource read it', () => {
    // Measured on an Azure resource: a bearer alone is answered with a redirect that
    // puts the key in the URL, while `api-key` starts the session.
    mockConfig.openaiRealtimeUrl = 'wss://example-resource.openai.azure.com/openai/v1/realtime';
    mockConfig.openaiRealtimeApiKey = 'azure-key';

    expect(resolveLiveEndpoint().headers).toEqual({ Authorization: 'Bearer azure-key', 'api-key': 'azure-key' });
  });

  it('sends no header but the credential', () => {
    expect(Object.keys(resolveLiveEndpoint().headers)).toEqual(['Authorization', 'api-key']);
  });

  it('throws a clear error when no key is configured', () => {
    mockConfig.openaiRealtimeApiKey = undefined;
    expect(() => resolveLiveEndpoint()).toThrow(/No Realtime credential configured/);
  });

  it('reports a proxy only when one is explicitly configured', () => {
    expect(resolveLiveEndpoint().proxyUrl).toBeUndefined();
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    expect(resolveLiveEndpoint().proxyUrl).toBe('http://proxy.internal:3128');
  });
});

describe('resolveTranscriptionEndpoint', () => {
  it('asks the Realtime socket for a transcription session, with no model', () => {
    expect(resolveTranscriptionEndpoint().url).toBe(
      'wss://api.openai.com/v1/realtime?intent=transcription',
    );
  });

  it('keeps a query string the override already carries', () => {
    mockConfig.openaiRealtimeUrl = 'wss://voice.internal/v1/realtime?tenant=alpha';
    expect(resolveTranscriptionEndpoint().url).toBe(
      'wss://voice.internal/v1/realtime?tenant=alpha&intent=transcription',
    );
  });

  it('holds the same transport rules as a call', () => {
    mockConfig.openaiRealtimeUrl = 'ws://voice.internal/v1/realtime';
    expect(() => resolveTranscriptionEndpoint()).toThrow(/must be wss:\/\//);
    mockConfig.openaiRealtimeUrl = undefined;
    mockConfig.openaiRealtimeApiKey = undefined;
    expect(() => resolveTranscriptionEndpoint()).toThrow(/No Realtime credential configured/);
  });
});

describe('isRealtimeConfigured', () => {
  it('follows the presence of a key', () => {
    expect(isRealtimeConfigured()).toBe(true);
    mockConfig.openaiRealtimeApiKey = undefined;
    expect(isRealtimeConfigured()).toBe(false);
  });
});

describe('buildRealtimeSocketOptions', () => {
  it('passes headers through with no agent when there is no proxy', async () => {
    const options = await buildRealtimeSocketOptions(resolveLiveEndpoint());
    expect(options.headers.Authorization).toBe('Bearer sk-test-key');
    expect(options.agent).toBeUndefined();
  });

  it('adds a proxy agent when HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    const options = await buildRealtimeSocketOptions(resolveLiveEndpoint());
    expect(options.agent).toBeDefined();
    expect(options.headers.Authorization).toBe('Bearer sk-test-key');
  });
});
