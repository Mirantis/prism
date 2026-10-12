/**
 * Program status reports for the terminal, OSC 7501
 * (https://www.superlogical.com/rex/docs/build/program-status). A terminal that
 * supports the sequence shows the reported state in its tab or window, and every
 * other terminal ignores it.
 */

export type ProgramStatus =
  | { state: 'idle' | 'clear' }
  | { state: 'working' | 'done' | 'error'; msg: string }
  | { state: 'blocked'; kind: 'auth'; msg: string };

/** The stable identifier a terminal groups this program's records by. */
const APP = 'prism';

/** The longest decoded `msg` the specification allows. A terminal discards a longer report whole. */
const MAX_MSG_BYTES = 2048;

/** The report for the terminal's root record, terminated with ST. */
export function programStatusSequence(status: ProgramStatus): string {
  const pairs = [`state=${status.state}`];
  if ('kind' in status) pairs.push(`kind=${status.kind}`);
  // A report replaces its record whole, so every report but a clear names the program.
  if (status.state !== 'clear') pairs.push(`app=${APP}`);
  if ('msg' in status) pairs.push(`msg=${encodeLine(status.msg)}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}

/**
 * Base64 of one UTF-8 line. A terminal refuses a control character in the text, so
 * each one becomes a space, and the text is cut on a whole character at the limit.
 */
function encodeLine(text: string): string {
  const bytes = new Uint8Array(MAX_MSG_BYTES);
  const { written } = new TextEncoder().encodeInto(text.replace(/\p{Cc}/gu, ' '), bytes);
  return Buffer.from(bytes.subarray(0, written)).toString('base64');
}
