import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { trackEvent } from '../../lib/telemetry';

export interface ComputerCaller {
  userId: string;
  agentId: string;
  threadId?: string;
  mode: string;
  originChannel?: 'slack' | 'websocket';
  originChannelId?: string;
}

export interface ComputerUse extends ComputerCaller {
  id: string;
  controller: AbortController;
  signal: AbortSignal;
  startedAt?: number;
  failed: boolean;
  closed: boolean;
}

/** Invocation ownership and human takeover share one gate for the desktop. */
export class ComputerAccess extends EventEmitter {
  owner: ComputerUse | null = null;
  paused = false;
  human: string | null = null;
  private claimant: string | null = null;
  private queue: ComputerUse[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  create(caller: ComputerCaller, signal?: AbortSignal): ComputerUse {
    const controller = new AbortController();
    return {
      ...caller,
      id: randomUUID(),
      controller,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      failed: false,
      closed: false,
    };
  }

  get waiting(): ComputerUse[] {
    return [...this.queue];
  }

  private changed(): void {
    this.emit('change');
  }

  private wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => {
        this.off('change', done);
        signal.removeEventListener('abort', abort);
      };
      this.once('change', done);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async acquire(use: ComputerUse): Promise<void> {
    use.signal.throwIfAborted();
    if (use.closed) throw new Error('This computer invocation has ended.');
    if (this.owner === use) return;
    if (!use.startedAt) {
      use.startedAt = Date.now();
      trackEvent('computer use started', use.userId, {
        'agent.id': use.agentId,
        'computer.use_id': use.id,
        mode: use.mode,
      });
    }
    if (!this.queue.includes(use)) {
      this.queue.push(use);
      this.changed();
    }
    try {
      while (this.owner || this.queue[0] !== use || this.paused) {
        if (this.owner === use) return;
        await this.wait(use.signal);
      }
      use.signal.throwIfAborted();
      this.queue.shift();
      this.owner = use;
      this.changed();
    } catch (error) {
      this.queue = this.queue.filter((item) => item !== use);
      this.changed();
      throw error;
    }
  }

  /** Serialize actions as well as owners: one model step may call several tools. */
  async run<T>(use: ComputerUse, action: () => Promise<T>, inspection = false): Promise<T> {
    if (!inspection) await this.acquire(use);
    for (;;) {
      use.signal.throwIfAborted();
      if (!inspection && this.owner !== use) await this.acquire(use);
      if (!inspection && this.paused) {
        await this.wait(use.signal);
        continue;
      }
      const run = this.tail.then(async () => {
        use.signal.throwIfAborted();
        if (!inspection && this.paused) return { retry: true as const };
        if (!inspection && this.owner !== use) return { retry: true as const };
        return { retry: false as const, value: await action() };
      });
      this.tail = run.catch(() => {});
      const result = await run;
      if (!result.retry) return result.value;
    }
  }

  async takeControl(clientId: string): Promise<void> {
    if ((this.human && this.human !== clientId) || (this.claimant && this.claimant !== clientId))
      throw new Error('Another viewer has control.');
    this.paused = true;
    this.claimant = clientId;
    this.changed();
    await this.tail;
    if (this.claimant !== clientId) return;
    this.human = clientId;
    this.claimant = null;
    this.changed();
  }

  assertCanHandBack(clientId: string): void {
    if ((this.human && this.human !== clientId) || (this.claimant && this.claimant !== clientId))
      throw new Error('Another viewer has control.');
  }

  handBack(clientId: string): void {
    this.assertCanHandBack(clientId);
    this.human = null;
    this.claimant = null;
    this.paused = false;
    this.changed();
  }

  disconnected(clientId: string): void {
    if (this.claimant === clientId) this.claimant = null;
    if (this.human !== clientId) return;
    this.human = null;
    this.changed();
  }

  yield(use: ComputerUse): void {
    if (this.owner === use) this.owner = null;
    this.queue = this.queue.filter((item) => item !== use);
    this.changed();
  }

  finish(use: ComputerUse): void {
    if (use.closed) return;
    use.closed = true;
    const status = use.signal.aborted ? 'canceled' : use.failed ? 'error' : 'completed';
    use.controller.abort();
    this.yield(use);
    if (use.startedAt)
      trackEvent('computer use finished', use.userId, {
        'agent.id': use.agentId,
        'computer.use_id': use.id,
        status,
        elapsed_ms: String(Date.now() - use.startedAt),
      });
  }

  stop(): void {
    this.owner?.controller.abort();
    this.changed();
  }
}
