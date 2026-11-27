import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ownCommand, programResumeSequence, RESUME_TOKEN_VAR, takeResumeToken } from './program-resume.js';

// The examples of the specification, each signed with this token and a real mac.
const TOKEN = 'dummy-token-replace-me';
const TIME = 1795543200;

describe('programResumeSequence', () => {
  it('reports a command, as the Neovim example of the specification', () => {
    const argv = ['nvim', '-S', '/home/user/.local/state/nvim/sessions/8f2c1d.vim'];
    expect(programResumeSequence({ argv }, TOKEN, 74877, TIME)).toBe(
      '\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt' +
        ':mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b\x1b\\',
    );
  });

  it('clears the record, as the Neovim example of the specification', () => {
    expect(programResumeSequence({ clear: true }, TOKEN, 74877, TIME)).toBe(
      '\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\',
    );
  });

  it('reports the working directory, as the lazygit example of the specification', () => {
    expect(programResumeSequence({ argv: ['lazygit'], cwd: '/home/user/src/project' }, TOKEN, 74877, TIME)).toBe(
      '\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==' +
        ':mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\',
    );
  });

  it('reports several arguments, as the wrapper example of the specification', () => {
    expect(programResumeSequence({ argv: ['resume-wrap', 'ssh', 'devbox'] }, TOKEN, 90412, TIME)).toBe(
      '\x1b]7577;pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94' +
        ':mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65\x1b\\',
    );
  });

  it('never writes the token', () => {
    expect(programResumeSequence({ argv: ['prism'], cwd: '/work' }, TOKEN)).not.toContain(TOKEN);
  });

  it('clears instead of reporting a command that a terminal cannot accept', () => {
    const clear = programResumeSequence({ clear: true }, TOKEN, 74877, TIME);
    // A report longer than 2048 bytes.
    expect(programResumeSequence({ argv: ['prism', 'x'.repeat(1600)] }, TOKEN, 74877, TIME)).toBe(clear);
    // A control character in an argument or in the directory.
    expect(programResumeSequence({ argv: ['prism', 'a\nb'] }, TOKEN, 74877, TIME)).toBe(clear);
    expect(programResumeSequence({ argv: ['prism'], cwd: '/work/\x1b' }, TOKEN, 74877, TIME)).toBe(clear);
    // More than 64 elements, and none.
    expect(programResumeSequence({ argv: Array(65).fill('a') }, TOKEN, 74877, TIME)).toBe(clear);
    expect(programResumeSequence({ argv: [] }, TOKEN, 74877, TIME)).toBe(clear);
  });

  it('stamps the report with this process and the current time', () => {
    const before = Math.floor(Date.now() / 1000);
    const sequence = programResumeSequence({ clear: true }, TOKEN);
    const [, pid, time] = /pid=(\d+):time=(\d+):/.exec(sequence)!;
    expect(Number(pid)).toBe(process.pid);
    expect(Number(time)).toBeGreaterThanOrEqual(before);
  });
});

describe('takeResumeToken', () => {
  it('returns the token and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [RESUME_TOKEN_VAR]: TOKEN, PATH: '/usr/bin' };
    expect(takeResumeToken(env)).toBe(TOKEN);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('has no token for a terminal that sets none, or sets it empty', () => {
    expect(takeResumeToken({})).toBeUndefined();
    expect(takeResumeToken({ [RESUME_TOKEN_VAR]: '' })).toBeUndefined();
  });

  it('keeps the token from a process started after it is taken', () => {
    const saved = process.env[RESUME_TOKEN_VAR];
    process.env[RESUME_TOKEN_VAR] = TOKEN;
    try {
      takeResumeToken();
      const child = spawnSync('sh', ['-c', 'printf %s "${OSC7577_TOKEN-unset}"'], { encoding: 'utf8' });
      expect(child.stdout).toBe('unset');
    } finally {
      if (saved === undefined) delete process.env[RESUME_TOKEN_VAR];
      else process.env[RESUME_TOKEN_VAR] = saved;
    }
  });
});

describe('ownCommand', () => {
  it('starts Node with the same options and the entry script, by absolute paths', () => {
    const command = ownCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command.slice(1, -1)).toEqual(process.execArgv);
    expect(command.at(-1)).toBe(path.resolve(process.argv[1]!));
    expect(path.isAbsolute(command[0]!)).toBe(true);
    expect(path.isAbsolute(command.at(-1)!)).toBe(true);
  });
});
