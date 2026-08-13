/**
 * Test Data Constants — seed data for e2e tests.
 */

import os from 'node:os';
import path from 'node:path';

// Stable UUID for the single agent the runtime runs against during e2e.
// Passed to the runtime as AGENT_ID so its bootstrap path uses this ID
// instead of generating a fresh UUID, and used by db-helper.seed() as
// the upsert key so per-scenario resets keep the same row id.
export const DEFAULT_AGENT_ID = '00000000-0000-0000-0000-0000000000e2';

export const TEST_USER = {
  id: 'e2e-test-user-001',
  email: 'e2e-test@example.com',
  name: 'E2E Test User',
};

export const DEFAULT_AGENT_SEED = {
  name: 'Test Agent',
  soulMd: 'You are a helpful test agent.',
  userMd: 'E2E test user profile.',
  memoryMd: '',
  heartbeatMd: '## Heartbeat\nNo active checks configured.',
};

/**
 * Directory the runtime under test uses as SHELL_WORKSPACE_ROOT — the default
 * cwd for the agent's shell tool, and the base it resolves relative paths
 * against. Lives here rather than in playwright.config.ts so step definitions
 * can reach it without importing the config, whose module body provisions the
 * database as a side effect. playwright.config.ts creates the directory.
 */
export const E2E_WORKSPACE = path.join(os.tmpdir(), 'prism-e2e-workspace');
