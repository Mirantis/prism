import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '', 'test-api-key'])('starts the voice mock with environment key %s', async (apiKey) => {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', apiKey);
  const config = { openaiApiKey: apiKey, openaiRealtimeUrl: undefined as string | undefined };
  vi.doMock('../../src/config', () => ({ config }));
  const runtimeStarted = vi.fn(() => {
    expect(config.openaiApiKey).toBe(apiKey || 'sk-e2e-not-a-real-key');
    expect(config.openaiRealtimeUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/realtime$/);
    expect(process.env.OPENAI_API_KEY).toBe(apiKey);
  });
  vi.doMock('../../src/index', () => {
    runtimeStarted();
    return {};
  });
  await import('./runtime-entry');
  await vi.dynamicImportSettled();
  expect(runtimeStarted).toHaveBeenCalledOnce();
});
