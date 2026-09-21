import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAuthMethod, hasSavedCodexLogin, resolveCodexHome } from './credentials';
import { fakeExecutionEnvironment } from '../../../test-utils/fake-execution-environment';
import { localFiles } from '../../execution-environments/local/local-files';

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
