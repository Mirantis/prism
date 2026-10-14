/**
 * Program status reports, OSC 7501
 * (https://www.superlogical.com/rex/docs/build/program-status). A terminal, or a
 * supervisor that reads the runtime's output, shows the reported state, and every
 * other terminal ignores the sequence.
 */

export type ProgramStatus =
  | { state: 'idle' }
  | { state: 'working' | 'done' | 'error'; msg: string }
  | { state: 'blocked'; kind: 'auth' | 'question'; msg: string };

/** The stable identifier a terminal groups this program's records by. */
const APP = 'prism';

/** The longest decoded `msg` and `title` the specification allows. A terminal discards a longer report whole. */
const MAX_MSG_BYTES = 2048;
const MAX_TITLE_BYTES = 192;

/** The report that removes every record this program wrote. */
export const CLEAR_SEQUENCE = '\x1b]7501;state=clear\x1b\\';

/**
 * The report for the terminal's root record, terminated with ST. A report replaces
 * its record whole, so each one names the program and has the title.
 */
export function programStatusSequence(status: ProgramStatus, title: string): string {
  const pairs = [`state=${status.state}`];
  if ('kind' in status) pairs.push(`kind=${status.kind}`);
  pairs.push(`app=${APP}`, `title=${encodeLine(title, MAX_TITLE_BYTES)}`);
  if ('msg' in status) pairs.push(`msg=${encodeLine(status.msg, MAX_MSG_BYTES)}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}

/**
 * Base64 of one UTF-8 line. A terminal refuses a control character in the text, so
 * each one becomes a space, and the text is cut on a whole character at the limit.
 */
function encodeLine(text: string, maxBytes: number): string {
  const bytes = new Uint8Array(maxBytes);
  const { written } = new TextEncoder().encodeInto(text.replace(/\p{Cc}/gu, ' '), bytes);
  return Buffer.from(bytes.subarray(0, written)).toString('base64');
}
