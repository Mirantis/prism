/**
 * The argv handed to the engine, and the kill that has to reach inside it.
 *
 * The engine itself is never run: a fake stands in for the `docker` client, so
 * these cases say the same thing on a machine with an engine and one without.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const lost: Array<{ container: string; said: string }> = [];
vi.mock('./container-lost', () => ({
  reportIfContainerLost: (container: string, said: string) => lost.push({ container, said }),
}));

const { runDockerProgram, runDockerShell } = await import('./docker-process');

const ctx = () => ({ container: 'agent-exec-test' });

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  cwd: '/data/workspace',
  env: {},
  stdin: 'ignore',
  ...over,
});

beforeEach(() => {
  launches.length = 0;
  lost.length = 0;
  child = new FakeChild();
});

/** The pid file the wrapper was told to write, read out of its argv. */
function pidFileOf(args: readonly string[]): string {
  return args[args.indexOf('prism-exec') + 1];
}

describe('a command in the container', () => {
  it('enters the container at the caller cwd and records its process group', () => {
    runDockerShell('echo hi', options(), ctx());
    const { command, args, options: spawned } = launches[0];

    expect(command).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', '-w', '/data/workspace', 'agent-exec-test']);
    // `--wait` is why the output is not empty: under `docker exec` the entered
    // process is already a group leader, so setsid forks, and without it the
    // parent exits 0 the instant the child starts.
    expect(args).toEqual(expect.arrayContaining(['setsid', '--wait']));
    // Inside the container, where the wrapper writes it and the kill reads it.
    expect(pidFileOf(args)).toMatch(/^\/tmp\/prism-exec-[0-9a-f-]{36}\.pid$/);
    expect(args.slice(-3)).toEqual(['bash', '-c', 'echo hi']);
    // The engine's client is a host process; the caller's cwd is a path in
    // the container, which `-w` carries and `spawn` could not use.
    expect(spawned.cwd).toBe(process.cwd());
  });

  it('gives each command a pid file of its own', () => {
    runDockerShell('echo one', options(), ctx());
    runDockerShell('echo two', options(), ctx());
    expect(pidFileOf(launches[0].args)).not.toBe(pidFileOf(launches[1].args));
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
  it('reads the recorded group id in the container and signals the group', () => {
    const proc = runDockerShell('sleep 300', options(), ctx());
    const pidFile = pidFileOf(launches[0].args);

    expect(proc.kill('SIGTERM')).toBe(true);
    const [subcommand, container, shell, flag, script, argv0, file, signal] = launches[1].args;
    expect([subcommand, container, shell, flag]).toEqual(['exec', 'agent-exec-test', 'sh', '-c']);
    expect(argv0).toBe('prism-kill');
    expect(file).toBe(pidFile);
    expect(signal).toBe('TERM');
    // Read on the container's side, because the file is the container's.
    expect(script).toContain('cat "$1"');
    // A negative pid: the group, so a grandchild of the command dies with it —
    // the same guarantee a local command's own process group gives.
    expect(script).toContain('kill -"$2" -"$p"');
  });

  it('leaves the engine client alone for a signal a command can survive', () => {
    const proc = runDockerShell('sleep 300', options(), ctx());
    expect(proc.kill('SIGTERM')).toBe(true);
    // Killing the client here would cut the command's output off mid-flush.
    expect(child.signals).toEqual([]);
  });

  it('also kills the engine client on SIGKILL, so nothing can wait forever', async () => {
    const proc = runDockerShell('sleep 300', options(), ctx());

    // Between the engine starting and the wrapper running, the pid file holds
    // nothing. `captureShell` kills and then waits on the same process, so
    // SIGKILL has to settle it whatever happened in there.
    expect(proc.kill('SIGKILL')).toBe(true);
    expect(child.signals).toEqual(['SIGKILL']);
    await expect(proc.closed).resolves.toBeTruthy();
  });
});

describe('a container that is gone', () => {
  it("reads the engine's error off stderr, even when the caller decodes it", async () => {
    const proc = runDockerProgram('node', ['server.js'], options(), ctx());
    // A plugin's MCP transport sets an encoding on stderr, which hands every
    // listener strings instead of buffers.
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', () => {});
    child.stderr.write('Error response from daemon: No such container: agent-exec-test\n');
    child.finish(1);
    await proc.ended;
    await new Promise((resolve) => setImmediate(resolve));

    expect(lost).toEqual([
      { container: 'agent-exec-test', said: expect.stringContaining('No such container') },
    ]);
  });
});
