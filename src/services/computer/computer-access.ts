import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../../config';
import { agentProcesses } from '../../lib/agent-processes';
import { inferenceGate } from '../../lib/inference-gate';
import { logger } from '../../logger';
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
  /** The takeover that answers a help request, while it lasts. */
  private secureWindow: {
    clientId: string;
    helpId: string;
    startedAt: number;
    /** Set while the desktop is being cleared, which is still inside the window. */
    ending: boolean;
  } | null = null;

  /**
   * @param clearSecrets what the desktop must forget before the agent runs again.
   */
  constructor(private readonly clearSecrets?: () => Promise<void>) {
    super();
  }

  /**
   * Whether a person is answering a help request at the keyboard right now.
   *
   * For as long as this holds, the runtime calls no model, the agent's own
   * processes are stopped, and the computer tools inspect nothing.
   */
  get secure(): boolean {
    return this.secureWindow !== null;
  }

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

  /** A takeover naming a help request is secure; see the `secure` getter. */
  async takeControl(clientId: string, helpId?: string): Promise<void> {
    if ((this.human && this.human !== clientId) || (this.claimant && this.claimant !== clientId))
      throw new Error('Another viewer has control.');
    this.paused = true;
    this.claimant = clientId;
    this.changed();
    await this.tail;
    if (this.claimant !== clientId) return;
    this.human = clientId;
    this.claimant = null;
    // The window opens where the keyboard becomes theirs: `computerService.input`
    // passes a frame on only once `human` is this client.
    if (helpId) this.beginSecure(clientId, helpId);
    this.changed();
  }

  /**
   * A sign-in the runtime types for the user: the same window a takeover opens, bounded
   * by the typing rather than by a person at the keyboard.
   *
   * The desktop is taken first, so the agent's own actions stop and the one in flight is
   * drained before a field is touched, and given back afterwards, which is what clears
   * any password the page was left holding. The username can stay on the page, as the
   * site itself shows it again after a rejected sign-in.
   */
  async runSecure<T>(helpId: string, action: () => Promise<T>): Promise<T> {
    const clientId = `sign-in:${helpId}`;
    await this.takeControl(clientId, helpId);
    // A viewer that claimed the desktop while this waited holds it now. Typing into a
    // screen somebody else has their hands on is the one thing not to do.
    if (this.human !== clientId) throw new Error('Another viewer has control.');
    try {
      return await action();
    } finally {
      if (this.human === clientId) await this.handBack(clientId);
    }
  }

  private beginSecure(clientId: string, helpId: string): void {
    // A window that is clearing up is replaced rather than joined: its guards are
    // already in force, and the one ending will find itself superseded.
    if (this.secureWindow && !this.secureWindow.ending) return;
    this.secureWindow = { clientId, helpId, startedAt: Date.now(), ending: false };
    inferenceGate.hold();
    agentProcesses.suspend();
    trackEvent('computer secure takeover started', config.ownerUserId, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'computer.help_id': helpId,
    });
  }

  /**
   * Close the window, in this order: forget what was typed, let the agent's
   * processes run, then let it call a model again. A failure to clear still opens
   * the gate — a runtime that never infers again is the worse outcome — and says so.
   *
   * `secure` holds until the clearing is done. The password fields are still filled
   * while it runs, so this is the part of the window the screen tools must miss.
   */
  async endSecure(exit: 'handed_back' | 'disconnected'): Promise<void> {
    const open = this.secureWindow;
    if (!open || open.ending) return;
    open.ending = true;
    try {
      await this.clearSecrets?.();
    } catch (err) {
      logger.error({ err }, '[Computer] Could not clear what a secure takeover left behind');
    }
    // A takeover that began while this one was clearing holds the guards now, and
    // releasing them here would leave that window unguarded.
    if (this.secureWindow === open) {
      this.secureWindow = null;
      agentProcesses.resume();
      inferenceGate.free();
    }
    trackEvent('computer secure takeover ended', config.ownerUserId, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'computer.help_id': open.helpId,
      exit,
      elapsed_ms: String(Date.now() - open.startedAt),
    });
    this.changed();
  }

  assertCanHandBack(clientId: string): void {
    if ((this.human && this.human !== clientId) || (this.claimant && this.claimant !== clientId))
      throw new Error('Another viewer has control.');
  }

  async handBack(clientId: string): Promise<void> {
    this.assertCanHandBack(clientId);
    // Control goes first: `computerService.input` passes a frame on only while this
    // client is `human`, so a key already on its way cannot refill a field that the
    // clearing below has just emptied. The desktop stays paused until that is done.
    this.human = null;
    this.claimant = null;
    this.changed();
    await this.endSecure('handed_back');
    // A viewer who took control while the clearing ran holds the desktop now.
    if (this.human || this.claimant) return;
    this.paused = false;
    this.changed();
  }

  /**
   * A viewer that goes away keeps the desktop paused for its return, but ends its
   * secure window: nobody is typing, and the runtime would otherwise never infer again.
   */
  disconnected(clientId: string): void {
    if (this.claimant === clientId) this.claimant = null;
    if (this.human !== clientId) return;
    this.human = null;
    if (this.secureWindow?.clientId === clientId) void this.endSecure('disconnected');
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
