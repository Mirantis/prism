import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { editText, resolveEditor } from './editor.js';

/**
 * The editor is driven by a real child process: each test writes a small shell
 * script and points `EDITOR` at it, so the spawn, the temp file and the
 * read-back are all exercised rather than mocked.
 */
const scripts: string[] = [];

function makeEditorScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-editor-test-'));
  const file = path.join(dir, 'editor.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  scripts.push(dir);
  return file;
}

afterEach(() => {
  while (scripts.length > 0) fs.rmSync(scripts.pop()!, { recursive: true, force: true });
});

describe('resolveEditor', () => {
  it('prefers VISUAL over EDITOR', () => {
    expect(resolveEditor({ VISUAL: 'code -w', EDITOR: 'nano' })).toBe('code -w');
  });

  it('falls back to EDITOR', () => {
    expect(resolveEditor({ EDITOR: 'nano' })).toBe('nano');
  });

  // An empty VISUAL means "not set", so it must not shadow EDITOR.
  it('falls through an empty VISUAL to EDITOR', () => {
    expect(resolveEditor({ VISUAL: '', EDITOR: 'nano' })).toBe('nano');
    expect(resolveEditor({ VISUAL: '   ', EDITOR: 'nano' })).toBe('nano');
  });

  it('falls back to vi when neither is set or both are blank', () => {
    expect(resolveEditor({})).toBe('vi');
    expect(resolveEditor({ VISUAL: '  ', EDITOR: '' })).toBe('vi');
  });
});

describe('editText', () => {
  it('returns what the editor saved', async () => {
    const editor = makeEditorScript('printf "rewritten" > "$1"');

    const result = await editText('original', { env: { EDITOR: editor } });

    expect(result.text).toBe('rewritten');
    expect(result.changed).toBe(true);
    result.discard();
  });

  it('hands the current document to the editor', async () => {
    // The script appends, so the initial text has to have been in the file.
    const editor = makeEditorScript('printf "\\nmore" >> "$1"');

    const result = await editText('# Guide', { env: { EDITOR: editor } });

    expect(result.text).toBe('# Guide\nmore');
    result.discard();
  });

  it('reports no change when the editor saves the same text', async () => {
    const editor = makeEditorScript('exit 0');

    const result = await editText('untouched', { env: { EDITOR: editor } });

    expect(result.text).toBe('untouched');
    expect(result.changed).toBe(false);
  });

  // `vi`'s `:cq` and most editors report a deliberate abort with a non-zero
  // exit, which must not overwrite the document with a half-finished draft.
  it('keeps the original when the editor exits non-zero', async () => {
    const editor = makeEditorScript('printf "half-written" > "$1"\nexit 1');

    const result = await editText('original', { env: { EDITOR: editor } });

    expect(result.text).toBe('original');
    expect(result.changed).toBe(false);
  });

  it('passes a flag from the editor setting as its own argument, before the file', async () => {
    // Writes its first argument into its second, so the file has to be last.
    const editor = makeEditorScript('printf "%s" "$1" > "$2"');

    const result = await editText('x', { env: { EDITOR: `${editor} --check` } });

    expect(result.text).toBe('--check');
    result.discard();
  });

  it('rejects when the editor cannot be started', async () => {
    await expect(
      editText('x', { env: { EDITOR: '/nonexistent/editor-binary' } }),
    ).rejects.toThrow();
  });

  // The edited text is not recoverable once the file is gone, so an edit that
  // still has to be stored keeps its file until the caller discards it.
  it('keeps the edited document on disk until it is discarded', async () => {
    const editor = makeEditorScript('printf "kept" > "$1"');

    const result = await editText('original', { env: { EDITOR: editor } });

    expect(fs.readFileSync(result.file, 'utf8')).toBe('kept');
    result.discard();
    expect(fs.existsSync(result.file)).toBe(false);
  });

  it('discards the file itself when nothing was edited', async () => {
    const unchanged = await editText('x', { env: { EDITOR: makeEditorScript('exit 0') } });
    expect(fs.existsSync(unchanged.file)).toBe(false);

    const aborted = await editText('x', {
      env: { EDITOR: makeEditorScript('printf half > "$1"\nexit 1') },
    });
    expect(fs.existsSync(aborted.file)).toBe(false);
  });

  it('discarding twice is not an error', async () => {
    const result = await editText('x', {
      env: { EDITOR: makeEditorScript('printf twice > "$1"') },
    });

    result.discard();
    expect(() => result.discard()).not.toThrow();
  });

  it('leaves no temp dir behind when the editor cannot start', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('prism-edit-')).length;

    await expect(
      editText('x', { env: { EDITOR: '/nonexistent/editor-binary' } }),
    ).rejects.toThrow();

    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('prism-edit-')).length;
    expect(after).toBe(before);
  });
});
