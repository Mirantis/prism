import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ThreadSummary } from './tui-adapter.js';
import { latestUpdated, parseLaunchArgs, resolveContinueLaunch, resolveThreadLaunch, untilAnswered } from './launch.js';

afterEach(() => {
  vi.useRealTimers();
});

/** The answer of a launch that waits for the runtime, with the waits between its questions run at once. */
async function answeredAfterWaits<T>(launch: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const answer = launch();
  await vi.runAllTimersAsync();
  return answer;
}

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

  it('continues the newest conversation of the directory for --continue', () => {
    expect(parseLaunchArgs(['--continue'])).toEqual({ kind: 'continue' });
  });

  it('refuses --resume with --continue', () => {
    expect(parseLaunchArgs(['--resume', '--continue'])).toEqual({
      kind: 'invalid',
      message: 'Use --resume or --continue, not both.',
    });
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
    await expect(answeredAfterWaits(() => untilAnswered(ask, onWait))).resolves.toBe('answer');
    expect(ask).toHaveBeenCalledTimes(3);
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it('does not wait when the first answer comes', async () => {
    const onWait = vi.fn();
    await expect(untilAnswered(async () => 'answer', onWait)).resolves.toBe('answer');
    expect(onWait).not.toHaveBeenCalled();
  });
});

describe('resolveThreadLaunch', () => {
  const runtimeWith = (threadMode: 'single' | 'multi', status: 'found' | 'missing') => ({
    threadMode: vi.fn().mockResolvedValue(threadMode),
    threadStatus: vi.fn().mockResolvedValue(status),
    listSessions: vi.fn(),
  });

  it('opens a conversation the runtime has', async () => {
    const runtime = runtimeWith('multi', 'found');
    await expect(resolveThreadLaunch('thread-1', runtime, vi.fn())).resolves.toEqual({
      kind: 'thread',
      id: 'thread-1',
      contextUsage: null,
    });
    expect(runtime.threadStatus).toHaveBeenCalledWith('thread-1');
  });

  it('exits with an error for an id the runtime does not have', async () => {
    await expect(resolveThreadLaunch('nope', runtimeWith('multi', 'missing'), vi.fn())).resolves.toEqual({
      kind: 'exit',
      message: 'No conversation with id nope.',
    });
  });

  it("opens the agent's one conversation in single-thread mode, whatever the id", async () => {
    const runtime = runtimeWith('single', 'found');
    await expect(resolveThreadLaunch('thread-1', runtime, vi.fn())).resolves.toEqual({ kind: 'session' });
    expect(runtime.threadStatus).not.toHaveBeenCalled();
  });

  it('waits for a runtime that does not answer yet, with one notice', async () => {
    const runtime = {
      threadMode: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('multi'),
      threadStatus: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('found'),
      listSessions: vi.fn(),
    };
    const onWait = vi.fn();
    await expect(answeredAfterWaits(() => resolveThreadLaunch('thread-1', runtime, onWait))).resolves.toMatchObject({
      kind: 'thread',
    });
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});

const summary = (id: string, updatedAt: string): ThreadSummary => ({
  id,
  title: null,
  updatedAt,
  workspaceRoot: '/work/repo',
  branch: null,
  contextUsage: null,
});

describe('latestUpdated', () => {
  it('picks the most recently updated conversation, not the newest created', () => {
    // The runtime lists the newest created first.
    const sessions = [summary('created-last', '2026-11-27T08:00:00.000Z'), summary('updated-last', '2026-11-27T09:00:00.000Z')];
    expect(latestUpdated(sessions)?.id).toBe('updated-last');
  });

  it('keeps the first listed on a tie, and has none for an empty list', () => {
    const at = '2026-11-27T08:00:00.000Z';
    expect(latestUpdated([summary('first', at), summary('second', at)])?.id).toBe('first');
    expect(latestUpdated([])).toBeUndefined();
  });
});

describe('resolveContinueLaunch', () => {
  const usage = { threadId: 'b', modelId: 'm', usedTokens: 10, windowTokens: 100, usedPercent: 10 };

  it('opens the most recently updated conversation of the directory, with its context reading', async () => {
    const runtime = {
      threadMode: vi.fn().mockResolvedValue('multi'),
      threadStatus: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([
        summary('a', '2026-11-27T08:00:00.000Z'),
        { ...summary('b', '2026-11-27T09:00:00.000Z'), contextUsage: usage },
      ]),
    };
    await expect(resolveContinueLaunch('/work/repo', runtime, vi.fn())).resolves.toEqual({
      kind: 'thread',
      id: 'b',
      contextUsage: usage,
    });
    expect(runtime.listSessions).toHaveBeenCalledWith('/work/repo');
  });

  it('exits with an error when the directory has no conversation', async () => {
    const runtime = {
      threadMode: vi.fn().mockResolvedValue('multi'),
      threadStatus: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    await expect(resolveContinueLaunch('/work/empty', runtime, vi.fn())).resolves.toEqual({
      kind: 'exit',
      message: 'No conversation to continue in /work/empty.',
    });
  });

  it("leaves out another directory's threads that an older runtime lists", async () => {
    const runtime = {
      threadMode: vi.fn().mockResolvedValue('multi'),
      threadStatus: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([
        { ...summary('elsewhere', '2026-11-27T10:00:00.000Z'), workspaceRoot: '/work/other' },
        summary('here', '2026-11-27T08:00:00.000Z'),
      ]),
    };
    await expect(resolveContinueLaunch('/work/repo', runtime, vi.fn())).resolves.toMatchObject({ id: 'here' });
  });

  it("opens the agent's one conversation in single-thread mode", async () => {
    const runtime = { threadMode: vi.fn().mockResolvedValue('single'), threadStatus: vi.fn(), listSessions: vi.fn() };
    await expect(resolveContinueLaunch('/work/repo', runtime, vi.fn())).resolves.toEqual({ kind: 'session' });
    expect(runtime.listSessions).not.toHaveBeenCalled();
  });

  it('waits for a runtime that does not answer yet', async () => {
    const runtime = {
      threadMode: vi.fn().mockResolvedValue('multi'),
      threadStatus: vi.fn(),
      listSessions: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce([summary('a', '2026-11-27T08:00:00.000Z')]),
    };
    const onWait = vi.fn();
    await expect(answeredAfterWaits(() => resolveContinueLaunch('/work/repo', runtime, onWait))).resolves.toMatchObject({ id: 'a' });
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});
