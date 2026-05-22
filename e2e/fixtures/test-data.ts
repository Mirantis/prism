/**
 * Test Data Constants — seed data for e2e tests.
 */

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
