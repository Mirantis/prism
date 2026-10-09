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

import { logger } from '../../../logger';

const {
  resolveBrowser,
  isBrowserAvailable,
  bypassProxyForLoopback,
  buildBrowserArgs,
  BrowserStack,
} = await import('../browser-stack');

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

/**
 * The media flags on the browser's command line.
 *
 * Measured on Chromium 151 against the Xvfb display: `--use-fake-ui-for-media-stream`
 * takes the fake-UI capture path, so every `getDisplayMedia` call rejected with
 * `NotReadableError: Could not start video source` — with *and* without the
 * auto-select flag — while the pair asserted here resolved with the real screen. The
 * flags are the whole behaviour, and nothing else here can catch a bad edit to them.
 */
describe('browser media flags', () => {
  const args = buildBrowserArgs(4711, '/tmp/profile');

  it('grants camera and microphone without the fake-UI path', () => {
    expect(args).toContain('--auto-accept-camera-and-microphone-capture');
    // The regression this replaces: the fake-UI flag answers `getDisplayMedia` too,
    // and answers it with a synthetic source that does not exist.
    expect(args).not.toContain('--use-fake-ui-for-media-stream');
  });

  it('selects the whole virtual screen, so no picker has to be clicked', () => {
    // The value is matched against Chromium's own picker source names, where a
    // single-monitor display — which is what Xvfb gives us — is "Entire screen".
    expect(args).toContain('--auto-select-desktop-capture-source=Entire screen');
    // Asserted in the same test, not a separate one: the source name above is
    // Chromium's own English picker string, so it matches only while the browser's UI
    // language is English. The image installs one locale pack (`en-US.pak`; no
    // `chromium-l10n`), so today the name holds even under another `--lang` — this
    // keeps the pair honest if a locale pack ever arrives, and fails loudly if the
    // flag is dropped or its value changed.
    expect(args).toContain('--lang=en-US');
  });

  it('never substitutes a fake capture device', () => {
    // This is the flag that makes `getDisplayMedia` resolve on the fake-UI path, and
    // it is the wrong fix: it replaces the live PulseAudio source with a synthetic
    // tone, which is a bot that sits in the call mute.
    expect(args.some((arg) => arg.startsWith('--use-fake-device-for-media-stream'))).toBe(false);
  });

  it('carries the debugging port and profile it was given', () => {
    // `start()` passes these; the browser attaches to the wrong place, or loses the
    // signed-in session, if either is dropped.
    expect(args).toContain('--remote-debugging-port=4711');
    expect(args).toContain('--user-data-dir=/tmp/profile');
  });
});

/**
 * Keeping the CDP handshake off the proxy.
 *
 * Found in production: a sandbox injected `HTTP_PROXY`/`HTTPS_PROXY` with no
 * loopback exemption, so Playwright tunnelled its `http://127.0.0.1:<port>` fetch to
 * the proxy, got an empty reply, and every join died as `socket hang up` 30 seconds
 * in — pointing at the browser, which was healthy the whole time.
 */
describe('loopback proxy bypass', () => {
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('exempts loopback when nothing is configured', () => {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    bypassProxyForLoopback();

    for (const key of ['NO_PROXY', 'no_proxy'] as const) {
      expect(process.env[key]?.split(',')).toEqual(
        expect.arrayContaining(['127.0.0.1', 'localhost', '::1']),
      );
    }
  });

  it('adds the literal address even when localhost is already exempt', () => {
    // The trap this exists for. `NO_PROXY=localhost` is the conventional value and
    // reads as correct, but Playwright string-matches the URL host with no name
    // resolution — and the URL is built from `127.0.0.1`.
    process.env.NO_PROXY = 'localhost';
    delete process.env.no_proxy;

    bypassProxyForLoopback();

    expect(process.env.NO_PROXY?.split(',')).toContain('127.0.0.1');
  });

  it('keeps entries the deployment set for its own reasons', () => {
    // Widening a bypass list is ours to do; narrowing it is not.
    process.env.NO_PROXY = '.internal,10.0.0.0/8';

    bypassProxyForLoopback();

    const entries = process.env.NO_PROXY?.split(',') ?? [];
    expect(entries).toContain('.internal');
    expect(entries).toContain('10.0.0.0/8');
    expect(entries).toContain('127.0.0.1');
  });

  it('does not accumulate duplicates when called for every join', () => {
    process.env.NO_PROXY = '127.0.0.1';

    bypassProxyForLoopback();
    bypassProxyForLoopback();

    const entries = process.env.NO_PROXY?.split(',') ?? [];
    expect(entries.filter((entry) => entry === '127.0.0.1')).toHaveLength(1);
  });

  it('leaves a total bypass alone rather than narrowing it', () => {
    // `*` already means "proxy nothing". Appending would be inert for Playwright but
    // actively wrong for the `shell_exec` children that inherit this env: curl and
    // Python honour `*` only as the whole value, never as one entry in a list.
    process.env.NO_PROXY = '*';

    bypassProxyForLoopback();

    expect(process.env.NO_PROXY).toBe('*');
  });

  it('exempts loopback before it launches anything', async () => {
    // The wiring, not the helper. The production bug was that `start()` never did
    // this, and a test on the helper alone stays green if the call site is deleted.
    //
    // No browser is launched: resolving the binary is the first thing `start()` does
    // after the bypass, so failing it there proves the env was already widened by
    // the time anything could have used it.
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const present = path.join(tmp, 'exists');
    await fs.writeFile(present, '#!/bin/sh\n');
    process.env.PRISM_CHROMIUM_PATH = present;

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const promises = { ...actual.promises, access: vi.fn().mockRejectedValue(new Error('ENOENT')) };
      return { ...actual, promises, default: { ...actual, promises } };
    });
    vi.resetModules();
    const { BrowserStack } = await import('../browser-stack');

    try {
      await expect(new BrowserStack().start({ env: {} })).rejects.toThrow(/container image/i);
      expect(process.env.NO_PROXY?.split(',')).toContain('127.0.0.1');
      expect(process.env.no_proxy?.split(',')).toContain('127.0.0.1');
    } finally {
      vi.doUnmock('fs');
      vi.resetModules();
    }
  });
});

