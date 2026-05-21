/**
 * Gating: getShellTools() returns the shell tool record only when
 * `config.singleAgentMode` is true. In multi-tenant mode the same
 * tool surface is served by the Nexus-hosted shell sandbox — the
 * in-process registration here would conflict.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config', () => ({
  config: { singleAgentMode: false },
}));

import { config } from '../../../config';

async function importFresh() {
  vi.resetModules();
  return import('../index');
}

describe('getShellTools gating', () => {
  beforeEach(() => {
    (config as { singleAgentMode: boolean }).singleAgentMode = false;
  });

  it('returns an empty record in multi-tenant mode', async () => {
    const { getShellTools } = await importFresh();
    expect(Object.keys(getShellTools())).toEqual([]);
  });

  it('returns the expected tools when single-agent mode is on', async () => {
    (config as { singleAgentMode: boolean }).singleAgentMode = true;
    const { getShellTools } = await importFresh();
    const names = Object.keys(getShellTools()).sort();
    expect(names).toEqual(
      [
        'claude_code',
        'claude_code_status',
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
