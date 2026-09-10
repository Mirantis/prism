import { config } from '../../src/config';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';

// The voice mock needs a key; coding agents inherit the real environment credentials.
config.openaiApiKey ||= 'sk-e2e-not-a-real-key';
config.openaiRealtimeUrl = `ws://127.0.0.1:${MOCK_REALTIME_PORT}/v1/realtime`;

void import('../../src/index');
