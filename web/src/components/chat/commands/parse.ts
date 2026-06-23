/**
 * Parsing helpers shared by the chat input (popup detection) and the dispatcher.
 */

/**
 * Split a trimmed input line into its command word and arguments. `headWord` is
 * the first whitespace-delimited token (e.g. '/skills'); `rawArgs` is everything
 * after it, trimmed (inner spaces survive); `args` is `rawArgs` split on runs of
 * whitespace, or [] when there are none.
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

/**
 * Whether the input is in "slash mode" — a leading '/' with no space yet, so we
 * show the command popup. Once a space is typed the popup hides (the user is
 * typing arguments). Mirrors the TUI's `slashMode`.
 */
export function isSlashMode(value: string): boolean {
  return value.startsWith('/') && !value.includes(' ');
}
