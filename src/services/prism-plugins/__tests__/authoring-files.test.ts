/**
 * Authoring-file Tests
 *
 * The manual and the type declarations are generated into the plugins dir on
 * every boot, and that dir is watched — `npm run dev` has tsx watch it so a
 * plugin edit restarts the runtime. So a boot that rewrites these files with
 * identical bytes is a boot that restarts the runtime, which restarts it again,
 * about once a second for as long as the dev loop runs.
 *
 * These tests exist because that happened.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeAuthoringFiles, __test } from '../prism-plugin.service';
import { PRISM_PLUGIN_GUIDE, PRISM_PLUGIN_TYPES } from '../../../prompts/prism-plugin-guide';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-authoring-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const guide = () => path.join(dir, 'AUTHORING.md');
const types = () => path.join(dir, '.types', 'prism-plugin.d.ts');

describe('writeAuthoringFiles', () => {
  it('writes the manual and the declarations', () => {
    writeAuthoringFiles(dir);
    expect(fs.readFileSync(guide(), 'utf8')).toBe(PRISM_PLUGIN_GUIDE);
    expect(fs.readFileSync(types(), 'utf8')).toBe(PRISM_PLUGIN_TYPES);
  });

  it('leaves both mtimes alone on a second call', () => {
    writeAuthoringFiles(dir);
    const before = [fs.statSync(guide()).mtimeMs, fs.statSync(types()).mtimeMs];

    writeAuthoringFiles(dir);

    expect([fs.statSync(guide()).mtimeMs, fs.statSync(types()).mtimeMs]).toEqual(before);
  });

  it('rewrites a file somebody edited, so the manual cannot drift from the runtime', () => {
    writeAuthoringFiles(dir);
    fs.writeFileSync(guide(), '# not the manual');

    writeAuthoringFiles(dir);

    expect(fs.readFileSync(guide(), 'utf8')).toBe(PRISM_PLUGIN_GUIDE);
  });

  it('restores a deleted file', () => {
    writeAuthoringFiles(dir);
    fs.rmSync(guide());
    writeAuthoringFiles(dir);
    expect(fs.existsSync(guide())).toBe(true);
  });

  it('does not throw when the directory cannot be written', () => {
    // A read-only data dir costs the manual, not the boot.
    const readOnly = path.join(dir, 'locked');
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o500);
    expect(() => writeAuthoringFiles(path.join(readOnly, 'plugins'))).not.toThrow();
    fs.chmodSync(readOnly, 0o700);
  });
});

describe('writeIfChanged', () => {
  const { writeIfChanged } = __test;

  it('creates a file that is absent', () => {
    const target = path.join(dir, 'new.txt');
    writeIfChanged(target, 'hello');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

  it('leaves the mtime alone when the content matches', () => {
    const target = path.join(dir, 'same.txt');
    fs.writeFileSync(target, 'hello');
    const before = fs.statSync(target).mtimeMs;

    writeIfChanged(target, 'hello');

    expect(fs.statSync(target).mtimeMs).toBe(before);
  });

  it('writes when the content differs', () => {
    const target = path.join(dir, 'different.txt');
    fs.writeFileSync(target, 'hello');
    writeIfChanged(target, 'goodbye');
    expect(fs.readFileSync(target, 'utf8')).toBe('goodbye');
  });
});
