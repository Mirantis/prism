/**
 * The boot stops a process group a crashed runtime left running, and only the
 * one its mark names: a later process given the same pid is left alone.
 */

import { spawn, type ChildProcess } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseElapsed, stopLeftoverProcess } from './leftover-process';

const started: ChildProcess[] = [];

/** A process group of its own, as every agent process is. */
function startGroup(): ChildProcess {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  started.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
}

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

describe('stopLeftoverProcess', () => {
  it('kills the process group the mark names', async () => {
    const child = startGroup();
    const end = exited(child);

    await expect(stopLeftoverProcess({ pid: child.pid!, startedAt: Date.now() })).resolves.toBe(true);

    await expect(end).resolves.toBe('SIGKILL');
  });

  it('leaves a process alone that started at another time', async () => {
    const child = startGroup();

    await expect(
      stopLeftoverProcess({ pid: child.pid!, startedAt: Date.now() - 60 * 60 * 1000 }),
    ).resolves.toBe(false);

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it('does nothing when no process has the pid', async () => {
    const child = startGroup();
    const end = exited(child);
    child.kill('SIGKILL');
    await end;

    await expect(stopLeftoverProcess({ pid: child.pid!, startedAt: Date.now() })).resolves.toBe(false);
  });
});

describe('parseElapsed', () => {
  it.each([
    ['00:05', 5_000],
    ['12:34', (12 * 60 + 34) * 1000],
    ['01:02:03', (3600 + 2 * 60 + 3) * 1000],
    ['2-01:02:03', ((2 * 24 + 1) * 3600 + 2 * 60 + 3) * 1000],
  ])('reads %s', (text, ms) => {
    expect(parseElapsed(text)).toBe(ms);
  });

  it('reads nothing from an empty answer', () => {
    expect(parseElapsed('')).toBeNull();
  });
});
