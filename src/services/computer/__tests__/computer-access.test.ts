import { describe, it, expect, vi } from 'vitest';
import { ComputerAccess } from '../computer-access';

vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));
const caller = { userId: 'user', agentId: 'agent', threadId: 'thread', mode: 'chat' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('computer ownership', () => {
  it('retains ownership between tools and admits waiting invocations in order', async () => {
    const access = new ComputerAccess();
    const first = access.create(caller),
      second = access.create(caller),
      third = access.create(caller);
    const order: number[] = [];
    await access.run(first, async () => {
      order.push(1);
    });
    const two = access.run(second, async () => {
      order.push(2);
    });
    const three = access.run(third, async () => {
      order.push(3);
    });
    await access.run(first, async () => {
      order.push(1);
    });
    expect(order).toEqual([1, 1]);
    expect(access.waiting).toEqual([second, third]);
    access.finish(first);
    await two;
    expect(order).toEqual([1, 1, 2]);
    access.finish(second);
    await three;
    access.finish(third);
    expect(order).toEqual([1, 1, 2, 3]);
  });

  it('cancels a queued invocation without affecting the active one', async () => {
    const access = new ComputerAccess();
    const first = access.create(caller),
      second = access.create(caller);
    await access.acquire(first);
    const action = vi.fn();
    const pending = access.run(second, action);
    second.controller.abort();
    await expect(pending).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(access.owner).toBe(first);
    expect(access.waiting).toEqual([]);
    access.finish(first);
    access.finish(second);
  });

  it('settles the current action before enabling human input and resumes after hand-back', async () => {
    const access = new ComputerAccess();
    const use = access.create(caller);
    const started = deferred(),
      finish = deferred();
    const action = access.run(use, async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const takeover = access.takeControl('viewer');
    expect(access.paused).toBe(true);
    expect(access.human).toBeNull();
    finish.resolve();
    await action;
    await takeover;
    expect(access.human).toBe('viewer');
    const next = vi.fn(async () => {});
    const pending = access.run(use, next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    access.disconnected('viewer');
    expect(access.paused).toBe(true);
    access.handBack('new-viewer');
    await pending;
    expect(next).toHaveBeenCalledOnce();
    access.finish(use);
  });

  it('allows requested inspection during takeover while actions wait', async () => {
    const access = new ComputerAccess();
    const use = access.create(caller);
    await access.takeControl('viewer');
    expect(await access.run(use, async () => 'screen', true)).toBe('screen');
    expect(access.owner).toBeNull();
    access.handBack('viewer');
    access.finish(use);
  });

  it('releases the desktop for independent work when an invocation requests help', async () => {
    const access = new ComputerAccess();
    const first = access.create(caller),
      second = access.create(caller);
    await access.acquire(first);
    const waiting = access.acquire(second);
    access.yield(first);
    await waiting;
    expect(access.owner).toBe(second);
    expect(first.signal.aborted).toBe(false);
    access.finish(second);
    access.finish(first);
  });

  it('serializes tools from the same invocation even when they waited for another owner', async () => {
    const access = new ComputerAccess();
    const first = access.create(caller),
      second = access.create(caller);
    await access.acquire(first);
    let inFlight = 0;
    const action = async () => {
      expect(inFlight++).toBe(0);
      await Promise.resolve();
      inFlight--;
    };
    const actions = [access.run(second, action), access.run(second, action)];
    access.finish(first);
    await Promise.all(actions);
    access.finish(second);
  });
  it('propagates caller cancellation while human control keeps an action waiting', async () => {
    const access = new ComputerAccess();
    const controller = new AbortController();
    const use = access.create(caller, controller.signal);
    await access.takeControl('viewer');
    const action = vi.fn();
    const pending = access.run(use, action);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(access.paused).toBe(true);
    expect(access.waiting).toEqual([]);
    access.finish(use);
  });
});

it('rejects hand-back by another viewer while takeover waits for an action', async () => {
  const access = new ComputerAccess();
  const use = access.create(caller);
  const started = deferred(), finish = deferred();
  const action = access.run(use, async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  const takeover = access.takeControl('first');
  expect(() => access.handBack('second')).toThrow('Another viewer has control');
  expect(access.paused).toBe(true);
  finish.resolve();
  await action;
  await takeover;
  expect(access.human).toBe('first');
  access.handBack('first');
  access.finish(use);
});
