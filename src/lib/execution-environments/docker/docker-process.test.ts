/**
 * The argv handed to the engine, and the kill that has to reach inside it.
 *
 * The engine itself is never run: a fake stands in for the `docker` client, so
 * these cases say the same thing on a machine with an engine and one without.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FailedSpawnChild, FakeChild } from '../../../test-utils/fake-child';
import type { RunOptions } from '../execution-environment';

const launches: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];
let child: FakeChild;

vi.mock('../local/local-process', () => ({
  runLocalProgram: (command: string, args: readonly string[], options: RunOptions) => {
    launches.push({ command, args, options });
    return child.asExecProcess();
  },
}));

const { runDockerProgram, runDockerShell } = await import('./docker-process');

let runDir: string;
const ctx = () => ({ container: 'prism-exec-test', runDir });

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  cwd: '/data/workspace',
  env: {},
  stdin: 'ignore',
  ...over,
});

beforeEach(() => {
  launches.length = 0;
  child = new FakeChild();
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-proc-'));
});

afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

/** The pid file the command was told to write, read out of its argv. */
function pidFileOf(args: readonly string[]): string {
  const marker = args.indexOf('prism-exec');
  return args[marker + 1];
}

describe('a command in the container', () => {
  it('enters the container at the caller cwd and records its process group', () => {
    runDockerShell('echo hi', options(), ctx());
    const { command, args } = launches[0];

    expect(command).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', '-w', '/data/workspace', 'prism-exec-test']);
    // `--wait` is why the output is not empty: under `docker exec` the entered
    // process is already a group leader, so setsid forks, and without it the
    // parent exits 0 the instant the child starts.
    expect(args).toEqual(expect.arrayContaining(['setsid', '--wait']));
    expect(pidFileOf(args)).toBe(path.join(runDir, path.basename(pidFileOf(args))));
    expect(args.slice(-3)).toEqual(['bash', '-c', 'echo hi']);
  });

  it('runs a program by argv, with no shell in between', () => {
    runDockerProgram('claude', ['-p', 'do X'], options(), ctx());
    expect(launches[0].args.slice(-3)).toEqual(['claude', '-p', 'do X']);
  });

  it('attaches stdin only when the caller asked to write to it', () => {
    runDockerShell('cat', options({ stdin: 'pipe' }), ctx());
    expect(launches[0].args).toContain('-i');

    runDockerShell('cat', options({ stdin: 'ignore' }), ctx());
    expect(launches[1].args).not.toContain('-i');
  });

  it('names each variable but never its value, and hands the value to the client', () => {
    // A token in an argv is a token in the host's `ps`. `-e NAME` makes the
    // engine read it from its own client's environment instead.
    const secret = { AWS_BEARER_TOKEN_BEDROCK: 'test-token' };
    runDockerShell('aws s3 ls', options({ env: secret }), ctx());
    const { args, options: spawned } = launches[0];

    expect(args).toEqual(expect.arrayContaining(['-e', 'AWS_BEARER_TOKEN_BEDROCK']));
    expect(args.join(' ')).not.toContain('test-token');
    expect(spawned.env.AWS_BEARER_TOKEN_BEDROCK).toBe('test-token');
  });

  it('reports a launch failure as the end of the process, not a throw', async () => {
    child = new FailedSpawnChild();
    const proc = runDockerShell('echo hi', options(), ctx());
    (child as FailedSpawnChild).fail('docker: not found');

    const end = await proc.ended;
    expect(end.error?.message).toBe('docker: not found');
  });
});

describe('killing it', () => {
  it('signals the process group the command recorded', () => {
    const proc = runDockerShell('sleep 300', options(), ctx());
    fs.writeFileSync(pidFileOf(launches[0].args), '4242\n');

    expect(proc.kill('SIGTERM')).toBe(true);
    // Negative pid: the group, so a grandchild of the command dies with it —
    // the same guarantee `processGroup: true` gives locally.
    expect(launches[1].args).toEqual([
      'exec',
      'prism-exec-test',
      'sh',
      '-c',
      'kill -TERM -4242',
    ]);
  });

  it('kills the engine client while the command has yet to record itself', async () => {
    // The window between the engine starting and the wrapper's first command.
    // A caller kills to end the run and then waits on the same process, so a
    // signal that reached nothing here would leave it waiting for good.
    const proc = runDockerShell('sleep 300', options(), ctx());

    expect(proc.kill('SIGTERM')).toBe(true);
    expect(launches).toHaveLength(1);
    expect(child.signals).toEqual(['SIGTERM']);
    await expect(proc.closed).resolves.toBeTruthy();
  });

  it('falls back the same way for a pid file that does not hold a pid', async () => {
    const proc = runDockerShell('sleep 300', options(), ctx());
    fs.writeFileSync(pidFileOf(launches[0].args), 'not-a-pid');

    expect(proc.kill('SIGKILL')).toBe(true);
    expect(launches).toHaveLength(1);
    expect(child.signals).toEqual(['SIGKILL']);
    await expect(proc.closed).resolves.toBeTruthy();
  });

  it('removes the pid file once the command has ended', async () => {
    const proc = runDockerShell('echo hi', options(), ctx());
    const pidFile = pidFileOf(launches[0].args);
    fs.writeFileSync(pidFile, '4242\n');

    child.finish(0);
    await proc.closed;
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(false));
  });
});
