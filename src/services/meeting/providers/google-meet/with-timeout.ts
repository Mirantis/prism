/**
 * A deadline for a read from a live page.
 *
 * Shared by the probes that run on a timer for the whole call — the participant count
 * and the caption speaker. `page.evaluate` has no timeout of its own, so a read that
 * never settles would stall every later poll behind it: the response mode, the
 * empty-room check and speaker attribution all stop moving at once, and none of them
 * says so.
 *
 * Its own module because the caption probe cannot import it from the provider that
 * imports the caption probe.
 */

/** Reject if `promise` hasn't settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
