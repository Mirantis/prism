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
// can safely be shared because nothing writes here — any test that needs to put
// something on disk pins its own PRISM_DATA_DIR (or PRISM_SKILLS_DIR /
// PRISM_PLUGINS_DIR), and this default exists only so the rest read an empty one.
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
    noiseReduction: 'off',
    // Same reason: the session sends a reasoning level, and undefined here would
    // silently drop the field rather than fail. The real default lives in
    // config.ts and is asserted in config.test.ts, which loads the module itself.
    openaiRealtimeReasoningEffort: 'high',
    // Read at log time rather than at startup, so leaving it out would silently take
    // whichever branch `undefined` happens to fall into.
    meetingTranscriptLogging: 'off',
    // The follow-up window's real defaults, and they have to be here rather than left
    // undefined. `tsconfig.json` excludes test files, so nothing typechecks a mock with a
    // key missing — and the omission is not inert: `undefined <= 0` and `elapsed >
    // undefined` are both false, so a window built from an unset value arms, accepts and
    // never expires. Every test that thought it was exercising an eight-second window was
    // exercising an infinite one.
    meetingFollowUpWindowMs: 8_000,
    meetingLocalAddressedRead: false,
  },
}));
