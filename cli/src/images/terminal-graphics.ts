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
const PLACEHOLDER_QUERY_ID = 32;

/**
 * A graphics query for a 1×1 picture, a feature query for Unicode placeholders,
 * the cell size in pixels (`CSI 16 t`), the terminal's name and version
 * (XTVERSION), then primary device attributes. Every terminal answers the last
 * one, so its answer ends the wait: a terminal that does not know a query
 * answers nothing to it.
 */
export const PROBE =
  `\x1b_Gi=${QUERY_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\` +
  `\x1b_Ga=q,i=${PLACEHOLDER_QUERY_ID},e=T,U=1\x1b\\` +
  `\x1b[16t\x1b[>0q\x1b[c`;

const GRAPHICS_REPLY = /\x1b_G([^\x1b]*)\x1b\\/g;
const CELL_REPLY = /\x1b\[6;(\d+);(\d+)t/g;
const VERSION_REPLY = /\x1bP>\|([^\x1b]*)\x1b\\/g;
const ATTRIBUTES_REPLY = /\x1b\[\?[\d;]*c/g;

export interface ProbeReplies {
  graphics: boolean;
  /** The feature query reports `U=1`: the terminal draws Unicode placeholders. */
  placeholders: boolean;
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
  let placeholders = false;
  for (const [, body] of input.matchAll(GRAPHICS_REPLY)) {
    if (!body!.endsWith(';OK')) continue;
    const keys = body!.slice(0, -';OK'.length).split(',');
    if (keys.includes(`i=${QUERY_ID}`)) graphics = true;
    if (keys.includes(`i=${PLACEHOLDER_QUERY_ID}`) && keys.includes('e=T') && keys.includes('U=1')) placeholders = true;
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
  return {
    graphics,
    placeholders,
    cell: cell && cell.width > 0 && cell.height > 0 ? cell : null,
    terminal,
    complete,
    rest,
  };
}

/**
 * The XTVERSION names of the terminals that draw Unicode placeholders without
 * answering the feature query, with the first version that draws them. Other
 * terminals that answer the graphics query draw placeholders as unknown
 * characters.
 */
const PLACEHOLDER_TERMINALS: [RegExp, number[]][] = [
  [/^kitty\((\d+)\.(\d+)/, [0, 28]],
  [/^ghostty\b/i, []],
  [/^Rio (\d+)\.(\d+)\.(\d+)/, [0, 3, 11]],
  [/^rex\b/, []],
];

function atLeast(version: string[], min: number[]): boolean {
  for (const [i, part] of min.entries()) {
    const found = Number(version[i]);
    if (found !== part) return found > part;
  }
  return true;
}

export function drawsPlaceholders(terminal: string | null): boolean {
  if (!terminal) return false;
  return PLACEHOLDER_TERMINALS.some(([name, min]) => {
    const match = name.exec(terminal);
    return match !== null && atLeast(match.slice(1), min);
  });
}

export function graphicsFrom(replies: ProbeReplies): TerminalGraphics {
  const kitty = replies.placeholders || (replies.graphics && drawsPlaceholders(replies.terminal));
  return { protocol: kitty ? 'kitty' : 'text', cell: replies.cell };
}

/** Long enough for a terminal across an SSH connection; a local one answers within milliseconds. */
const PROBE_TIMEOUT_MS = 1500;

/** How much longer to wait for the rest of the answers once some have arrived by the deadline. */
const LATE_REPLY_MS = 3000;

/** The start of an answer that the wait ended in the middle of: never a key to type. */
const PARTIAL_REPLY = /\x1b(?:\[\??[\d;]*|_G[^\x1b]*|P>\|[^\x1b]*)?$/;

/**
 * Whether Ink's input is a whole answer to the probe that arrived after the
 * wait: the device attributes or the cell size, which Ink passes on without
 * their escape. The composer drops it instead of typing it.
 */
export function isLateProbeReply(input: string): boolean {
  return /^\x1b?\[\?[\d;]*c$/.test(input) || /^\x1b?\[6;\d+;\d+t$/.test(input);
}

/**
 * Ask the terminal what it can draw. Call it with stdin in raw mode and before
 * Ink reads stdin: the answers arrive as input. Keys typed during the wait go
 * back to stdin for Ink to read. A terminal that has begun to answer by the
 * deadline gets a little longer to finish, so its answers are not typed.
 */
export function detectTerminalGraphics(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  timeoutMs = PROBE_TIMEOUT_MS,
  lateReplyMs = LATE_REPLY_MS,
): Promise<TerminalGraphics> {
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(graphicsFrom(parseProbeReplies('')));
  return new Promise((resolve) => {
    let received = '';
    let extended = false;
    const finish = (): void => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.pause();
      const replies = parseProbeReplies(received);
      const rest = replies.complete ? replies.rest : replies.rest.replace(PARTIAL_REPLY, '');
      if (rest) stdin.unshift(Buffer.from(rest, 'utf8'));
      resolve(graphicsFrom(replies));
    };
    const deadline = (): void => {
      if (!extended && received.includes('\x1b')) {
        extended = true;
        timer = setTimeout(finish, lateReplyMs);
        return;
      }
      finish();
    };
    const onData = (chunk: Buffer | string): void => {
      received += chunk.toString();
      if (parseProbeReplies(received).complete) finish();
    };
    let timer = setTimeout(deadline, timeoutMs);
    stdin.on('data', onData);
    stdout.write(PROBE);
  });
}
