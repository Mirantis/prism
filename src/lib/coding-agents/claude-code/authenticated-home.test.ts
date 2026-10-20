import { afterEach, describe, expect, it } from 'vitest';
import { FailedSpawnChild, FakeChild } from '../../../test-utils/fake-child';
import { fakeExecutionEnvironment } from '../../../test-utils/fake-execution-environment';
import type { ExecutionEnvironment, FileStat, RunOptions } from '../../execution-environments/execution-environment';
import { readSavedLogin, subscriptionEnvironment } from './authenticated-home';

const DIR_STAT: FileStat = {
  size: 0,
  mtimeMs: 0,
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
};

/**
 * `claude auth status --json` output from Claude Code 2.1.304, with the account
 * fields replaced. Signed out, it prints the same JSON and exits 1.
 */
const SIGNED_OUT = { stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}', exitCode: 1 };
const SUBSCRIPTION = {
  stdout: JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    email: 'user@example.com', orgId: 'org-1', orgName: 'Example', subscriptionType: 'max',
  }),
  exitCode: 0,
};
const API_KEY = {
  stdout: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}',
  exitCode: 0,
};

const runs: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];

/**
 * An environment whose `claude` prints `stdout` and exits with `exitCode` — or,
 * with `homeExists: false`, one where the config dir is not there at all.
 */
function standIn(opts: {
  stdout?: string;
  exitCode?: number;
  homeExists?: boolean;
  launchFails?: boolean;
}): ExecutionEnvironment {
  return fakeExecutionEnvironment({
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
      process.nextTick(() => child.finish(opts.exitCode ?? 0));
      return child.asExecProcess();
    },
  });
}

afterEach(() => {
  runs.length = 0;
});

describe('the saved Claude Code login', () => {
  it('asks the CLI in the environment about the home it is given, with the env that runs a subscription', async () => {
    const env = {
      PATH: '/bin',
      AWS_BEARER_TOKEN_BEDROCK: 'test-token',
      ANTHROPIC_API_KEY: 'test-key',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/theirs',
    };
    expect(await readSavedLogin(standIn(SUBSCRIPTION), env, '/home/.claude')).toBe('subscription');
    expect(runs[0].command).toBe('claude');
    expect(runs[0].args).toEqual(['auth', 'status', '--json']);
    expect(runs[0].options.env).toEqual({
      PATH: '/bin',
      AWS_BEARER_TOKEN_BEDROCK: 'test-token',
      CLAUDE_CONFIG_DIR: '/home/.claude',
    });
  });

  it.each([
    ['none', SIGNED_OUT],
    ['other', API_KEY],
    ['other', { stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":null}', exitCode: 0 }],
  ] as const)('reads %s from %j', async (login, status) => {
    expect(await readSavedLogin(standIn(status), {}, '/home/.claude')).toBe(login);
  });

  it('skips the CLI when the home does not exist', async () => {
    expect(await readSavedLogin(standIn({ homeExists: false }), {}, '/home/.claude')).toBe('none');
    expect(runs).toHaveLength(0);
  });

  it('names a CLI that does not start', async () => {
    await expect(readSavedLogin(standIn({ launchFails: true }), {}, '/home/.claude'))
      .rejects.toThrow('claude auth status failed: claude: not found');
  });

  it('names output that is not the status JSON, without quoting it', async () => {
    await expect(readSavedLogin(standIn({ stdout: 'Signed in as user@example.com', exitCode: 0 }), {}, '/home/.claude'))
      .rejects.toThrow(/^claude auth status exited with 0 and no status$/);
  });
});

describe('the env of a task on the subscription', () => {
  it('drops every variable that outranks the saved login, and keeps the rest', () => {
    expect(subscriptionEnvironment({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      ANTHROPIC_BASE_URL: 'https://proxy.example.test',
      ANTHROPIC_FOUNDRY_API_KEY: 'test-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'test-token',
      AZURE_API_KEY: 'test-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
    })).toEqual({
      PATH: '/bin',
      AWS_BEARER_TOKEN_BEDROCK: 'test-token',
      AZURE_API_KEY: 'test-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
    });
  });
});
