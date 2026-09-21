import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailedSpawnChild, FakeChild } from '../../../test-utils/fake-child';
import { fakeExecutionEnvironment } from '../../../test-utils/fake-execution-environment';
import { __setExecutionEnvironmentForTests } from '../../execution-environments/get-execution-environment';
import type { FileStat, RunOptions } from '../../execution-environments/execution-environment';
import { hasAuthenticatedClaudeHome } from './authenticated-home';

vi.mock('../../data-dir', () => ({ resolveDataDir: () => '/test-data' }));

const DIR_STAT: FileStat = {
  size: 0,
  mtimeMs: 0,
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
};

const runs: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];

/**
 * Stand in an environment whose `claude` prints `stdout` — or, with
 * `homeExists: false`, one where the config dir is not there at all.
 */
function standIn(opts: { stdout?: string; homeExists?: boolean; launchFails?: boolean }): void {
  __setExecutionEnvironmentForTests(
    fakeExecutionEnvironment({
      workspaceRoot: '/workspace',
      files: {
        stat: async () => {
          if (opts.homeExists === false) throw new Error('ENOENT');
          return DIR_STAT;
        },
      },
      runProgram: (command, args, options) => {
        runs.push({ command, args, options });
        if (opts.launchFails) {
          const child = new FailedSpawnChild();
          const proc = child.asExecProcess();
          child.fail('claude: not found');
          return proc;
        }
        const child = new FakeChild();
        if (opts.stdout !== undefined) child.emitLine(opts.stdout);
        process.nextTick(() => child.finish(0));
        return child.asExecProcess();
      },
    }),
  );
}

afterEach(() => {
  __setExecutionEnvironmentForTests(null);
  runs.length = 0;
});

describe('saved Claude Code authentication', () => {
  it.each([
    [{ CLAUDE_CONFIG_DIR: '/custom-home' }, '/custom-home'],
    [{}, '/test-data/.claude'],
  ])('checks the CLI home: %j', async (env, configDir) => {
    standIn({ stdout: '{"loggedIn":true}' });
    expect(await hasAuthenticatedClaudeHome(env)).toBe(true);
    expect(runs[0].command).toBe('claude');
    expect(runs[0].args).toEqual(['auth', 'status', '--json']);
    expect(runs[0].options.env).toEqual({ ...env, CLAUDE_CONFIG_DIR: configDir });
  });

  it('ignores an empty home', async () => {
    standIn({ stdout: '{"loggedIn":false}' });
    expect(await hasAuthenticatedClaudeHome({})).toBe(false);
  });

  it('skips the CLI when the home does not exist', async () => {
    standIn({ homeExists: false });
    expect(await hasAuthenticatedClaudeHome({})).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('handles an unavailable CLI', async () => {
    standIn({ launchFails: true });
    expect(await hasAuthenticatedClaudeHome({})).toBe(false);
  });

  it('handles output that is not the status JSON', async () => {
    standIn({ stdout: 'usage: claude [options]' });
    expect(await hasAuthenticatedClaudeHome({})).toBe(false);
  });
});
