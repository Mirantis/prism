import { config } from '../../src/config';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';

const E2E_FAKE_KEY = 'sk-e2e-not-a-real-key';

// The voice mock needs a key; coding agents inherit the real environment credentials.
config.openaiApiKey ||= E2E_FAKE_KEY;
// Voice resolves its credential separately from chat, so it needs its own stub.
config.openaiRealtimeApiKey = E2E_FAKE_KEY;
config.openaiRealtimeUrl = `ws://127.0.0.1:${MOCK_REALTIME_PORT}/v1/realtime`;

void import('../../src/index');
