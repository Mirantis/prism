import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { environment } = vi.hoisted(() => ({
  environment: { id: 'local', paths: () => ({ claudeHome: '/data/.claude', codexHome: '/data/.codex' }) },
}));
vi.mock('../../lib/execution-environments/get-execution-environment', () => ({
  getExecutionEnvironment: () => environment,
}));

import { codingAgentTerminalEnv } from './desktop-session';

describe('codingAgentTerminalEnv', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-it's-"));
    dirs.push(dir);
    return dir;
  };

  it("points the terminal's coding agents at the homes tasks sign in to", () => {
    environment.id = 'local';
    expect(codingAgentTerminalEnv(path.join(tempDir(), 'not-built.js'))).toEqual({
      CLAUDE_CONFIG_DIR: '/data/.claude',
      CODEX_HOME: '/data/.codex',
    });
  });

  it("puts wrappers first on the PATH that run the entry with their directory, the command and its arguments", () => {
    environment.id = 'local';
    const dir = tempDir();
    // Stands in for the built coding-agent-exec: prints what it was given.
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const wrappers = path.join(dir, 'bin');

    const env = codingAgentTerminalEnv(entry, wrappers);

    expect(env.PATH.split(path.delimiter)[0]).toBe(wrappers);
    for (const command of ['claude', 'codex']) {
      const printed = execFileSync(path.join(wrappers, command), ['-p', "it's here"], { encoding: 'utf8' });
      expect(JSON.parse(printed)).toEqual(['--wrappers', wrappers, command, '-p', "it's here"]);
    }
  });

  it('leaves them alone when tasks run in another container', () => {
    environment.id = 'docker';
    expect(codingAgentTerminalEnv()).toEqual({});
  });
});
