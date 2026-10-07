import './llm-cache';
import '../../src/lib/environment';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';
import { MANAGED_VOICE_KEY, MANAGED_VOICE_PATH } from './managed-voice';

// Exercise real discovery before config loads. OpenRouter precedes Azure but
// cannot serve Realtime; chat retains its independently configured provider.
process.env.OPENAI_REALTIME_URL = '';
process.env.OPENAI_REALTIME_API_KEY = '';
process.env.LENS_MANAGED_INFERENCE_PROVIDER = 'bedrock';
process.env.LENS_MANAGED_INFERENCE_PROVIDERS = '["bedrock","openrouter","azure"]';
process.env.LENS_INFERENCE_AZURE_OPENAI_BASE_URL = `http://127.0.0.1:${MOCK_REALTIME_PORT}${MANAGED_VOICE_PATH}`;
process.env.LENS_INFERENCE_AZURE_OPENAI_API_KEY = MANAGED_VOICE_KEY;
// Keep the chat stub local to config. Publishing it into process.env changes
// Codex's auth selection from Bedrock to a nonexistent direct OpenAI key.
// Export the boot promise so harness tests await startup and surface failures.
export const runtimeReady = import('../../src/config').then(({ config }) => {
  config.openaiApiKey ||= 'sk-e2e-not-a-real-key';
  return import('../../src/index');
});
