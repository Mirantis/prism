import { expect, it } from 'vitest';
import { MANAGED_VOICE_KEY, MANAGED_VOICE_PATH } from './managed-voice';
import { LLM_CACHE_VARIABLES, llmCacheEnv, webSuiteRuntimeEnv } from './runtime-command';

it('points managed voice discovery at the mock and leaves the inherited OpenAI key alone', () => {
  const env = webSuiteRuntimeEnv();
  expect(env).toMatchObject({
    OPENAI_REALTIME_URL: '',
    LENS_INFERENCE_AZURE_OPENAI_API_KEY: MANAGED_VOICE_KEY,
    LENS_INFERENCE_AZURE_OPENAI_BASE_URL: `http://127.0.0.1:${process.env.MOCK_REALTIME_PORT || 3103}${MANAGED_VOICE_PATH}`,
  });
  // Child coding agents inherit the caller's credentials, never a mock key.
  expect(env).not.toHaveProperty('OPENAI_API_KEY');
});

it('hands the runtime the cache variables as regular expression sources', () => {
  const variables = JSON.parse(llmCacheEnv().PRISM_LLM_CACHE_VARIABLES) as Record<string, string>;
  expect(Object.keys(variables)).toEqual(Object.keys(LLM_CACHE_VARIABLES));
  expect(new RegExp(variables.date).exec("Today's date (UTC): 2026-11-06 (Friday)")?.[0]).toBe('2026-11-06 (Friday)');
  expect(new RegExp(variables.uuid).test('6d6b8f7e-3c2a-4b8e-9f1d-0a1b2c3d4e5f')).toBe(true);
});
