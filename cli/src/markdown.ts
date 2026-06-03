import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

let rendererInstalled = false;
function ensureMarkedConfigured(): void {
  if (rendererInstalled) return;
  marked.use(
    markedTerminal({
      reflowText: true,
      width: Math.max(40, (process.stdout.columns || 100) - 6),
    }) as Parameters<typeof marked.use>[0],
  );
  rendererInstalled = true;
}

export function renderMarkdown(content: string): string {
  ensureMarkedConfigured();
  try {
    const out = marked(content) as unknown as string;
    return typeof out === 'string' ? out.trimEnd() : content;
  } catch {
    return content;
  }
}
