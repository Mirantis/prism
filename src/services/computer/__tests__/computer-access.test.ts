import { describe, it, expect, vi, afterEach } from 'vitest';
import { ComputerAccess } from '../computer-access';
import { agentProcesses } from '../../../lib/agent-processes';
import { inferenceGate } from '../../../lib/inference-gate';

vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../../../lib/agent-processes', () => ({
  agentProcesses: { suspend: vi.fn(), resume: vi.fn() },
}));
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

  it('fails a waiting call whose invocation moved to another computer, rather than leaving it waiting', async () => {
    const access = new ComputerAccess();
    const holder = access.create(caller),
      mover = access.create(caller);
    await access.acquire(holder);
    const waiting = access.run(mover, async () => 'ran');
    await Promise.resolve();
    // Another call of the same invocation took it to another computer.
    access.yield(mover);
    await expect(waiting).rejects.toThrow('moved to another computer');
    access.finish(holder);
    access.finish(mover);
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
    await access.handBack('new-viewer');
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
    await access.handBack('viewer');
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
  await expect(access.handBack('second')).rejects.toThrow('Another viewer has control');
  expect(access.paused).toBe(true);
  finish.resolve();
  await action;
  await takeover;
  expect(access.human).toBe('first');
  await access.handBack('first');
  access.finish(use);
});

describe('secure takeover', () => {
  afterEach(() => {
    inferenceGate.free();
    vi.mocked(agentProcesses.suspend).mockClear();
    vi.mocked(agentProcesses.resume).mockClear();
  });

  it('stops the runtime for the help request, and cleans up before it runs again', async () => {
    let clearedWhileStopped: boolean | null = null;
    const access = new ComputerAccess(async () => {
      clearedWhileStopped = inferenceGate.held;
    });
    await access.takeControl('viewer', 'help-1');
    expect(access.secure).toBe(true);
    expect(inferenceGate.held).toBe(true);
    expect(agentProcesses.suspend).toHaveBeenCalledOnce();

    await access.handBack('viewer');
    expect(clearedWhileStopped).toBe(true);
    expect(access.secure).toBe(false);
    expect(inferenceGate.held).toBe(false);
    expect(agentProcesses.resume).toHaveBeenCalledOnce();
  });

  it('runs the runtime again when the viewer goes away, and keeps the desktop paused', async () => {
    const access = new ComputerAccess();
    await access.takeControl('viewer', 'help-1');
    access.disconnected('viewer');
    await vi.waitFor(() => expect(inferenceGate.held).toBe(false));
    expect(access.secure).toBe(false);
    expect(access.paused).toBe(true);
    expect(agentProcesses.resume).toHaveBeenCalledOnce();
  });

  it('leaves the runtime alone for a takeover that answers no help request', async () => {
    const access = new ComputerAccess();
    await access.takeControl('viewer');
    expect(access.secure).toBe(false);
    expect(inferenceGate.held).toBe(false);
    expect(agentProcesses.suspend).not.toHaveBeenCalled();
    await access.handBack('viewer');
  });

  it('keeps the desktop paused for a viewer who takes control while it is cleared', async () => {
    const clearing = deferred();
    const access = new ComputerAccess(() => clearing.promise);
    await access.takeControl('first', 'help-1');

    const handBack = access.handBack('first');
    await access.takeControl('second', 'help-1');
    clearing.resolve();
    await handBack;

    expect(access.human).toBe('second');
    expect(access.paused).toBe(true);
    expect(access.secure).toBe(true);
    expect(inferenceGate.held).toBe(true);
    // The guard is the runtime's, so a window left open here would hold it for the next test.
    await access.handBack('second');
  });
});

describe('a sign-in the runtime types', () => {
  afterEach(() => {
    inferenceGate.free();
    vi.mocked(agentProcesses.suspend).mockClear();
    vi.mocked(agentProcesses.resume).mockClear();
  });

  it('stops the runtime for the typing, and gives everything back afterwards', async () => {
    let cleared = false;
    const access = new ComputerAccess(async () => {
      cleared = true;
    });
    const stopped: boolean[] = [];

    const answer = await access.runSecure('help-1', async () => {
      stopped.push(access.secure, inferenceGate.held, access.paused);
      return 'filled';
    });

    expect(answer).toBe('filled');
    expect(stopped).toEqual([true, true, true]);
    expect(cleared).toBe(true);
    expect(access.secure).toBe(false);
    expect(access.paused).toBe(false);
    expect(inferenceGate.held).toBe(false);
    expect(agentProcesses.resume).toHaveBeenCalledOnce();
  });

  it('waits for the action the agent already started', async () => {
    const access = new ComputerAccess();
    const use = access.create(caller);
    const started = deferred();
    const action = deferred();
    const order: string[] = [];
    const agentAction = access.run(use, async () => {
      started.resolve();
      await action.promise;
      order.push('agent');
    });
    await started.promise;

    const signIn = access.runSecure('help-1', async () => void order.push('sign-in'));
    action.resolve();
    await agentAction;
    await signIn;

    expect(order).toEqual(['agent', 'sign-in']);
  });

  it('refuses while somebody is at the keyboard, and leaves their takeover alone', async () => {
    const access = new ComputerAccess();
    await access.takeControl('viewer', 'help-1');

    await expect(access.runSecure('help-1', async () => 'filled')).rejects.toThrow(
      'Another viewer has control.',
    );
    expect(access.human).toBe('viewer');
    expect(access.secure).toBe(true);
  });

  it('gives the desktop back when the typing throws', async () => {
    const access = new ComputerAccess();

    await expect(
      access.runSecure('help-1', async () => {
        throw new Error('the tab went away');
      }),
    ).rejects.toThrow('the tab went away');
    expect(access.paused).toBe(false);
    expect(access.secure).toBe(false);
    expect(inferenceGate.held).toBe(false);
  });
});
