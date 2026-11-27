import { describe, it, expect, vi } from 'vitest';
import { parseLaunchArgs, resolveThreadLaunch, untilAnswered } from './launch.js';

describe('parseLaunchArgs', () => {
  it('starts a new conversation without a launch flag', () => {
    expect(parseLaunchArgs([])).toEqual({ kind: 'new' });
    // An argument it does not know is left alone.
    expect(parseLaunchArgs(['run'])).toEqual({ kind: 'new' });
  });

  it('shows the picker for a bare --resume', () => {
    expect(parseLaunchArgs(['--resume'])).toEqual({ kind: 'pick' });
    expect(parseLaunchArgs(['--resume', '--other'])).toEqual({ kind: 'pick' });
  });

  it('opens the named conversation for --resume <id>', () => {
    expect(parseLaunchArgs(['--resume', 'thread-1'])).toEqual({ kind: 'thread', id: 'thread-1' });
  });
});

describe('untilAnswered', () => {
  it('asks again until the runtime answers, and reports the wait once', async () => {
    const ask = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('answer');
    const onWait = vi.fn();
    await expect(untilAnswered(ask, onWait, 0)).resolves.toBe('answer');
    expect(ask).toHaveBeenCalledTimes(3);
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it('does not wait when the first answer comes', async () => {
    const onWait = vi.fn();
    await expect(untilAnswered(async () => 'answer', onWait, 0)).resolves.toBe('answer');
    expect(onWait).not.toHaveBeenCalled();
  });
});

describe('resolveThreadLaunch', () => {
  const runtimeWith = (threadMode: 'single' | 'multi', status: 'found' | 'missing') => ({
    threadMode: vi.fn().mockResolvedValue(threadMode),
    threadStatus: vi.fn().mockResolvedValue(status),
  });

  it('opens a conversation the runtime has', async () => {
    const runtime = runtimeWith('multi', 'found');
    await expect(resolveThreadLaunch('thread-1', runtime, vi.fn(), 0)).resolves.toEqual({
      kind: 'thread',
      id: 'thread-1',
    });
    expect(runtime.threadStatus).toHaveBeenCalledWith('thread-1');
  });

  it('exits with an error for an id the runtime does not have', async () => {
    await expect(resolveThreadLaunch('nope', runtimeWith('multi', 'missing'), vi.fn(), 0)).resolves.toEqual({
      kind: 'exit',
      message: 'No conversation with id nope.',
    });
  });

  it("opens the agent's one conversation in single-thread mode, whatever the id", async () => {
    const runtime = runtimeWith('single', 'found');
    await expect(resolveThreadLaunch('thread-1', runtime, vi.fn(), 0)).resolves.toEqual({ kind: 'session' });
    expect(runtime.threadStatus).not.toHaveBeenCalled();
  });

  it('waits for a runtime that does not answer yet, with one notice', async () => {
    const runtime = {
      threadMode: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('multi'),
      threadStatus: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('found'),
    };
    const onWait = vi.fn();
    await expect(resolveThreadLaunch('thread-1', runtime, onWait, 0)).resolves.toMatchObject({
      kind: 'thread',
    });
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});
