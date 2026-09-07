import { afterEach, describe, it, expect } from 'vitest';
import { config } from '../../config';
import { getCodingAgent } from './get-coding-agent';

const originalDefault = config.codingAgent;
const originalAvailable = config.availableCodingAgents;
afterEach(() => {
  config.codingAgent = originalDefault;
  config.availableCodingAgents = originalAvailable;
});

describe('getCodingAgent', () => {
  it.each([['claude-code', 'Claude Code'], ['codex', 'Codex']] as const)('defaults to %s', (id, name) => {
    config.availableCodingAgents = ['claude-code', 'codex'];
    config.codingAgent = id;
    expect(getCodingAgent()).toMatchObject({ id, displayName: name });
  });

  it('reuses one instance per available agent', () => {
    config.availableCodingAgents = ['claude-code', 'codex'];
    expect(getCodingAgent('codex')).toBe(getCodingAgent('codex'));
    expect(getCodingAgent('claude-code')).toBe(getCodingAgent('claude-code'));
    expect(getCodingAgent('codex')).not.toBe(getCodingAgent('claude-code'));
  });

  it('selects an available agent instead of the configured default', () => {
    config.availableCodingAgents = ['claude-code', 'codex'];
    config.codingAgent = 'claude-code';
    expect(getCodingAgent('codex').id).toBe('codex');
  });

  it('rejects an unavailable agent before launch', () => {
    config.availableCodingAgents = ['claude-code'];
    expect(() => getCodingAgent('codex')).toThrow('Available agents: claude-code');
    config.codingAgent = 'codex';
    expect(() => getCodingAgent()).toThrow('Coding agent "codex" is unavailable');
  });
});