/**
 * Shutting the browser down.
 *
 * The cookie store is what is at stake. Chromium batches its writes and flushes them
 * when it quits normally; killed by a signal it skips the flush, so the profile keeps
 * a session Google no longer accepts and the next start signs in again — which is how
 * a bot account collects challenges. No browser runs here: the CDP connection and the
 * child process are stubs, because what these tests pin is the order of the steps —
 * ask, wait, detach, and signal only what is still there.
 */
describe('stop', () => {
  /** A CDP connection whose quit request may or may not be honoured. */
  function fakeBrowser(onQuit: () => void = () => {}) {
    const send = vi.fn(async (method: string) => {
      if (method === 'Browser.close') onQuit();
    });
    const close = vi.fn(async () => {});
    return {
      send,
      close,
      newBrowserCDPSession: vi.fn(async () => ({ send })),
    };
  }

  /** A child process that leaves on whichever event the test names, or never. */
  function fakeProc(leavesOn: 'nothing' | 'SIGTERM' | 'SIGKILL' = 'nothing') {
    const proc = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn((signal: string) => {
        if (signal === leavesOn) proc.signalCode = signal;
        return true;
      }),
    };
    return proc;
  }

  function stackWith(browser: unknown, proc: unknown) {
    const stack = new BrowserStack();
    Object.assign(stack, { browser, proc, context: null, mainPage: null });
    return stack;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the browser to quit, and signals nothing that already left', async () => {
    const proc = fakeProc();
    const browser = fakeBrowser(() => {
      proc.exitCode = 0;
    });

    await stackWith(browser, proc).stop();

    expect(browser.send).toHaveBeenCalledWith('Browser.close');
    // The detach still happens, and the signal ladder does not: a process that quit
    // when asked has already flushed its cookie store.
    expect(browser.close).toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('falls back to SIGTERM when the quit does not take', async () => {
    vi.useFakeTimers();
    const proc = fakeProc('SIGTERM');
    const browser = fakeBrowser();

    const stopped = stackWith(browser, proc).stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('kills the browser that survives both budgets', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const proc = fakeProc('nothing');
    const browser = fakeBrowser();

    const stopped = stackWith(browser, proc).stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped;

    expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    // Said out loud, because the cost lands on the next join rather than this one.
    expect(warn.mock.calls.map(String).join('\n')).toMatch(/did not exit in time/);
    warn.mockRestore();
  });

  it('reaps a process it cannot ask, rather than leaving the profile locked', async () => {
    // No CDP connection — a `start()` that failed after the spawn. The quit request is
    // the better path, never a precondition for reaping: a surviving process holds
    // `SingletonLock` and the next join cannot start at all.
    vi.useFakeTimers();
    const proc = fakeProc('SIGTERM');

    const stopped = stackWith(null, proc).stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('signals the process when the quit request itself fails', async () => {
    vi.useFakeTimers();
    const proc = fakeProc('SIGTERM');
    const browser = {
      newBrowserCDPSession: vi.fn(async () => {
        throw new Error('Target closed');
      }),
      close: vi.fn(async () => {}),
    };

    const stopped = stackWith(browser, proc).stop();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(stopped).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does nothing on a second call', async () => {
    // Teardown reaches this from more than one direction. `stop()` takes the browser
    // and the child out of the fields before it asks anything of them, so the second
    // call has nothing to work with — a repeated signal could reach a pid the OS has
    // since handed to somebody else.
    const proc = fakeProc();
    const browser = fakeBrowser(() => {
      proc.exitCode = 0;
    });
    const stack = stackWith(browser, proc);

    await stack.stop();
    await stack.stop();

    expect(browser.send).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
