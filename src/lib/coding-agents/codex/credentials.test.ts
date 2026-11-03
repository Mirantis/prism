import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexAuthMethod,
  hasSavedCodexLogin,
  readCodexLogin,
  resolveCodexHome,
  subscriptionEnvironment,
} from './credentials';
import { FailedSpawnChild, FakeChild } from '../../../test-utils/fake-child';
import { fakeExecutionEnvironment } from '../../../test-utils/fake-execution-environment';
import { localFiles } from '../../execution-environments/local/local-files';
import type { RunOptions } from '../../execution-environments/execution-environment';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-codex-credentials-'));
  vi.stubEnv('PRISM_DATA_DIR', dataDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Codex credentials', () => {
  it('finds a saved login in the environment the CLI will run in', async () => {
    const home = path.join(dataDir, '.codex');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    expect(resolveCodexHome({})).toBe(home);

    // Read through the environment, not this process's filesystem: under a
    // container the home is the container's.
    const environment = fakeExecutionEnvironment({
      paths: { codexHome: home },
      files: localFiles,
    });
    expect(await hasSavedCodexLogin(environment)).toBe(true);
    expect(codexAuthMethod({}, true)).toBe('saved');
  });

  it('reports no saved login when the home holds none', async () => {
    fs.mkdirSync(path.join(dataDir, '.codex'));
    fs.writeFileSync(path.join(dataDir, '.codex', 'auth.json'), '{}');
    const elsewhere = fakeExecutionEnvironment({
      paths: { codexHome: path.join(dataDir, 'other') },
      files: localFiles,
    });
    expect(await hasSavedCodexLogin(elsewhere)).toBe(false);
    expect(codexAuthMethod({}, false)).toBeUndefined();
  });

  it('resolves a relative home before the child changes working directory', () => {
    expect(resolveCodexHome({ CODEX_HOME: 'codex-home' })).toBe(path.resolve('codex-home'));
  });

  it('uses Bedrock when a saved login and API key are unavailable', () => {
    expect(codexAuthMethod({ AWS_PROFILE: 'test-profile' }, false)).toBe('bedrock');
    expect(codexAuthMethod({}, false)).toBeUndefined();
  });
});

/**
 * `codex login status` as Codex 0.163 printed it, on stderr, with the key
 * replaced. In a container, a warning line comes first.
 */
const STATUS = {
  chatgpt: { stderr: 'Logged in using ChatGPT', exitCode: 0 },
  apiKey: { stderr: 'Logged in using an API key - sk-test-***-real', exitCode: 0 },
  signedOut: { stderr: 'Not logged in', exitCode: 1 },
  inContainer: {
    stderr: 'WARNING: proceeding, even though we could not create PATH aliases\nLogged in using ChatGPT',
    exitCode: 0,
  },
};

const statusRuns: Array<{ args: readonly string[]; options: RunOptions }> = [];

/** An environment whose `codex` prints `stderr` and exits with `exitCode`, or does not start. */
function statusEnvironment(opts: { stderr?: string; exitCode?: number; launchFails?: boolean }) {
  return fakeExecutionEnvironment({
    workspaceRoot: '/workspace',
    runProgram: (_command, args, options) => {
      statusRuns.push({ args, options });
      if (opts.launchFails) {
        const child = new FailedSpawnChild();
        const proc = child.asExecProcess();
        child.fail('codex: not found');
        return proc;
      }
      const child = new FakeChild();
      child.stderr.write(`${opts.stderr ?? ''}\n`);
      process.nextTick(() => child.finish(opts.exitCode ?? 0));
      return child.asExecProcess();
    },
  });
}

describe('the saved Codex login', () => {
  afterEach(() => {
    statusRuns.length = 0;
  });

  it('asks the CLI about the home it is given, from the file store, without the variables that outrank it', async () => {
    const env = {
      PATH: '/bin',
      OPENAI_API_KEY: 'test-key',
      CODEX_API_KEY: 'test-key',
      CODEX_ACCESS_TOKEN: 'test-token',
      AWS_PROFILE: 'test-profile',
      CODEX_HOME: '/theirs',
    };
    expect(await readCodexLogin(statusEnvironment(STATUS.chatgpt), env, '/home/.codex')).toBe('chatgpt');
    expect(statusRuns[0].args).toEqual(['login', 'status', '-c', 'cli_auth_credentials_store="file"']);
    expect(statusRuns[0].options.env).toEqual({ PATH: '/bin', AWS_PROFILE: 'test-profile', CODEX_HOME: '/home/.codex' });
  });

  it.each([
    ['chatgpt', STATUS.inContainer],
    ['other', STATUS.apiKey],
    ['none', STATUS.signedOut],
  ] as const)('reads %s from %j', async (login, status) => {
    expect(await readCodexLogin(statusEnvironment(status), {}, '/home/.codex')).toBe(login);
  });

  it('names a CLI that does not start', async () => {
    await expect(readCodexLogin(statusEnvironment({ launchFails: true }), {}, '/home/.codex'))
      .rejects.toThrow('codex login status failed: codex: not found');
  });

  it('names output that is not a status, without quoting it', async () => {
    await expect(readCodexLogin(statusEnvironment({ stderr: 'Signed in as user@example.com', exitCode: 0 }), {}, '/home/.codex'))
      .rejects.toThrow(/^codex login status exited with 0 and no status$/);
  });

  it("keeps every variable but the credentials that outrank the login and the deployment's gateway", () => {
    expect(subscriptionEnvironment({
      PATH: '/bin',
      OPENAI_API_KEY: 'test-key',
      CODEX_API_KEY: 'test-key',
      CODEX_ACCESS_TOKEN: 'test-token',
      OPENAI_BASE_URL: 'https://gateway.example.test/v1',
      AWS_BEARER_TOKEN_BEDROCK: 'test-token',
      OPENAI_MODEL_ID: 'gpt-5.6-sol',
    })).toEqual({ PATH: '/bin', AWS_BEARER_TOKEN_BEDROCK: 'test-token', OPENAI_MODEL_ID: 'gpt-5.6-sol' });
  });
});
