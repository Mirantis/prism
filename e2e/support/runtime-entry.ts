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
// Coding agents retain the real environment credentials; never use this chat
// stub as the managed voice credential.
process.env.OPENAI_API_KEY ||= 'sk-e2e-not-a-real-key';

void import('../../src/index');
