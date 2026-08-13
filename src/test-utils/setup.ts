/**
 * Test Setup
 *
 * Runs before all tests. Mocks the centralized config module.
 * Mock lifecycle (reset/restore) is handled by vitest.config.ts.
 */

import { vi, beforeEach } from 'vitest';

// Silence console output during tests to keep terminal clean.
// Tests that need to assert on console calls can use vi.mocked(console.error).
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

vi.mock('../config', () => ({
  config: {
    port: 3003,
    agentId: 'test-agent-id',
    agentDefaults: {},
    // Keep the boot-time models.dev refresh off in unit tests
    modelsDevUrl: null,
    bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    bedrockClassificationModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    awsRegion: 'us-east-1',
    awsAccessKeyId: undefined,
    awsSecretAccessKey: undefined,
    nexusMcpUrl: 'http://localhost:3002/mcp',
    langfuseSecretKey: undefined,
    langfusePublicKey: undefined,
    langfuseBaseUrl: 'http://localhost:3100',
    // Voice meetings. The transcriber is named here because the Realtime session
    // sends it in `session.update`, so an undefined value would be asserted on.
    openaiTranscriptionModel: 'gpt-realtime-whisper',
    // Same reason: the session sends a reasoning level, and undefined here would
    // silently drop the field rather than fail. The real default lives in
    // config.ts and is asserted in config.test.ts, which loads the module itself.
    openaiRealtimeReasoningEffort: 'high',
  },
}));
