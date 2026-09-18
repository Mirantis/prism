import { describe, expect, it } from 'vitest';
import { resolveRealtimeConfiguration } from './managed-realtime';

const azure = {
  LENS_INFERENCE_AZURE_OPENAI_BASE_URL: 'https://lens.example/prefix/v1/projects/p/llm/azure/openai/v1/',
  LENS_INFERENCE_AZURE_OPENAI_API_KEY: '__lens_cred:nexus-llm-azure-openai__',
};
const openai = {
  LENS_INFERENCE_OPENAI_BASE_URL: 'https://lens.example/v1/projects/p/llm/openai/v1',
  LENS_INFERENCE_OPENAI_API_KEY: '__lens_cred:nexus-llm-openai__',
};
const ordered = (primary: string, list: string[]) => ({
  LENS_MANAGED_INFERENCE_PROVIDER: primary,
  LENS_MANAGED_INFERENCE_PROVIDERS: JSON.stringify(list),
});

describe('managed Realtime discovery', () => {
  it.each([
    ['bedrock', ['bedrock', 'azure'], 'azure'],
    ['bedrock', ['bedrock', 'openai'], 'openai'],
    ['bedrock', ['bedrock', 'azure', 'openai'], 'azure'],
    ['bedrock', ['bedrock', 'openai', 'azure'], 'openai'],
    ['azure', ['openai', 'azure'], 'azure'],
    ['openai', ['azure', 'openai'], 'openai'],
    ['openrouter', ['openrouter', 'bedrock-mantle', 'azure'], 'azure'],
    ['future-provider', ['future-provider', 'azure'], 'azure'],
  ] as const)('selects %s / %j as %s', (primary, list, expected) => {
    const result = resolveRealtimeConfiguration({ ...azure, ...openai, ...ordered(primary, [...list]) });
    expect(result).toMatchObject({ source: 'managed', provider: expected });
    expect(result.apiKey).toBe(expected === 'azure' ? azure.LENS_INFERENCE_AZURE_OPENAI_API_KEY : openai.LENS_INFERENCE_OPENAI_API_KEY);
    expect(result.url).toBe((expected === 'azure' ? azure.LENS_INFERENCE_AZURE_OPENAI_BASE_URL : openai.LENS_INFERENCE_OPENAI_BASE_URL).replace(/\/+$/, '').replace('https:', 'wss:') + '/realtime');
  });

  it('uses stable legacy discovery and skips incomplete pairs', () => {
    expect(resolveRealtimeConfiguration({ ...azure, ...openai }).provider).toBe('openai');
    expect(resolveRealtimeConfiguration({ ...azure, ...openai, LENS_INFERENCE_OPENAI_API_KEY: '' }).provider).toBe('azure');
    expect(resolveRealtimeConfiguration(azure).provider).toBe('azure');
  });

  it('does not select stale endpoints outside the declared provider list', () => {
    expect(resolveRealtimeConfiguration({ ...azure, ...openai, ...ordered('openrouter', ['openrouter']) }).source).toBe('unavailable');
  });

  it('does not infer a Realtime route from OpenRouter chat compatibility', () => {
    expect(resolveRealtimeConfiguration({
      ...ordered('openrouter', ['openrouter']),
      LENS_INFERENCE_OPENROUTER_BASE_URL: 'https://lens.example/v1/projects/p/llm/openrouter/openai/v1',
      LENS_INFERENCE_OPENROUTER_API_KEY: 'router-key',
      OPENAI_API_KEY: 'router-key',
    })).toMatchObject({ source: 'unavailable' });
  });

  it('keeps a dedicated direct key separate from the selected managed credential', () => {
    expect(resolveRealtimeConfiguration({ ...azure, OPENAI_REALTIME_API_KEY: 'direct-key' }).apiKey)
      .toBe(azure.LENS_INFERENCE_AZURE_OPENAI_API_KEY);
  });

  it('allows direct voice with a dedicated key when managed chat has no voice candidate', () => {
    expect(resolveRealtimeConfiguration({ ...ordered('bedrock', ['bedrock', 'openrouter']), OPENAI_REALTIME_API_KEY: 'direct-key' }))
      .toEqual({ source: 'direct', provider: 'openai', apiKey: 'direct-key' });
  });

  it('preserves standalone direct OpenAI credentials', () => {
    expect(resolveRealtimeConfiguration({ OPENAI_API_KEY: 'direct-key' }).source).toBe('direct');
    expect(resolveRealtimeConfiguration({ OPENAI_API_KEY: 'direct-key', OPENAI_BASE_URL: 'https://api.openai.com/v1/' }).source).toBe('direct');
  });

  it('does not repurpose a custom chat credential for direct voice', () => {
    expect(resolveRealtimeConfiguration({ OPENAI_BASE_URL: 'https://chat.example/v1', OPENAI_API_KEY: 'chat-key' }).source).toBe('unavailable');
  });

  it.each(['__lens_cred:nexus-llm-openai__', '__nexus_cred:nexus-llm-azure-openai__'])('never sends managed placeholder %s to direct OpenAI', (apiKey) => {
    expect(resolveRealtimeConfiguration({ OPENAI_REALTIME_API_KEY: apiKey }).source).toBe('unavailable');
  });

  it('recognizes a managed credential by its namespaced alias, even with an opaque ID', () => {
    expect(resolveRealtimeConfiguration({ LENS_INFERENCE_OPENROUTER_API_KEY: '__lens_cred:opaque__', OPENAI_REALTIME_API_KEY: '__lens_cred:opaque__' }).source).toBe('unavailable');
  });

  it('preserves explicit endpoint and key overrides', () => {
    expect(resolveRealtimeConfiguration({ ...azure, OPENAI_REALTIME_URL: 'wss://voice.example/realtime', OPENAI_REALTIME_API_KEY: 'voice-key' }))
      .toEqual({ source: 'explicit', url: 'wss://voice.example/realtime', apiKey: 'voice-key' });
  });

  it('rejects a managed key even when direct OpenAI is explicitly selected', () => {
    expect(resolveRealtimeConfiguration({
      ...azure,
      OPENAI_REALTIME_URL: 'wss://api.openai.com/v1/realtime',
      OPENAI_API_KEY: azure.LENS_INFERENCE_AZURE_OPENAI_API_KEY,
    }).apiKey).toBeUndefined();
  });

  it('does not borrow a discovered key for an explicit endpoint', () => {
    expect(resolveRealtimeConfiguration({ ...azure, OPENAI_REALTIME_URL: 'wss://voice.example/realtime' }).apiKey).toBeUndefined();
  });

  it('reports why voice is unavailable without credentials', () => {
    expect(resolveRealtimeConfiguration({}).unavailableReason).toContain('OPENAI_REALTIME_API_KEY');
  });

  it('accepts managed loopback HTTP but rejects remote plaintext', () => {
    expect(resolveRealtimeConfiguration({ ...azure, LENS_INFERENCE_AZURE_OPENAI_BASE_URL: 'http://127.0.0.1:3103/v1' }).url).toBe('ws://127.0.0.1:3103/v1/realtime');
    expect(() => resolveRealtimeConfiguration({ ...azure, LENS_INFERENCE_AZURE_OPENAI_BASE_URL: 'http://voice.example/v1' })).toThrow(/HTTPS/);
  });

  it.each(['null', '{}', '[1]'])('reports an invalid provider list: %s', (list) => {
    expect(() => resolveRealtimeConfiguration({ LENS_MANAGED_INFERENCE_PROVIDERS: list })).toThrow(/JSON array/);
  });
});
