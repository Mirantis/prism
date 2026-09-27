/**
 * A token bucket: `burst` requests at once, refilled at `perSecond`.
 *
 * Used to hold one chat connection to a sane request rate. A client over the
 * rate is told when to try again rather than being disconnected, because a
 * disconnect makes a well-behaved client reconnect and resend, which is more
 * load, not less.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Take one token. Answers 0 when taken, else the milliseconds until one is free. */
  take(): number {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
  }
}
