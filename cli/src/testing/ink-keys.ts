/** Resolves after the pending render. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Ink parses one write per render, so each key needs the render it belongs to. */
export async function type(stdin: { write: (data: string) => void }, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await flush();
  }
}
