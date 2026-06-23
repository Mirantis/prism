/**
 * Poll an async predicate until it succeeds, with exponential backoff.
 *
 * Runs `predicate` immediately, then keeps retrying — doubling the delay
 * between attempts (capped at `maxDelayMs`) — until it returns `true` or the
 * total elapsed time reaches `timeoutMs`. Returns whether it succeeded within
 * the budget (never throws on timeout; the caller decides how to proceed).
 *
 * Timing is injectable (`sleep`/`now`) so callers' tests don't wait on real
 * timers.
 */
export interface PollUntilOptions {
  /** Total time budget across all attempts. Default 30s. */
  timeoutMs?: number;
  /** Delay before the 2nd attempt; doubles each retry. Default 300ms. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay. Default 4s. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function pollUntil(
  predicate: () => Promise<boolean>,
  options: PollUntilOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 30_000,
    baseDelayMs = 300,
    maxDelayMs = 4_000,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const start = now();
  let delay = baseDelayMs;

  for (;;) {
    if (await predicate()) return true;
    if (now() - start >= timeoutMs) return false;
    await sleep(Math.min(delay, maxDelayMs));
    delay *= 2;
  }
}
