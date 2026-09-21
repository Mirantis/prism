/**
 * Which coding agents a deployment can run, detected at boot.
 *
 * The same credential cases config.ts used to derive at import, now asked of
 * the execution environment. `hasAuthenticatedClaudeHome` is mocked out so no
 * case here runs the real `claude` binary; the saved-Codex-login case uses a
 * real temp `CODEX_HOME`.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Undo the global mock from setup.ts: these cases read the real derivations.
vi.unmock('../../config');
vi.mock('./claude-code/authenticated-home', () => ({
  hasAuthenticatedClaudeHome: vi.fn(async () => false),
}));

// Prevent dotenv from loading .env file during tests
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('../../logger', () => ({ logger: { warn: mockWarn, info: vi.fn(), debug: vi.fn() } }));

const originalEnv = { ...process.env };
let codexHome: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-availability-codex-'));
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_API_KEY;
  mockWarn.mockClear();
  vi.resetModules();
});

afterEach(() => fs.rmSync(codexHome, { recursive: true, force: true }));

afterAll(() => {
  process.env = originalEnv;
});

/** Load a fresh config, run the boot probe against it, and report the result. */
async function loadConfig() {
  const { config } = await import('../../config');
  const { ensureCodingAgentsDetected } = await import('./availability');
  await ensureCodingAgentsDetected();
  return config;
}

describe('coding agent detection', () => {
  const claudeEnv = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AZURE_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ];
  beforeEach(() => {
    for (const name of [...claudeEnv, 'OPENAI_API_KEY', 'CODING_AGENT', 'AWS_ROLE_ARN',
      'AZURE_RESOURCE_NAME', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL']) delete process.env[name];
  });

  it('uses Claude Code without credentials', async () => {
    expect((await loadConfig()).codingAgent).toBe('claude-code');
  });

  it('enables Codex from a saved login without environment credentials', async () => {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', tokens: { access_token: 'test-access', refresh_token: 'test-refresh' },
    }));
    const cfg = await loadConfig();
    expect(cfg.availableCodingAgents).toEqual(['codex']);
    expect(cfg.codingAgent).toBe('codex');
  });

  it('enables Codex from its explicit API key', async () => {
    process.env.CODEX_API_KEY = 'test-codex-key';
    const cfg = await loadConfig();
    expect(cfg.availableCodingAgents).toEqual(['codex']);
    expect(cfg.codingAgent).toBe('codex');
  });

  it('detects only Claude Code from its Bedrock switch', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const cfg = await loadConfig();
    expect(cfg.availableCodingAgents).toEqual(['claude-code']);
    expect(cfg.codingAgent).toBe('claude-code');
  });

  it('uses Codex with only an OpenAI key', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    expect((await loadConfig()).codingAgent).toBe('codex');
  });

  it.each(claudeEnv.filter(name => !['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].includes(name)))(
    'prefers Claude Code when %s is available', async (name) => {
      process.env.OPENAI_API_KEY = 'test-openai-key';
      process.env[name] = name.startsWith('CLAUDE_CODE_USE_') ? '1' : 'test-credential';
      if (name === 'AWS_WEB_IDENTITY_TOKEN_FILE') process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/test';
      if (name === 'AZURE_API_KEY' || name.startsWith('ANTHROPIC_FOUNDRY_')) {
        process.env.AZURE_RESOURCE_NAME = 'test-resource';
      }
      expect((await loadConfig()).codingAgent).toBe('claude-code');
    },
  );

  it.each(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI'])(
    'detects both coding agents from %s without an OpenAI key', async (name) => {
      process.env[name] = 'test-credential';
      if (name === 'AWS_WEB_IDENTITY_TOKEN_FILE') process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/test';
      const cfg = await loadConfig();
      expect(cfg.availableCodingAgents).toEqual(['claude-code', 'codex']);
      expect(cfg.codingAgent).toBe('claude-code');
    },
  );

  it.each(['AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AZURE_API_KEY',
    'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN'])(
    'ignores incomplete credentials: %s', async (name) => {
      process.env[name] = 'test-credential';
      process.env.OPENAI_API_KEY = 'test-openai-key';
      const cfg = await loadConfig();
      expect(cfg.availableCodingAgents).toEqual(['codex']);
      expect(cfg.codingAgent).toBe('codex');
    },
  );

  it('prefers an AWS credential pair', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
    const cfg = await loadConfig();
    expect(cfg.codingAgent).toBe('claude-code');
    expect(cfg.availableCodingAgents).toEqual(['claude-code', 'codex']);
  });

  it('ignores empty credentials and disabled provider switches', async () => {
    for (const name of claudeEnv) process.env[name] = '';
    process.env.CLAUDE_CODE_USE_BEDROCK = '0';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    expect((await loadConfig()).codingAgent).toBe('codex');
  });

  it('detects both agents and prefers Claude Code when no default is configured', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const cfg = await loadConfig();
    expect(cfg.availableCodingAgents).toEqual(['claude-code', 'codex']);
    expect(cfg.codingAgent).toBe('claude-code');
  });

  it.each(['claude-code', 'codex'] as const)('uses CODING_AGENT=%s as the default', async (agent) => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.CODING_AGENT = `  ${agent.toUpperCase()}  `;
    expect((await loadConfig()).codingAgent).toBe(agent);
  });

  it('keeps a configured default so unavailable credentials produce an explicit error', async () => {
    process.env.CODING_AGENT = 'codex';
    const cfg = await loadConfig();
    expect(cfg.codingAgent).toBe('codex');
    expect(cfg.availableCodingAgents).toEqual([]);
  });

  it('reports an invalid default and uses credential selection', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.CODING_AGENT = 'unknown';
    const cfg = await loadConfig();
    expect(cfg.codingAgent).toBe('codex');
    expect(mockWarn).toHaveBeenCalledExactlyOnceWith(
      { configuredAgent: 'unknown' },
      '[Startup] invalid CODING_AGENT; using the detected default',
    );
  });

  it('detects only Codex with an OpenAI key', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    expect((await loadConfig()).availableCodingAgents).toEqual(['codex']);
  });

  it('detects only Claude Code with an Anthropic key', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    expect((await loadConfig()).availableCodingAgents).toEqual(['claude-code']);
  });
});
