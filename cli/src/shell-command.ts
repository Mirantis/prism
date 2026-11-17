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
      return { command, exitCode, output: cleanTerminalOutput(output) };
    }
    const exitCode = await runRecorded(command, log);
    const recorded = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    return { command, exitCode, output: cleanTerminalOutput(stripScriptBanner(recorded)) };
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

function runPiped(command: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ exitCode: code ?? (signal ? 128 : 1), output }));
  });
}

/** util-linux `script` writes a start and an end line into the log, even with `-q`. */
function stripScriptBanner(text: string): string {
  return text
    .replace(/^Script started on [^\n]*\n/, '')
    .replace(/\n?Script done on [^\n]*\n?$/, '');
}

/**
 * Reduce a terminal recording to the text a reader saw: no escape sequences,
 * a line redrawn with `\r` keeps its last version, and a backspace removes the
 * character before it.
 */
export function cleanTerminalOutput(raw: string): string {
  const lines = stripVTControlCharacters(raw)
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      let current = line.slice(line.lastIndexOf('\r') + 1);
      while (current.includes('\b')) current = current.replace(/[^\x08]?\x08/, '');
      return current.trimEnd();
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
