/**
 * Editing a document in the user's own editor.
 *
 * A workspace document is multi-paragraph markdown. The composer is one line
 * and Ink has no text-area widget, so the TUI hands the text to `$VISUAL` /
 * `$EDITOR` in a temp file and reads it back when the editor exits — the same
 * shape as `git commit` and `crontab -e`.
 *
 * The temp file outlives this call on purpose. What the user typed is not
 * recoverable once it is gone, so the caller deletes it (`discard()`) only
 * after the edit has been stored somewhere; a failed save can then point at the
 * file that still holds the work.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface EditResult {
  /** The document after editing — the original text when nothing was saved. */
  text: string;
  /** False when the editor exited without changing the file, or abandoned it. */
  changed: boolean;
  /** Where the edited text still sits on disk. */
  file: string;
  /** Remove the temp file and its directory. Safe to call more than once. */
  discard: () => void;
}

/** `$VISUAL`, else `$EDITOR`, else `vi` — the conventional order. */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string {
  // Each candidate is trimmed before it is weighed, so a VISUAL that is empty
  // or all spaces means "not set" and falls through to EDITOR instead of
  // shadowing it.
  const visual = (env.VISUAL ?? '').trim();
  const editor = (env.EDITOR ?? '').trim();
  return visual || editor || 'vi';
}

/**
 * Open `initial` in the user's editor and return what they saved.
 *
 * The editor owns the terminal while it runs, so callers must hand it over
 * first (`ctx.suspendInput`). A non-zero exit is treated as "leave it alone"
 * rather than an error: that is how `vi`'s `:cq` and most editors report a
 * deliberate abort.
 */
export async function editText(
  initial: string,
  opts: { suffix?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<EditResult> {
  const env = opts.env ?? process.env;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-edit-'));
  const file = path.join(dir, `document${opts.suffix ?? '.md'}`);
  const discard = () => fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(file, initial, 'utf8');

  try {
    // An editor setting may carry flags ("code -w"), so split before spawning.
    // Whitespace is the only separator, so a command path containing spaces
    // needs a wrapper script rather than quoting.
    const [command, ...args] = resolveEditor(env).split(/\s+/);
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(command!, [...args, file], { stdio: 'inherit', env });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(exitCode ?? 0));
    });
    if (code !== 0) {
      discard();
      return { text: initial, changed: false, file, discard };
    }

    const text = fs.readFileSync(file, 'utf8');
    if (text === initial) discard();
    return { text, changed: text !== initial, file, discard };
  } catch (error) {
    // Nothing was edited (the editor never started), so nothing is at risk.
    discard();
    throw error;
  }
}
