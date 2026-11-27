/**
 * Program resume reports for the terminal, OSC 7577
 * (https://www.superlogical.com/rex/docs/build/program-resume). A terminal that
 * supports the protocol sets `OSC7577_TOKEN` for the first process of a pane, and
 * after it restarts it can run the command a program reported, in the reported
 * directory.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { isSea } from 'node:sea';

/** The variable that holds the terminal's token. */
export const RESUME_TOKEN_VAR = 'OSC7577_TOKEN';

/** The longest report the specification has every terminal accept, OSC prefix and ST included. */
const MAX_REPORT_BYTES = 2048;

/** The most `argv` elements the specification has every terminal accept. */
const MAX_ARGV = 64;

/** A control character, which a terminal refuses in decoded text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** A command to resume this program with, or the removal of its record. */
export type ResumeRecord = { argv: string[]; cwd?: string } | { clear: true };

/** What `prism` needs to report a resume command to this terminal. */
export interface ResumeReporting {
  token: string;
  /** The command that starts this `prism` again, before its own arguments. */
  command: string[];
  cwd: string;
}

/**
 * The report for `record`, signed with the terminal's token and terminated with ST.
 * A command that a terminal cannot accept becomes a `clear`, so that an earlier
 * command does not resume in its place.
 */
export function programResumeSequence(record: ResumeRecord, token: string): string {
  const pid = process.pid;
  const time = Math.floor(Date.now() / 1000);
  const report = 'argv' in record ? commandSequence(record, token, pid, time) : undefined;
  return report ?? signedSequence(`pid=${pid}:time=${time}:clear=1`, token);
}

function commandSequence(
  record: { argv: string[]; cwd?: string },
  token: string,
  pid: number,
  time: number,
): string | undefined {
  const texts = record.cwd === undefined ? record.argv : [...record.argv, record.cwd];
  if (record.argv.length === 0 || record.argv.length > MAX_ARGV) return undefined;
  if (texts.some((text) => CONTROL.test(text))) return undefined;

  const pairs = [`pid=${pid}`, `time=${time}`, `argv=${record.argv.map(base64).join(',')}`];
  if (record.cwd !== undefined) pairs.push(`cwd=${base64(record.cwd)}`);
  const sequence = signedSequence(pairs.join(':'), token);
  return Buffer.byteLength(sequence) <= MAX_REPORT_BYTES ? sequence : undefined;
}

/** The body with its `mac`: SHA-256 of the body, `:` and the token. The token itself is never written. */
function signedSequence(body: string, token: string): string {
  const mac = createHash('sha256').update(`${body}:${token}`).digest('hex');
  return `\x1b]7577;${body}:mac=${mac}\x1b\\`;
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The terminal's token, removed from this process's environment so that no
 * process `prism` starts inherits it. Undefined when the terminal set none.
 */
export function takeResumeToken(): string | undefined {
  const token = process.env[RESUME_TOKEN_VAR];
  delete process.env[RESUME_TOKEN_VAR];
  return token || undefined;
}

/**
 * The command that starts this `prism` again: the packaged binary, or Node with
 * the same options and the same entry script. Every path in it is absolute.
 */
export function ownCommand(): string[] {
  if (isSea()) return [process.execPath];
  return [process.execPath, ...process.execArgv, path.resolve(process.argv[1]!)];
}
