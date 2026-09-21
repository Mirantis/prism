/**
 * `runCli` against fake children: the process mechanics every CLI-shaped
 * adapter shares — parsing, the closing result, spawn failures, stop.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import {
  FakeChild,
  FailedSpawnChild,
  SigkillOnlyChild,
} from '../../test-utils/fake-child';
import { fakeExecutionEnvironment } from '../../test-utils/fake-execution-environment';
import {
  runCli,
  STDERR_KEEP_BYTES,
  STOP_GRACE_MS,
  type CliRunSpec,
} from './cli-run';
import type { RunOptions } from '../execution-environments/execution-environment';
import type { CodingAgentEvent, CodingAgentRun } from './coding-agent';

/** Lines are the JSON of an event; `{ "skip": true }` is a line of no interest. */
function parseLine(line: string): CodingAgentEvent[] {
  const parsed = JSON.parse(line) as CodingAgentEvent & { skip?: boolean };
  return parsed.skip ? [] : [parsed];
}

const spec: CliRunSpec = {
  taskId: 't1',
  displayName: 'Fake Agent',
  command: 'fake',
  args: ['--go'],
  env: {},
  parseLine,
};

function start<T extends FakeChild>(child: T): { run: CodingAgentRun; child: T } {
  const environment = fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() });
  return { run: runCli(spec, environment), child };
}

async function collect(run: CodingAgentRun): Promise<CodingAgentEvent[]> {
  const events: CodingAgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runCli', () => {
  it('closes stdin after passing the prompt in argv', async () => {
    const child = Object.assign(new FakeChild(), { stdin: new PassThrough() });
    const { run } = start(child);
    expect(child.stdin.writableEnded).toBe(true);
    child.finish(1);
    await collect(run);
  });

  it('finishes when a signal exit precedes stdout closing', async () => {
    const child = new FakeChild();
    const { run } = start(child);
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    child.stdout.end();
    child.stderr.end();
    expect(await collect(run)).toEqual([
      { type: 'result', stopReason: 'error', turns: 0,
        message: 'Fake Agent exited with code 1 and no result' },
    ]);
  });
  it('passes the command, args, cwd and env to the environment', () => {
    let captured: [string, readonly string[], RunOptions] | undefined;
    const environment = fakeExecutionEnvironment({
      runProgram: (command, args, options) => {
        captured = [command, args, options];
        return new FakeChild().asExecProcess();
      },
    });
    runCli({ ...spec, cwd: '/work', env: { PATH: '/bin' } }, environment);

    expect(captured?.[0]).toBe('fake');
    expect(captured?.[1]).toEqual(['--go']);
    expect(captured?.[2]).toEqual({ cwd: '/work', env: { PATH: '/bin' }, stdin: 'pipe' });
  });

  it('runs at the workspace root when the spec names no cwd', () => {
    let captured: RunOptions | undefined;
    const environment = fakeExecutionEnvironment({
      workspaceRoot: '/home/node',
      runProgram: (_command, _args, options) => {
        captured = options;
        return new FakeChild().asExecProcess();
      },
    });
    runCli(spec, environment);

    expect(captured?.cwd).toBe('/home/node');
  });

  it('streams parsed events in order and closes after the agent reports', async () => {
    const { run, child } = start(new FakeChild());
    child.emitLine(JSON.stringify({ type: 'text', text: 'hello ' }));
    child.emitLine(JSON.stringify({ skip: true }));
    child.emitLine(JSON.stringify({ type: 'text', text: 'world' }));
    child.emitLine(
      JSON.stringify({ type: 'result', stopReason: 'end_turn', turns: 2, message: 'done' }),
    );
    child.finish(0);

    expect(await collect(run)).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'result', stopReason: 'end_turn', turns: 2, message: 'done' },
    ]);
  });

  it('skips a line the parser cannot read', async () => {
    const { run, child } = start(new FakeChild());
    child.emitLine('not json at all');
    child.emitLine(JSON.stringify({ type: 'text', text: 'still here' }));
    child.emitLine(
      JSON.stringify({ type: 'result', stopReason: 'end_turn', turns: 1, message: 'ok' }),
    );
    child.finish(0);

    const events = await collect(run);
    expect(events[0]).toEqual({ type: 'text', text: 'still here' });
    expect(events).toHaveLength(2);
  });

  it('closes with the exit code and stderr when the agent exits without reporting', async () => {
    const { run, child } = start(new FakeChild());
    child.stderr.write('something went wrong\n');
    child.finish(1);

    const events = await collect(run);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', stopReason: 'error', turns: 0 });
    expect((events[0] as { message: string }).message).toBe(
      'Fake Agent exited with code 1: something went wrong',
    );
  });

  it('caps the stderr it keeps, a single long line included', async () => {
    const { run, child } = start(new FakeChild());
    child.stderr.write('x'.repeat(STDERR_KEEP_BYTES * 3) + '\n');
    child.stderr.write('tail line\n');
    child.finish(1);

    const [result] = await collect(run);
    const message = (result as { message: string }).message;
    expect(message.length).toBeLessThanOrEqual(STDERR_KEEP_BYTES + 64);
    expect(message).not.toContain('tail line');
  });

  it('names a silent exit as such', async () => {
    const { run, child } = start(new FakeChild());
    child.finish(2);

    const [result] = await collect(run);
    expect(result).toMatchObject({
      type: 'result',
      stopReason: 'error',
      message: 'Fake Agent exited with code 2 and no result',
    });
  });

  it('reports a spawn failure as the closing result instead of crashing', async () => {
    const { run, child } = start(new FailedSpawnChild());
    child.fail('spawn fake ENOENT');

    const [result] = await collect(run);
    expect(result).toMatchObject({
      type: 'result',
      stopReason: 'error',
      message: 'Fake Agent failed to start: spawn fake ENOENT',
    });
  });

  it('reports exited once the child is gone', async () => {
    const { run, child } = start(new FakeChild());
    expect(run.exited).toBe(false);
    child.finish(0);
    await collect(run);
    expect(run.exited).toBe(true);
  });

  it('stop sends SIGTERM and escalates to SIGKILL after the grace period', () => {
    vi.useFakeTimers();
    const { run, child } = start(new SigkillOnlyChild());

    run.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(run.exited).toBe(false);

    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(run.exited).toBe(true);
  });

  it('stop does not escalate on a child that honoured SIGTERM', () => {
    vi.useFakeTimers();
    const { run, child } = start(new FakeChild());

    run.stop();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
