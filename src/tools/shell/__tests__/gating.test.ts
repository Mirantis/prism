/**
 * getShellTools() returns the shell tool record. The tool surface is the
 * in-process implementation an operator can invoke from a sandboxed agent.
 */
import { describe, it, expect } from 'vitest';
import { getShellTools } from '../index';

describe('getShellTools', () => {
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
