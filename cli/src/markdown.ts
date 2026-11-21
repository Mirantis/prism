import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// marked-terminal bakes the wrap width in at configuration time, so we can't
// reuse one shared renderer for different widths. Cache one configured Marked
// instance per width instead (callers pass at most a couple of distinct
// widths — the chat column and the config content pane).
const renderers = new Map<number, Marked>();

/** A piece of a rendered message: ANSI text, or an image the message places there. */
export type MessagePart = { kind: 'text'; text: string } | { kind: 'image'; href: string; alt: string };

// An image placed in the text renders as a marker that holds its index in
// `placed`. Reflow cannot break it, since it has no space, and the parts split
// on it after rendering. Rendering is synchronous, so one list serves every call.
const MARKER = /\uE000(\d+)\uE001/;
const MARKERS = /\uE000(\d+)\uE001/g;
let placed: { href: string; alt: string }[] = [];

function mark(href: string, text: string): string {
  placed.push({ href, alt: text.trim() || 'image' });
  return `\uE000${placed.length - 1}\uE001`;
}

/**
 * An image the message places with an `attachment:` reference becomes a part
 * of its own; the file itself is also in the list under the message. Any other
 * image reference stays as written.
 */
function image(href: string, _title: string | null, text: string): string {
  return href.startsWith('attachment:') ? mark(href, text) : `![${text}](${href})`;
}

/** marked-terminal prints the inline markdown of a list item as written, image references included. */
const WRITTEN_IMAGE = /!\[([^\]]*)\]\((attachment:[^)\s]+)\)/g;

const SGR = /\x1b\[[0-9;]*m/g;

function isBlank(text: string): boolean {
  return text.replace(SGR, '').trim() === '';
}

function rendererFor(width: number): Marked {
  let renderer = renderers.get(width);
  if (!renderer) {
    renderer = new Marked();
    renderer.use(
      markedTerminal({ reflowText: true, width, image }) as Parameters<typeof renderer.use>[0],
    );
    renderers.set(width, renderer);
  }
  return renderer;
}

/** The rendered markdown with a marker for each image it places, or null if rendering throws. */
function renderWithMarkers(content: string, width: number): string | null {
  placed = [];
  try {
    const rendered = rendererFor(Math.max(40, width)).parse(content) as unknown;
    return typeof rendered === 'string' ? rendered.trimEnd() : null;
  } catch {
    return null;
  }
}

/** The width of the chat column: the terminal less the chat's padding and a margin. */
export function chatColumnWidth(terminalColumns: number | undefined): number {
  return Math.max(40, (terminalColumns || 100) - 6);
}

/**
 * Render markdown to ANSI text reflowed to `width` columns, split around the
 * images the message places. An image is a block of its own: text beside it on
 * the same line goes above or below it. Returns the raw content as one text part
 * if rendering throws.
 */
export function renderMessageParts(content: string, width: number): MessagePart[] {
  const rendered = renderWithMarkers(content, width);
  if (rendered === null) return [{ kind: 'text', text: content }];
  const out = rendered.replace(WRITTEN_IMAGE, (_all, text: string, href: string) => mark(href, text));
  const images = placed;
  const parts: MessagePart[] = [];
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) parts.push({ kind: 'text', text: lines.join('\n') });
    lines = [];
  };
  for (const line of out.split('\n')) {
    const pieces = line.split(MARKER);
    if (pieces.length === 1) {
      lines.push(line);
      continue;
    }
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (i % 2 === 1) {
        flush();
        parts.push({ kind: 'image', ...images[Number(piece)]! });
      } else if (!isBlank(piece)) {
        // Drop the space that separated the text from the image, keeping its color codes.
        let text = i > 0 ? piece.replace(/^((?:\x1b\[[0-9;]*m)*) +/, '$1') : piece;
        if (i < pieces.length - 1) text = text.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, '$1');
        lines.push(text);
      }
    }
  }
  flush();
  return parts;
}

/**
 * Render markdown to ANSI terminal output, reflowed to `width` columns. When
 * `width` is omitted it falls back to the chat column's width. An image the
 * text places reads as its description, in its place in the line. Returns the
 * raw content unchanged if rendering throws.
 */
export function renderMarkdown(content: string, width?: number): string {
  const out = renderWithMarkers(content, width ?? chatColumnWidth(process.stdout.columns));
  if (out === null) return content;
  const images = placed;
  return out.replace(MARKERS, (_all, index: string) => `[image: ${images[Number(index)]!.alt}]`);
}
