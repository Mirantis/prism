/**
 * `! <command>` in the composer: the user runs a shell command in this terminal,
 * and the agent receives the command and its output as the user's message.
 *
 * The command gets the real terminal, so a login that prompts or opens a browser
 * works. `script(1)` records what it prints. On Windows, which has no `script`,
 * the output is piped and copied to the terminal, so stdin stays interactive and
 * stdout is not a TTY.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

/** The composer prefix that runs a shell command. */
export const SHELL_PREFIX = '!';

/** Output beyond this is cut from the middle; the start and the end stay. */
export const MAX_SHELL_OUTPUT_CHARS = 30_000;

export interface ShellRun {
  command: string;
  exitCode: number;
  output: string;
}

/** The command after `!`, or null when the input is not a shell command. */
export function shellCommandOf(input: string): string | null {
  if (!input.startsWith(SHELL_PREFIX)) return null;
  return input.slice(SHELL_PREFIX.length).trim();
}

/**
 * Run `command` in the user's shell in the CLI's working directory, with the
 * terminal. The caller hands the terminal over first (`suspendInput`).
 */
export async function runShellCommand(command: string): Promise<ShellRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shell-'));
  const log = path.join(dir, 'typescript');
  // Ctrl+C belongs to the command. On the piped path the terminal sends SIGINT
  // to this process too, and Node's default would exit the CLI.
  const ignoreSigint = (): void => {};
  process.on('SIGINT', ignoreSigint);
  try {
    if (process.platform === 'win32') {
      const { exitCode, output } = await runPiped(command);
      return { command, exitCode, output: output.finish() };
    }
    const exitCode = await runRecorded(command, log);
    return { command, exitCode, output: readRecording(log).finish(stripScriptBanner) };
  } finally {
    process.off('SIGINT', ignoreSigint);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runRecorded(command: string, log: string): Promise<number> {
  const shell = process.env.SHELL || '/bin/sh';
  // util-linux `script` runs `-c` through $SHELL and returns the command's exit
  // status with `-e`; the BSD `script` on macOS takes the command as arguments
  // and always returns its status.
  const args =
    process.platform === 'linux'
      ? ['-q', '-e', '-c', command, log]
      : ['-q', log, shell, '-c', command];
  return new Promise((resolve, reject) => {
    const child = spawn('script', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

function runPiped(command: string): Promise<{ exitCode: number; output: OutputCapture }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    const output = new OutputCapture();
    // One decoder per stream, so a character split across two chunks is not lost.
    const outText = new StringDecoder('utf8');
    const errText = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output.push(outText.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      output.push(errText.write(chunk));
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      output.push(outText.end());
      output.push(errText.end());
      resolve({ exitCode: code ?? (signal ? 128 : 1), output });
    });
  });
}

/** Read the `script` log a chunk at a time, so a huge recording is never held whole. */
function readRecording(log: string): OutputCapture {
  const output = new OutputCapture();
  if (!fs.existsSync(log)) return output;
  const fd = fs.openSync(log, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(64 * 1024);
    let read: number;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      output.push(decoder.write(buffer.subarray(0, read)));
    }
    output.push(decoder.end());
  } finally {
    fs.closeSync(fd);
  }
  return output;
}

/** Each kept end of the raw output. Cleaning never lengthens text, so both ends and the marker fit the limit. */
const CAPTURE_END_CHARS = Math.floor((MAX_SHELL_OUTPUT_CHARS - 100) / 2);

/**
 * The output as it arrives, kept to its first and last `CAPTURE_END_CHARS`
 * characters, so a command that prints gigabytes uses bounded memory.
 */
export class OutputCapture {
  private head = '';
  private tail = '';
  private cut = 0;

  push(text: string): void {
    if (!text) return;
    if (this.head.length < CAPTURE_END_CHARS) {
      const room = CAPTURE_END_CHARS - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
      if (!text) return;
    }
    this.tail += text;
    // Trimmed only when twice the limit, so appending stays linear.
    if (this.tail.length > 2 * CAPTURE_END_CHARS) {
      this.cut += this.tail.length - CAPTURE_END_CHARS;
      this.tail = this.tail.slice(-CAPTURE_END_CHARS);
    }
  }

  /** The text a reader saw. `prepare` edits the raw text first, told whether it is the whole output or one cut end. */
  finish(prepare: (text: string, part: 'whole' | 'head' | 'tail') => string = (t) => t): string {
    if (this.tail.length > CAPTURE_END_CHARS) {
      this.cut += this.tail.length - CAPTURE_END_CHARS;
      this.tail = this.tail.slice(-CAPTURE_END_CHARS);
    }
    if (this.cut === 0) return cleanTerminalOutput(prepare(this.head + this.tail, 'whole'));
    return [
      cleanTerminalOutput(prepare(this.head, 'head')),
      `[… ${this.cut} characters cut …]`,
      cleanTerminalOutput(prepare(this.tail, 'tail')),
    ].join('\n');
  }
}

/** util-linux `script` writes a start and an end line into the log, even with `-q`. */
function stripScriptBanner(text: string, part: 'whole' | 'head' | 'tail'): string {
  if (part !== 'tail') text = text.replace(/^Script started on [^\n]*\n/, '');
  if (part !== 'head') text = text.replace(/\n?Script done on [^\n]*\n?$/, '');
  return text;
}

/**
 * Reduce a terminal recording to the text a reader saw: no escape sequences,
 * and on each line `\r` and backspace move the cursor back, so what is printed
 * after them overwrites what was there, as on a terminal.
 */
export function cleanTerminalOutput(raw: string): string {
  const lines = stripVTControlCharacters(raw)
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      const screen: string[] = [];
      let cursor = 0;
      for (const ch of line) {
        if (ch === '\r') cursor = 0;
        else if (ch === '\b') cursor = Math.max(0, cursor - 1);
        else screen[cursor++] = ch;
      }
      return screen.join('').trimEnd();
    });
  return lines.join('\n').trim();
}

const OPEN = '<user-shell-command>';
const CLOSE = '</user-shell-command>';

/** The message the agent receives: the command, its exit code and its output. */
export function formatShellRecord(run: ShellRun): string {
  return [
    OPEN,
    `<command>${run.command}</command>`,
    `<exit-code>${run.exitCode}</exit-code>`,
    '<output>',
    truncateMiddle(run.output, MAX_SHELL_OUTPUT_CHARS),
    '</output>',
    CLOSE,
  ].join('\n');
}

/** The run in a message written by `formatShellRecord`, or null for any other message. */
export function parseShellRecord(content: string): ShellRun | null {
  if (!content.startsWith(OPEN) || !content.endsWith(CLOSE)) return null;
  const match =
    /^<user-shell-command>\n<command>([\s\S]*?)<\/command>\n<exit-code>(-?\d+)<\/exit-code>\n<output>\n([\s\S]*)\n<\/output>\n<\/user-shell-command>$/.exec(
      content,
    );
  if (!match) return null;
  return { command: match[1]!, exitCode: Number(match[2]), output: match[3]! };
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const cut = text.length - 2 * half;
  return `${text.slice(0, half)}\n[… ${cut} characters cut …]\n${text.slice(-half)}`;
}
