import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAuthMethod, resolveCodexHome } from './credentials';

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
  it('finds a saved login in the default Prism home', () => {
    const home = path.join(dataDir, '.codex');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    expect(resolveCodexHome({})).toBe(home);
    expect(codexAuthMethod({})).toBe('saved');
  });

  it('uses the explicit home even when the default has a saved login', () => {
    fs.mkdirSync(path.join(dataDir, '.codex'));
    fs.writeFileSync(path.join(dataDir, '.codex', 'auth.json'), '{}');
    expect(codexAuthMethod({ CODEX_HOME: path.join(dataDir, 'other') })).toBeUndefined();
  });

  it('resolves a relative home before the child changes working directory', () => {
    expect(resolveCodexHome({ CODEX_HOME: 'codex-home' })).toBe(path.resolve('codex-home'));
  });

  it('uses Bedrock when a saved login and API key are unavailable', () => {
    expect(codexAuthMethod({ AWS_PROFILE: 'test-profile' })).toBe('bedrock');
    expect(codexAuthMethod({})).toBeUndefined();
  });
});
