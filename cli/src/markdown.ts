import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// marked-terminal bakes the wrap width in at configuration time, so we can't
// reuse one shared renderer for different widths. Cache one configured Marked
// instance per width instead (callers pass at most a couple of distinct
// widths — the chat column and the config content pane).
const renderers = new Map<number, Marked>();

function rendererFor(width: number): Marked {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked();
    renderer.use(
      markedTerminal({ reflowText: true, width }) as Parameters<typeof renderer.use>[0],
    );
    renderers.set(width, renderer);
  }
  return renderer;
}

/**
 * Render markdown to ANSI terminal output, reflowed to `width` columns. When
 * `width` is omitted it falls back to the full terminal width less a small
 * margin (the original chat behaviour). Returns the raw content unchanged if
 * rendering throws.
 */
export function renderMarkdown(content: string, width?: number): string {
  const cols = Math.max(40, width ?? (process.stdout.columns || 100) - 6);
  try {
    const out = rendererFor(cols).parse(content) as unknown as string;
    return typeof out === 'string' ? out.trimEnd() : content;
  } catch {
    return content;
  }
}
