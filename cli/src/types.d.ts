declare module 'marked-terminal' {
  // marked-terminal v7's `markedTerminal()` returns a marked extension object.
  // We pass it straight to `marked.use()`, which accepts an opaque options bag.
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ): unknown;
}
