import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  sanitizeFilename,
  writeMediaFile,
  readMediaFile,
  removeMediaFile,
  reapStrayMediaFiles,
} from './media-store';

let savedDataDir: string | undefined;
let tmp: string;
let mediaDir: string;

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-media-test-'));
  process.env.PRISM_DATA_DIR = tmp;
  mediaDir = path.join(tmp, 'media');
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PRISM_DATA_DIR;
  else process.env.PRISM_DATA_DIR = savedDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sanitizeFilename', () => {
  it('strips paths, traversal, and control chars', () => {
    expect(sanitizeFilename('../../etc/passwd', 'file')).toBe('passwd');
    expect(sanitizeFilename('a/b\\c..d\x00e.txt', 'file')).toBe('b_c_d_e.txt');
  });

  it('falls back when nothing survives', () => {
    expect(sanitizeFilename('   ', 'file')).toBe('file');
  });

  it('falls back for "." — basename(".") resolves to the containing dir', () => {
    expect(sanitizeFilename('.', 'file')).toBe('file');
    expect(sanitizeFilename('./', 'file')).toBe('file');
  });
});

describe('writeMediaFile / readMediaFile', () => {
  it('round-trips bytes under <id>-<name> and leaves no temp file', async () => {
    const data = Buffer.from('hello media');
    const storagePath = await writeMediaFile('abc-123', 'report.pdf', data);

    expect(storagePath).toBe('abc-123-report.pdf');
    expect(fs.readFileSync(path.join(mediaDir, storagePath))).toEqual(data);
    expect(fs.readdirSync(mediaDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    expect(await readMediaFile(storagePath)).toEqual(data);
  });

  it('caps a huge filename so the basename stays legal', async () => {
    const long = 'x'.repeat(400) + '.bin';
    const storagePath = await writeMediaFile('id-1', long, Buffer.from('x'));
    expect(Buffer.from(storagePath, 'utf8').length).toBeLessThanOrEqual(255);
    expect(fs.existsSync(path.join(mediaDir, storagePath))).toBe(true);
  });

  it('returns null for a missing file', async () => {
    expect(await readMediaFile('nope-gone.txt')).toBeNull();
  });

  it('rejects storage paths that could escape the media dir', async () => {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'nope');
    expect(await readMediaFile('../secret.txt')).toBeNull();
    expect(await readMediaFile('/etc/hosts')).toBeNull();
    expect(await readMediaFile('a/b.txt')).toBeNull();
    expect(await readMediaFile('')).toBeNull();
  });
});

describe('removeMediaFile', () => {
  it('unlinks and treats already-gone as success', async () => {
    const storagePath = await writeMediaFile('id-2', 'x.txt', Buffer.from('x'));
    expect(await removeMediaFile(storagePath)).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, storagePath))).toBe(false);
    expect(await removeMediaFile(storagePath)).toBe(true);
  });

  it('refuses unsafe paths', async () => {
    expect(await removeMediaFile('../outside.txt')).toBe(false);
  });
});

describe('reapStrayMediaFiles', () => {
  it('reaps old unreferenced files (including .tmp) but keeps live and young ones', async () => {
    const live = await writeMediaFile('live-1', 'keep.txt', Buffer.from('keep'));
    const stray = await writeMediaFile('stray-1', 'old.txt', Buffer.from('old'));
    const young = await writeMediaFile('young-1', 'new.txt', Buffer.from('new'));
    const tmpStray = path.join(mediaDir, 'stray-2-half.bin.tmp');
    fs.writeFileSync(tmpStray, 'partial');

    // Age the stray files past the grace window.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(mediaDir, stray), old, old);
    fs.utimesSync(tmpStray, old, old);
    fs.utimesSync(path.join(mediaDir, live), old, old);

    const reaped = await reapStrayMediaFiles(new Set([live]), 60 * 60 * 1000);

    expect(reaped).toBe(2);
    expect(fs.existsSync(path.join(mediaDir, live))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, young))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, stray))).toBe(false);
    expect(fs.existsSync(tmpStray)).toBe(false);
  });

  it('returns 0 when the media dir does not exist yet', async () => {
    expect(await reapStrayMediaFiles(new Set(), 0)).toBe(0);
  });
});
