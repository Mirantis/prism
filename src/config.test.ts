/**
 * Config Tests
 *
 * Verifies env var reads and defaults. Unmocks the global config mock
 * from setup.ts so we test the real implementation.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Undo the global mock from setup.ts
vi.unmock('./config');

// Prevent dotenv from loading .env file during tests
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function loadConfig() {
    const mod = await import('./config');
    return mod.config;
  }

  it('reads PORT with default 3003', async () => {
    delete process.env.PORT;
    const cfg = await loadConfig();
    expect(cfg.port).toBe(3003);
  });

  it('reads PORT from env', async () => {
    process.env.PORT = '4000';
    const cfg = await loadConfig();
    expect(cfg.port).toBe(4000);
  });

  it('reads BEDROCK_MODEL_ID with default', async () => {
    delete process.env.BEDROCK_MODEL_ID;
    const cfg = await loadConfig();
    expect(cfg.bedrockModelId).toBe('us.anthropic.claude-opus-5-0');
  });

  it('reads BEDROCK_CLASSIFICATION_MODEL_ID with default', async () => {
    delete process.env.BEDROCK_CLASSIFICATION_MODEL_ID;
    const cfg = await loadConfig();
    expect(cfg.bedrockClassificationModelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('reads AWS_REGION with default us-east-1', async () => {
    delete process.env.AWS_REGION;
    const cfg = await loadConfig();
    expect(cfg.awsRegion).toBe('us-east-1');
  });

  it('reads AWS credential env vars', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'key-123';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-456';
    const cfg = await loadConfig();
    expect(cfg.awsAccessKeyId).toBe('key-123');
    expect(cfg.awsSecretAccessKey).toBe('secret-456');
  });

  it('uses local-owner sentinel when OWNER_USER_ID is unset', async () => {
    delete process.env.OWNER_USER_ID;
    const cfg = await loadConfig();
    expect(cfg.ownerUserId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('reads OWNER_USER_ID / AGENT_NAME / TEAM_NAME from env', async () => {
    process.env.OWNER_USER_ID = 'owner-uuid';
    process.env.AGENT_NAME = 'Custom';
    process.env.TEAM_NAME = 'Acme';
    const cfg = await loadConfig();
    expect(cfg.ownerUserId).toBe('owner-uuid');
    expect(cfg.agentName).toBe('Custom');
    expect(cfg.teamName).toBe('Acme');
  });

  it('defaults agentName to "Prism" and teamName to "Local"', async () => {
    delete process.env.AGENT_NAME;
    delete process.env.TEAM_NAME;
    const cfg = await loadConfig();
    expect(cfg.agentName).toBe('Prism');
    expect(cfg.teamName).toBe('Local');
  });

  it('reads NEXUS_MCP_URL directly from env', async () => {
    process.env.NEXUS_MCP_URL = 'https://nexus.example.com/projects/proj-42/mcp';
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBe('https://nexus.example.com/projects/proj-42/mcp');
  });

  it('nexusMcpUrl is null when NEXUS_MCP_URL is unset', async () => {
    delete process.env.NEXUS_MCP_URL;
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBeNull();
  });

  it('nexusMcpUrl does not fall back to NEXUS_API_URL', async () => {
    delete process.env.NEXUS_MCP_URL;
    process.env.NEXUS_API_URL = 'https://nexus.example.com';
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBeNull();
  });

  it('nexusLlmBaseUrl is null when NEXUS_API_URL is unset', async () => {
    delete process.env.NEXUS_API_URL;
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBeNull();
  });

  it('builds the auto-resolve LLM URL (/llm/...) when PROJECT_ID is unset', async () => {
    process.env.NEXUS_API_URL = 'https://nexus.example.com';
    delete process.env.PROJECT_ID;
    process.env.AWS_REGION = 'us-east-1';
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBe('https://nexus.example.com/llm/bedrock/us-east-1');
  });

  it('builds the explicit-project LLM URL (/projects/...) when PROJECT_ID is set', async () => {
    process.env.NEXUS_API_URL = 'https://nexus.example.com';
    process.env.PROJECT_ID = 'proj-42';
    process.env.AWS_REGION = 'eu-west-1';
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBe(
      'https://nexus.example.com/projects/proj-42/llm/bedrock/eu-west-1',
    );
  });
});
