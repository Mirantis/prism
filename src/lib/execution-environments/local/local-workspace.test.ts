/**
 * Tests for prepareLocalWorkspace — the boot-time guard that creates the shell
 * workspace dir (and falls back when the configured root can't be created, so
 * `npm run dev` on macOS doesn't fail every shell command with
 * `spawn /bin/bash ENOENT`).
 *
 * Uses the real filesystem with temp paths rather than mocking `fs`: the
 * fallback is forced by pointing the root at a path *under an existing file*,
 * which makes a recursive mkdir throw ENOTDIR deterministically.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { prepareLocalWorkspace } from './local-workspace';

describe('prepareLocalWorkspace', () => {
  const original = process.env.SHELL_WORKSPACE_ROOT;
  const tmpPaths: string[] = [];

  afterEach(() => {
    if (original === undefined) delete process.env.SHELL_WORKSPACE_ROOT;
    else process.env.SHELL_WORKSPACE_ROOT = original;
    for (const p of tmpPaths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });

  it('creates the configured root and reports no fallback', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    tmpPaths.push(base);
    const root = path.join(base, 'nested', 'workspace');
    process.env.SHELL_WORKSPACE_ROOT = root;

    const result = prepareLocalWorkspace();

    expect(result).toEqual({ root: path.resolve(root), fellBackFrom: null });
    expect(fs.existsSync(root)).toBe(true);
  });

  it('falls back to a temp dir when the configured root cannot be created', () => {
    // A regular file; treating it as a parent directory makes mkdir throw.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bad-'));
    tmpPaths.push(base);
    const file = path.join(base, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const desired = path.join(file, 'workspace'); // under a file → ENOTDIR
    process.env.SHELL_WORKSPACE_ROOT = desired;

    const fallback = path.join(os.tmpdir(), 'prism-workspace');
    const result = prepareLocalWorkspace();

    expect(result).toEqual({ root: fallback, fellBackFrom: path.resolve(desired) });
    // Pins the fallback so every later resolveLocalWorkspaceRoot() agrees.
    expect(process.env.SHELL_WORKSPACE_ROOT).toBe(fallback);
    expect(fs.existsSync(fallback)).toBe(true);
  });
});
