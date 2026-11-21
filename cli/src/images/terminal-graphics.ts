/**
 * How this terminal can draw a picture, asked of the terminal at start-up.
 *
 * - `kitty`: the kitty graphics protocol with Unicode placeholders.
 * - `text`: the image's description, in every other terminal.
 */

export type ImageProtocol = 'kitty' | 'text';

export interface TerminalGraphics {
  protocol: ImageProtocol;
  /** The pixel size of one cell, when the terminal reported it. */
  cell: { width: number; height: number } | null;
}

const QUERY_ID = 31;

/**
 * A graphics query for a 1×1 picture, the cell size in pixels (`CSI 16 t`), the
 * terminal's name and version (XTVERSION), then primary device attributes. Every
 * terminal answers the last one, so its answer ends the wait: a terminal that
 * does not know a query answers nothing to it.
 */
export const PROBE = `\x1b_Gi=${QUERY_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[>0q\x1b[c`;

const GRAPHICS_REPLY = /\x1b_G([^\x1b]*)\x1b\\/g;
const CELL_REPLY = /\x1b\[6;(\d+);(\d+)t/g;
const VERSION_REPLY = /\x1bP>\|([^\x1b]*)\x1b\\/g;
const ATTRIBUTES_REPLY = /\x1b\[\?[\d;]*c/g;

export interface ProbeReplies {
  graphics: boolean;
  cell: { width: number; height: number } | null;
  /** The XTVERSION answer, such as `kitty(0.36.4)`. */
  terminal: string | null;
  /** The device attributes arrived, so every other answer has too. */
  complete: boolean;
  /** Whatever else arrived: keys the person typed during the wait. */
  rest: string;
}

export function parseProbeReplies(input: string): ProbeReplies {
  let graphics = false;
  for (const [, body] of input.matchAll(GRAPHICS_REPLY)) {
    if (body!.startsWith(`i=${QUERY_ID};`) && body!.endsWith(';OK')) graphics = true;
  }
  const cellMatch = [...input.matchAll(CELL_REPLY)][0];
  const cell = cellMatch ? { height: Number(cellMatch[1]), width: Number(cellMatch[2]) } : null;
  const terminal = [...input.matchAll(VERSION_REPLY)][0]?.[1] ?? null;
  const complete = input.match(ATTRIBUTES_REPLY) !== null;
  const rest = input
    .replace(GRAPHICS_REPLY, '')
    .replace(CELL_REPLY, '')
    .replace(VERSION_REPLY, '')
    .replace(ATTRIBUTES_REPLY, '');
  return { graphics, cell: cell && cell.width > 0 && cell.height > 0 ? cell : null, terminal, complete, rest };
}

/**
 * The terminals that draw Unicode placeholders: kitty from 0.28 and Ghostty. A
 * graphics answer alone does not say it, and other terminals that answer it
 * draw placeholders as unknown characters.
 */
export function drawsPlaceholders(terminal: string | null): boolean {
  if (!terminal) return false;
  if (/^ghostty\b/i.test(terminal)) return true;
  const kitty = /^kitty\((\d+)\.(\d+)/.exec(terminal);
  return kitty !== null && (Number(kitty[1]) > 0 || Number(kitty[2]) >= 28);
}

export function graphicsFrom(replies: ProbeReplies): TerminalGraphics {
  const kitty = replies.graphics && drawsPlaceholders(replies.terminal);
  return { protocol: kitty ? 'kitty' : 'text', cell: replies.cell };
}

/** Long enough for a terminal across an SSH connection; a local one answers within milliseconds. */
const PROBE_TIMEOUT_MS = 1500;

/**
 * Ask the terminal what it can draw. Call it with stdin in raw mode and before
 * Ink reads stdin: the answers arrive as input. Keys typed during the wait go
 * back to stdin for Ink to read.
 */
export function detectTerminalGraphics(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<TerminalGraphics> {
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(graphicsFrom(parseProbeReplies('')));
  return new Promise((resolve) => {
    let received = '';
    const finish = (): void => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.pause();
      const replies = parseProbeReplies(received);
      if (replies.rest) stdin.unshift(Buffer.from(replies.rest, 'utf8'));
      resolve(graphicsFrom(replies));
    };
    const onData = (chunk: Buffer | string): void => {
      received += chunk.toString();
      if (parseProbeReplies(received).complete) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on('data', onData);
    stdout.write(PROBE);
  });
}
