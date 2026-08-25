/**
 * Install swap tests on real temp directories: the rename-swap layout, the
 * mid-swap rollback that leaves the install untouched, and the boot sweep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { spawnWindowsInstaller, stageRelease, swapInstall, sweepUpdateDirs, UpdateError } from '../apply';

const ENTRIES = ['node_modules', 'web', 'prism', 'prism-server'];

let root: string;
let distDir: string;

function writeInstall(dir: string, marker: string): void {
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'dep.txt'), marker);
  writeFileSync(path.join(dir, 'web', 'index.html'), marker);
  writeFileSync(path.join(dir, 'prism'), marker);
  writeFileSync(path.join(dir, 'prism-server'), marker);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'prism-update-root-'));
  distDir = path.join(root, 'updates', 'v2026.8.24083158', 'darwin-arm64');
  writeInstall(root, 'old');
  mkdirSync(distDir, { recursive: true });
  writeInstall(distDir, 'new');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('swapInstall', () => {
  it('activates the staged entries and keeps the old ones in the trash', () => {
    swapInstall(distDir, root);

    expect(readFileSync(path.join(root, 'prism-server'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(root, 'web', 'index.html'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(root, 'node_modules', 'dep.txt'), 'utf8')).toBe('new');

    const trashRoot = path.join(root, '.update-trash');
    const [batch] = readdirSync(trashRoot);
    expect(batch).toBeDefined();
    for (const entry of ENTRIES) {
      expect(existsSync(path.join(trashRoot, batch!, entry))).toBe(true);
    }
    expect(readFileSync(path.join(trashRoot, batch!, 'prism'), 'utf8')).toBe('old');
  });

  it('rolls a mid-swap failure back to the original install', () => {
    // The last entry is missing from the staged dist, so the swap fails after
    // three entries already moved.
    rmSync(path.join(distDir, 'prism-server'));

    let thrown: unknown;
    try {
      swapInstall(distDir, root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UpdateError);
    expect((thrown as UpdateError).code).toBe('swap_failed');

    // Every entry is back on the old content — no half-swapped install.
    for (const entry of ['prism', 'prism-server']) {
      expect(readFileSync(path.join(root, entry), 'utf8')).toBe('old');
    }
    expect(readFileSync(path.join(root, 'node_modules', 'dep.txt'), 'utf8')).toBe('old');
    expect(readFileSync(path.join(root, 'web', 'index.html'), 'utf8')).toBe('old');
  });
});

describe('sweepUpdateDirs', () => {
  it('removes staging and trash leftovers', () => {
    mkdirSync(path.join(root, '.update-trash', '123'), { recursive: true });
    sweepUpdateDirs(root);
    expect(existsSync(path.join(root, 'updates'))).toBe(false);
    expect(existsSync(path.join(root, '.update-trash'))).toBe(false);
  });
});

// The staged binary is a real shell script the probe executes, so these run
// only where a shebang runs (the same platforms the rename-swap serves).
describe.skipIf(process.platform === 'win32')('stageRelease', () => {
  const VERSION = 'v2026.8.24083158';
  const osArch = `${process.platform}-${process.arch}`;
  const assetName = `prism-${VERSION}-${osArch}.tar.gz`;
  const fetchMock = vi.fn();

  let archiveBytes: Buffer;
  let archiveSha: string;

  /** A real release archive whose prism-server reports `reportedVersion`. */
  function buildArchive(reportedVersion: string): Buffer {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'prism-stage-fixture-'));
    const dist = path.join(fixture, osArch);
    mkdirSync(path.join(dist, 'node_modules'), { recursive: true });
    mkdirSync(path.join(dist, 'web'), { recursive: true });
    writeFileSync(path.join(dist, 'node_modules', 'dep.txt'), 'dep');
    writeFileSync(path.join(dist, 'web', 'index.html'), 'web');
    writeFileSync(path.join(dist, 'prism'), '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(dist, 'prism-server'), `#!/bin/sh\necho ${reportedVersion}\n`);
    chmodSync(path.join(dist, 'prism'), 0o755);
    chmodSync(path.join(dist, 'prism-server'), 0o755);
    const archive = path.join(fixture, assetName);
    execFileSync('tar', ['-czf', archive, '-C', fixture, osArch]);
    const bytes = readFileSync(archive);
    rmSync(fixture, { recursive: true, force: true });
    return bytes;
  }

  function mockRelease(opts: {
    archive?: Buffer | null;
    checksum?: string | null;
  }): void {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('.sha256')) {
        if (opts.checksum === null) return new Response('not found', { status: 404 });
        return new Response(`${opts.checksum}  ${assetName}\n`);
      }
      if (opts.archive === null) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(opts.archive ?? archiveBytes));
    });
  }

  beforeEach(() => {
    archiveBytes = buildArchive(VERSION);
    archiveSha = createHash('sha256').update(archiveBytes).digest('hex');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads, verifies and stages a release, then reuses the stage without re-downloading', async () => {
    mockRelease({ checksum: archiveSha });
    const distDir = await stageRelease(VERSION, root);
    expect(distDir).toBe(path.join(root, 'updates', VERSION, osArch));
    expect(existsSync(path.join(distDir, 'prism-server'))).toBe(true);
    expect(existsSync(path.join(distDir, 'node_modules', 'dep.txt'))).toBe(true);

    // Second call (a deferred activation retrying): stage reused, no network.
    fetchMock.mockClear();
    await expect(stageRelease(VERSION, root)).resolves.toBe(distDir);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records a missing archive as asset_not_found (retryable tag-before-assets race)', async () => {
    mockRelease({ archive: null, checksum: archiveSha });
    await expect(stageRelease(VERSION, root)).rejects.toMatchObject({ code: 'asset_not_found' });
  });

  it('fails closed when no checksum is published', async () => {
    mockRelease({ checksum: null });
    // Its own code, not verify_failed: nothing said the bytes were wrong.
    await expect(stageRelease(VERSION, root)).rejects.toMatchObject({
      code: 'checksum_unavailable',
    });
  });

  it('fails closed on a checksum mismatch', async () => {
    mockRelease({ checksum: 'a'.repeat(64) });
    await expect(stageRelease(VERSION, root)).rejects.toMatchObject({ code: 'verify_failed' });
  });

  it('rejects an archive whose binary reports the wrong version', async () => {
    const wrong = buildArchive('v2020.1.1000000');
    mockRelease({ archive: wrong, checksum: createHash('sha256').update(wrong).digest('hex') });
    await expect(stageRelease(VERSION, root)).rejects.toMatchObject({ code: 'verify_failed' });
  });
});

describe('spawnWindowsInstaller', () => {
  it('reports a stage without install.ps1 as spawn_failed', async () => {
    await expect(spawnWindowsInstaller(distDir, 'v2026.8.24083158')).rejects.toMatchObject({
      code: 'spawn_failed',
    });
  });
});
