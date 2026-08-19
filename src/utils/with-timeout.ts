/**
 * A deadline for a promise that has none of its own.
 *
 * Written for reads from a live browser page — `page.evaluate` never times out, so a read
 * that does not settle stalls every later poll behind it — but there is nothing about it
 * that belongs to meetings, or to a browser.
 *
 * Rejects rather than resolving with a sentinel: a caller that can carry on without the
 * value catches and says so, and one that cannot has an error to report.
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
