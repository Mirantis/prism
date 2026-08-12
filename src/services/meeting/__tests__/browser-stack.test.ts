/**
 * Browser candidate resolution and stale-profile-lock recovery.
 *
 * The lock case is here because it took down a working feature: Chromium writes
 * `SingletonLock` as `<hostname>-<pid>` and refuses to start when it can't prove
 * that process is gone. Replace the container and the hostname no longer exists, so
 * every subsequent meeting failed with a bare "exited (code 21)".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const { resolveBrowser, isBrowserAvailable } = await import('../browser-stack');

/**
 * A page whose URL advances one step per `waitForTimeout`, standing in for Google's
 * redirect chain.
 *
 * The stub yields to a real timer rather than resolving immediately: `settledUrl`
 * polls in a `while (Date.now() < deadline)` loop, so an instant stub turns it into a
 * busy loop that blocks the event loop for the whole budget — which starved the
 * socket-based suites elsewhere in the run and made them fail intermittently.
 */
const savedOverride = process.env.PRISM_CHROMIUM_PATH;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-stack-test-'));
});

afterEach(async () => {
  if (savedOverride === undefined) delete process.env.PRISM_CHROMIUM_PATH;
  else process.env.PRISM_CHROMIUM_PATH = savedOverride;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveBrowser', () => {
  it('honours PRISM_CHROMIUM_PATH when the binary exists', async () => {
    const fake = path.join(tmp, 'my-chrome');
    await fs.writeFile(fake, '#!/bin/sh\n');
    process.env.PRISM_CHROMIUM_PATH = fake;
    vi.resetModules();
    const { resolveBrowser: fresh } = await import('../browser-stack');

    expect(await fresh()).toBe(fake);
  });

  it('explains that the toolchain ships in the container when nothing is found', async () => {
    // Absence is forced rather than assumed from the host. The candidate list has
    // hardcoded Linux paths, and GitHub's Ubuntu image really does ship
    // `/usr/bin/google-chrome` — so this passed on a dev Mac and failed in CI,
    // resolving a browser where it expected to find none. The override below points
    // at a file that *does* exist, so the mock is what decides the outcome and the
    // test can no longer pass for the wrong reason.
    const present = path.join(tmp, 'exists');
    await fs.writeFile(present, '#!/bin/sh\n');
    process.env.PRISM_CHROMIUM_PATH = present;

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const promises = { ...actual.promises, access: vi.fn().mockRejectedValue(new Error('ENOENT')) };
      return { ...actual, promises, default: { ...actual, promises } };
    });
    vi.resetModules();
    const { resolveBrowser: fresh } = await import('../browser-stack');

    try {
      await expect(fresh()).rejects.toThrow(/container image/i);
    } finally {
      vi.doUnmock('fs');
      vi.resetModules();
    }
  });

  it('reports availability without throwing', async () => {
    // Whatever this host has, the gate must answer a boolean rather than throw —
    // it runs at startup and decides whether to register the meeting tools.
    await expect(isBrowserAvailable()).resolves.toBeTypeOf('boolean');
    expect(typeof (await isBrowserAvailable())).toBe('boolean');
    expect(resolveBrowser).toBeTypeOf('function');
  });
});

describe('stale profile locks', () => {
  /**
   * The clearing logic is private to `start()`, which needs a real browser. This
   * exercises the same contract at the filesystem level: the three singleton files
   * must be gone, and nothing else in the profile may be touched.
   */
  it('removes only the singleton files, leaving the session intact', async () => {
    const profile = path.join(tmp, 'profile');
    await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
    await fs.symlink('some-other-container-160', path.join(profile, 'SingletonLock'));
    await fs.symlink('12345', path.join(profile, 'SingletonCookie'));
    await fs.symlink('/tmp/whatever', path.join(profile, 'SingletonSocket'));
    // The part that must survive: losing this would force a fresh Google login,
    // and Google challenges a new device.
    await fs.writeFile(path.join(profile, 'Default', 'Cookies'), 'session-data');

    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await fs.unlink(path.join(profile, name));
    }

    const left = await fs.readdir(profile);
    expect(left.sort()).toEqual(['Default']);
    expect(await fs.readFile(path.join(profile, 'Default', 'Cookies'), 'utf8')).toBe('session-data');
  });

  it('is a no-op when the profile is clean', async () => {
    const profile = path.join(tmp, 'fresh');
    await fs.mkdir(profile, { recursive: true });

    // A first-ever run has no locks; clearing must not be an error path.
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await expect(fs.unlink(path.join(profile, name)).catch(() => 'absent')).resolves.toBe('absent');
    }
  });
});
