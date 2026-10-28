/**
 * Test Setup
 *
 * Runs before all tests. Mocks the centralized config module.
 * Mock lifecycle (reset/restore) is handled by vitest.config.ts.
 */

import { vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the on-disk catalogs at an empty scratch dir unless a test pins its own.
// Both the skill and plugin catalogs resolve from PRISM_DATA_DIR, so without
// this a developer with real skills or plugins under ~/.prism would get
// different results from CI — green here, red there, or the reverse.
//
// One fixed path rather than a fresh mkdtemp: this file runs once per test file,
// so a unique dir per run would leak hundreds of them into the OS temp dir. It
// can safely be shared because nothing reads across tests from here — any test
// that needs to put something on disk and read it back pins its own
// PRISM_DATA_DIR (or PRISM_SKILLS_DIR / PRISM_PLUGINS_DIR), and this default
// exists only so the rest read an empty one. A test that runs an oversized tool
// result through the output capture will drop a saved copy under
// `<scratch>/tool-outputs`; it is inert, but pin your own dir if you assert on it.
const scratchDataDir = path.join(os.tmpdir(), 'prism-test-data');
fs.mkdirSync(scratchDataDir, { recursive: true });
process.env.PRISM_DATA_DIR = scratchDataDir;

// Silence console output during tests to keep terminal clean.
// Tests that need to assert on console calls can use vi.mocked(console.error).
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

vi.mock('../config', () => ({
  CODING_AGENTS: ['claude-code', 'codex'],
  config: {
    port: 3003,
    host: '127.0.0.1',
    listensOnLoopback: true,
    allowedOrigins: [],
    webhookPort: 3004,
    agentMessagesPort: 3005,
    webhookPublicUrl: null,
    agentId: 'test-agent-id',
    ownerUserId: 'test-owner-id',
    // `lib/prisma.ts` builds its database adapter from this when it loads. The
    // database opens only when a test queries the client.
    databaseUrl: 'file::memory:',
    agentDefaults: {},
    heartbeatIntervalMs: 28_800_000,
    // Self-update: off in unit tests (dev shape). The gate matrix is asserted
    // in update.service.test.ts, which overrides these per case.
    appVersion: '',
    disableUpdater: false,
    // Keep the boot-time models.dev refresh off in unit tests
    modelsDevUrl: null,
    bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    bedrockClassificationModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    classificationModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    modelSelection: { mode: 'fixed', tiers: { small: null, medium: null, large: null } },
    toolRiskGateMode: 'off',
    invalidToolRiskGateMode: null,
    codingAgent: 'claude-code',
    codingAgentModels: {
      'claude-code': {
        small: { default: 'haiku', bedrock: 'global.anthropic.claude-haiku-5-5' },
        medium: { default: 'sonnet', bedrock: 'global.anthropic.claude-sonnet-5-5' },
        large: { default: 'opus', bedrock: 'opus' },
      },
      codex: {
        small: { openai: 'gpt-5.6-luna', bedrock: 'openai.gpt-5.6-luna' },
        medium: { openai: 'gpt-5.6-terra', bedrock: 'openai.gpt-5.6-terra' },
        large: { openai: 'gpt-5.6-sol', bedrock: 'openai.gpt-5.6-sol' },
      },
    },
    availableCodingAgents: ['claude-code'],
    claudeCodeSubscription: false,
    codexSubscription: false,
    claudeCodeSkipPermissions: false,
    awsRegion: 'us-east-1',
    awsAccessKeyId: undefined,
    awsSecretAccessKey: undefined,
    nexusMcpUrl: 'http://localhost:3002/mcp',
    langfuseSecretKey: undefined,
    langfusePublicKey: undefined,
    langfuseBaseUrl: 'http://localhost:3100',
    // Read back when a saved tool output has expired, to say how long copies are
    // kept. Undefined here would render "about NaN days" and still pass a loose
    // assertion.
    toolOutputTtlMs: 7 * 24 * 60 * 60 * 1000,
    // Voice meetings. The transcriber is named here because the Realtime session
    // sends it in `session.update`, so an undefined value would be asserted on.
    openaiTranscriptionModel: 'gpt-realtime-whisper',
    noiseReduction: 'off',
    // Same reason: the session sends a reasoning level, and undefined here would
    // silently drop the field rather than fail. The real default lives in
    // config.ts and is asserted in config.test.ts, which loads the module itself.
    openaiRealtimeReasoningEffort: 'high',
    // Read at log time rather than at startup, so leaving it out would silently take
    // whichever branch `undefined` happens to fall into.
    meetingTranscriptLogging: 'off',
  },
  // The real predicate compares an endpoint's origin against the gateway's. Here
  // `gateway.example.com` is the gateway host — the same host config.test.ts
  // gives NEXUS_API_URL — so a test names the host it means and wires nothing.
  // config.test.ts covers the real implementation.
  isGatewayEndpoint: (url?: string | null) => {
    if (!url) return false;
    try {
      return new URL(url).hostname === 'gateway.example.com';
    } catch {
      return false;
    }
  },
}));
