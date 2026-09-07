import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { hasAuthenticatedClaudeHome } from './authenticated-home';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) } }));
vi.mock('../../data-dir', () => ({ resolveDataDir: () => '/test-data' }));
afterEach(() => vi.resetAllMocks());

describe('saved Claude Code authentication', () => {
  it.each([
    [{ CLAUDE_CONFIG_DIR: '/custom-home' }, '/custom-home'],
    [{}, '/test-data/.claude'],
  ])('checks the CLI home: %j', (env, configDir) => {
    vi.mocked(execFileSync).mockReturnValue('{"loggedIn":true}');
    expect(hasAuthenticatedClaudeHome(env)).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'],
      expect.objectContaining({ env: { ...env, CLAUDE_CONFIG_DIR: configDir }, timeout: 5000 }));
  });

  it('ignores an empty home', () => {
    vi.mocked(execFileSync).mockReturnValue('{"loggedIn":false}');
    expect(hasAuthenticatedClaudeHome({})).toBe(false);
  });

  it('skips the CLI when the home does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(hasAuthenticatedClaudeHome({})).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('handles an unavailable CLI or failed status check', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('Status failed'); });
    expect(hasAuthenticatedClaudeHome({})).toBe(false);
  });
});
