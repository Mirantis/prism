import { describe, expect, it, vi, afterEach } from 'vitest';
import { hasAuthenticatedClaudeHome } from './authenticated-home';
vi.mock('./authenticated-home', () => ({ hasAuthenticatedClaudeHome: vi.fn(async () => false) }));
afterEach(() => vi.mocked(hasAuthenticatedClaudeHome).mockResolvedValue(false));

import { claudeCodeEnvironment, hasClaudeCodeCredentials } from './credentials';

describe('coding agent credentials', () => {
  it.each([
    { AWS_BEARER_TOKEN_BEDROCK: 'test-key' },
    { AWS_ACCESS_KEY_ID: 'test-id', AWS_SECRET_ACCESS_KEY: 'test-secret' },
    { AWS_PROFILE: 'test-profile' },
  ])('enables Bedrock for AWS credentials: %j', async (env) => {
    expect(await hasClaudeCodeCredentials(env)).toBe(true);
    expect(claudeCodeEnvironment(env)).toEqual({ ...env, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' });
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
  });

  it.each([
    { ANTHROPIC_API_KEY: 'test-key' },
    { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
    { CLAUDE_CODE_USE_VERTEX: '1' },
    { CLAUDE_CODE_USE_BEDROCK: '0' },
  ])('preserves explicit authentication: %j', (selection) => {
    const env = { AWS_PROFILE: 'test-profile', ...selection };
    expect(claudeCodeEnvironment(env)).toEqual(env);
  });

  it.each([
    [{ AWS_DEFAULT_REGION: 'us-west-2' }, 'us-west-2'],
    [{ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-west-2' }, 'eu-west-1'],
    [{}, 'us-east-1'],
  ])('sets the Bedrock region for explicit backend selection: %j', (env, region) => {
    expect(claudeCodeEnvironment({ ...env, CLAUDE_CODE_USE_BEDROCK: '1' }).AWS_REGION).toBe(region);
  });

  it('detects a saved CLI login without environment credentials', async () => {
    vi.mocked(hasAuthenticatedClaudeHome).mockResolvedValue(true);
    expect(await hasClaudeCodeCredentials({})).toBe(true);
  });

  it.each(['ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'AZURE_API_KEY'])(
    'requires a Foundry resource or endpoint with %s', async (key) => {
      const env = { [key]: 'test-key' };
      expect(await hasClaudeCodeCredentials(env)).toBe(false);
      expect(claudeCodeEnvironment(env)).toEqual(env);
      expect(await hasClaudeCodeCredentials({ ...env, ANTHROPIC_FOUNDRY_RESOURCE: 'test-resource' })).toBe(true);
      expect(await hasClaudeCodeCredentials({ ...env, ANTHROPIC_FOUNDRY_BASE_URL: 'https://test.example/anthropic' })).toBe(true);
    },
  );

  it('maps runtime Foundry credentials to CLI settings', () => {
    expect(claudeCodeEnvironment({ AZURE_API_KEY: 'test-key', AZURE_RESOURCE_NAME: 'test-resource' }))
      .toMatchObject({ CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_API_KEY: 'test-key',
        ANTHROPIC_FOUNDRY_RESOURCE: 'test-resource' });
  });
});
