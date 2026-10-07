import { afterEach, expect, it, vi } from 'vitest';
import { MANAGED_VOICE_KEY, MANAGED_VOICE_PATH } from './managed-voice';
import { resolveRealtimeConfiguration } from '../../src/lib/managed-realtime';
import { codexAuthMethod } from '../../src/lib/coding-agents/codex/credentials';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock('../../src/config');
  vi.doUnmock('../../src/index');
});
vi.mock('../../src/lib/environment', () => ({}));
vi.mock('./llm-cache', () => ({}));

it.each([undefined, '', 'test-api-key'])('discovers managed voice without changing inherited key %s', async (apiKey) => {
  vi.resetModules();
  if (apiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = apiKey;
  const config = { openaiApiKey: apiKey };
  vi.doMock('../../src/config', () => ({ config }));
  const runtimeStarted = vi.fn();
  vi.doMock('../../src/index', () => {
    runtimeStarted();
    return {};
  });

  const { runtimeReady } = await import('./runtime-entry');
  await runtimeReady;
  expect(runtimeStarted).toHaveBeenCalledOnce();
  expect(config.openaiApiKey).toBe(apiKey || 'sk-e2e-not-a-real-key');
  // Child coding agents must inherit the caller's credentials, never the mock's key.
  expect(process.env.OPENAI_API_KEY).toBe(apiKey);
  expect(codexAuthMethod({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-token',
    CODEX_HOME: '/nonexistent-prism-e2e-codex-home',
  })).toBe(apiKey ? 'api' : 'bedrock');
  expect(process.env.OPENAI_REALTIME_URL).toBe('');
  expect(resolveRealtimeConfiguration(process.env)).toMatchObject({
    source: 'managed', provider: 'azure', apiKey: MANAGED_VOICE_KEY,
    url: `ws://127.0.0.1:${process.env.MOCK_REALTIME_PORT || 3103}${MANAGED_VOICE_PATH}/realtime`,
  });
});
