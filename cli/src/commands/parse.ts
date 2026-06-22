/** Parsing helpers for slash-command input. */

/**
 * Split a trimmed input line into its command word and arguments.
 *
 * `headWord` is the first whitespace-delimited token (e.g. '/heartbeat').
 * `rawArgs` is everything after it, trimmed (so inner spaces survive, as in
 * '/rename My Agent'). `args` is `rawArgs` split on runs of whitespace, or an
 * empty array when there are no arguments.
 */
export function parseCommandLine(trimmed: string): {
  headWord: string;
  args: string[];
  rawArgs: string;
} {
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { headWord: trimmed, args: [], rawArgs: '' };
  }
  const headWord = trimmed.slice(0, firstSpace);
  const rawArgs = trimmed.slice(firstSpace + 1).trim();
  const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);
  return { headWord, args, rawArgs };
}
