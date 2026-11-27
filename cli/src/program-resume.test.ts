import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ownCommand, programResumeSequence, RESUME_TOKEN_VAR, takeResumeToken } from './program-resume.js';

// The examples of the specification, each signed with this token and a real mac.
const TOKEN = 'dummy-token-replace-me';
const TIME = 1795543200;

const pid = Object.getOwnPropertyDescriptor(process, 'pid')!;

/** The report as the program `programPid` makes it at the time of the specification's examples. */
function atExampleTime(programPid: number, report: () => string): string {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TIME * 1000);
  Object.defineProperty(process, 'pid', { value: programPid, configurable: true });
  return report();
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'pid', pid);
});

describe('programResumeSequence', () => {
  it('reports a command, as the Neovim example of the specification', () => {
    const argv = ['nvim', '-S', '/home/user/.local/state/nvim/sessions/8f2c1d.vim'];
    expect(atExampleTime(74877, () => programResumeSequence({ argv }, TOKEN))).toBe(
      '\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt' +
        ':mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b\x1b\\',
    );
  });

  it('clears the record, as the Neovim example of the specification', () => {
    expect(atExampleTime(74877, () => programResumeSequence({ clear: true }, TOKEN))).toBe(
      '\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\',
    );
  });

  it('reports the working directory, as the lazygit example of the specification', () => {
    expect(atExampleTime(74877, () => programResumeSequence({ argv: ['lazygit'], cwd: '/home/user/src/project' }, TOKEN))).toBe(
      '\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==' +
        ':mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\',
    );
  });

  it('reports several arguments, as the wrapper example of the specification', () => {
    expect(atExampleTime(90412, () => programResumeSequence({ argv: ['resume-wrap', 'ssh', 'devbox'] }, TOKEN))).toBe(
      '\x1b]7577;pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94' +
        ':mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65\x1b\\',
    );
  });

  it('never writes the token', () => {
    expect(programResumeSequence({ argv: ['prism'], cwd: '/work' }, TOKEN)).not.toContain(TOKEN);
  });

  it('clears instead of reporting a command that a terminal cannot accept', () => {
    const clear = atExampleTime(74877, () => programResumeSequence({ clear: true }, TOKEN));
    // A report longer than 2048 bytes.
    expect(atExampleTime(74877, () => programResumeSequence({ argv: ['prism', 'x'.repeat(1600)] }, TOKEN))).toBe(clear);
    // A control character in an argument or in the directory.
    expect(atExampleTime(74877, () => programResumeSequence({ argv: ['prism', 'a\nb'] }, TOKEN))).toBe(clear);
    expect(atExampleTime(74877, () => programResumeSequence({ argv: ['prism'], cwd: '/work/\x1b' }, TOKEN))).toBe(clear);
    // More than 64 elements, and none.
    expect(atExampleTime(74877, () => programResumeSequence({ argv: Array(65).fill('a') }, TOKEN))).toBe(clear);
    expect(atExampleTime(74877, () => programResumeSequence({ argv: [] }, TOKEN))).toBe(clear);
  });

  it('stamps the report with this process and the current time', () => {
    const before = Math.floor(Date.now() / 1000);
    const sequence = programResumeSequence({ clear: true }, TOKEN);
    const [, reportedPid, time] = /pid=(\d+):time=(\d+):/.exec(sequence)!;
    expect(Number(reportedPid)).toBe(pid.value);
    expect(Number(time)).toBeGreaterThanOrEqual(before);
  });
});

describe('takeResumeToken', () => {
  const saved = process.env[RESUME_TOKEN_VAR];
  afterEach(() => {
    if (saved === undefined) delete process.env[RESUME_TOKEN_VAR];
    else process.env[RESUME_TOKEN_VAR] = saved;
  });

  it('returns the token and removes it from the environment', () => {
    process.env[RESUME_TOKEN_VAR] = TOKEN;
    expect(takeResumeToken()).toBe(TOKEN);
    expect(RESUME_TOKEN_VAR in process.env).toBe(false);
  });

  it('has no token for a terminal that sets none, or sets it empty', () => {
    delete process.env[RESUME_TOKEN_VAR];
    expect(takeResumeToken()).toBeUndefined();
    process.env[RESUME_TOKEN_VAR] = '';
    expect(takeResumeToken()).toBeUndefined();
  });

  it('keeps the token from a process started after it is taken', () => {
    process.env[RESUME_TOKEN_VAR] = TOKEN;
    takeResumeToken();
    const child = spawnSync('sh', ['-c', 'printf %s "${OSC7577_TOKEN-unset}"'], { encoding: 'utf8' });
    expect(child.stdout).toBe('unset');
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
