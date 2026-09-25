/**
 * Splits the web suite's spec files across CI shards by recorded duration.
 *
 * Playwright's own `--shard` cuts the test list into equal counts in file order, and a few
 * files hold most of the suite's time. Here the longest file goes first, each file to the
 * shard with the least planned time, so the shards finish close together. Every shard
 * computes the same plan from the same inputs, so each file runs in exactly one of them.
 */

export interface SpecFile {
  /** Path relative to the Playwright `testDir`, which is the form `--test-list` reads. */
  file: string;
  tests: number;
}

export interface Shard {
  files: SpecFile[];
  /** Planned duration: recorded seconds, or the per-test estimate for a new file. */
  seconds: number;
}

/** The estimate for a file with no recorded duration, near the suite's own average. */
export const DEFAULT_SECONDS_PER_TEST = 10;

export function planShards(
  files: SpecFile[],
  recordedSeconds: Record<string, number>,
  total: number,
): Shard[] {
  const weigh = (f: SpecFile) => recordedSeconds[f.file] ?? f.tests * DEFAULT_SECONDS_PER_TEST;
  const longestFirst = [...files].sort(
    (a, b) => weigh(b) - weigh(a) || (a.file < b.file ? -1 : 1),
  );
  const shards: Shard[] = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const file of longestFirst) {
    const lightest = shards.reduce((min, s) => (s.seconds < min.seconds ? s : min));
    lightest.files.push(file);
    lightest.seconds += weigh(file);
  }
  return shards;
}
