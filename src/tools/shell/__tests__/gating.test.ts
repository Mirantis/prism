/**
 * getShellTools() returns the shell tool record. The tool surface is the
 * in-process implementation an operator can invoke from a sandboxed agent.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { getShellTools } from '../index';
import { codingAgentInput } from '../coding-agent';
import { config } from '../../../config';

const originalDefault = config.codingAgent;
const originalAvailable = config.availableCodingAgents;
afterEach(() => {
  config.codingAgent = originalDefault;
  config.availableCodingAgents = originalAvailable;
});

describe('getShellTools', () => {
  it('lists available agents and the configured default in stable descriptions', () => {
    config.availableCodingAgents = ['claude-code', 'codex'];
    config.codingAgent = 'codex';
    const description = getShellTools().coding_agent.description;
    expect(description).toContain('Available agent values: claude-code, codex.');
    expect(description).toContain('Default agent: codex (CODING_AGENT)');
    expect(getShellTools().coding_agent.description).toBe(description);
  });

  it('lists only detected agents', () => {
    config.availableCodingAgents = ['codex'];
    expect(getShellTools().coding_agent.description).toContain('Available agent values: codex.');
  });

  it('accepts an optional supported agent parameter', () => {
    expect(codingAgentInput.parse({ prompt: 'Inspect' }).agent).toBeUndefined();
    expect(codingAgentInput.parse({ prompt: 'Inspect', agent: 'codex' }).agent).toBe('codex');
    expect(() => codingAgentInput.parse({ prompt: 'Inspect', agent: 'unknown' })).toThrow();
  });

  it('returns the expected tools', () => {
    const names = Object.keys(getShellTools()).sort();
    expect(names).toEqual(
      [
        'coding_agent',
        'coding_agent_status',
        'coding_agent_stop',
        'shell_edit_file',
        'shell_exec',
        'shell_kill',
        'shell_read_file',
        'shell_spawn',
        'shell_stdin',
        'shell_stdout',
        'shell_write_file',
      ].sort(),
    );
  });
});
