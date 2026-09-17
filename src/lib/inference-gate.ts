/**
 * A window in which this runtime calls no model.
 *
 * `model-call.ts` is the one place a model is called, so a gate there stops every
 * kind of turn at once — chat, goals, heartbeat, cron and the classification gates.
 * A secure takeover of the computer is what holds it: while somebody types a
 * password on the agent's desktop, the agent decides nothing, so it cannot decide
 * to look at the screen or to run a command that does.
 *
 * Nothing in flight is interrupted. A model call already sent finishes and its
 * tool calls run, which is why the computer's own gate and the process suspension
 * cover that step; this gate covers the next one.
 */

class InferenceGate {
  private open: Promise<void> | null = null;
  private release: (() => void) | null = null;

  get held(): boolean {
    return this.open !== null;
  }

  /** Hold the gate. Calling it twice holds it once; `free` opens it either way. */
  hold(): void {
    if (this.open) return;
    this.open = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  free(): void {
    const release = this.release;
    this.open = null;
    this.release = null;
    release?.();
  }

  /**
   * Resolves at once while nothing holds the gate, and rejects if the caller aborts
   * while it waits.
   *
   * The abort is only read while there is something to wait for. This gate delays a
   * call, it does not cancel one, and a caller that asks about a gate nobody holds is
   * answered rather than told its turn is over.
   */
  async wait(signal?: AbortSignal): Promise<void> {
    while (this.open) {
      signal?.throwIfAborted();
      await this.until(this.open, signal);
    }
  }

  private until(open: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return open;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void open.then(() => {
        cleanup();
        resolve();
      });
    });
  }
}

export const inferenceGate = new InferenceGate();
