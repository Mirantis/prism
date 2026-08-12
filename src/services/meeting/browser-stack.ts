/**
 * The browser half of a meeting: a real browser on a virtual display.
 *
 * Three choices here are load-bearing, and all three were established by watching
 * Google's RPCs reject us:
 *
 * - **Spawned as an ordinary browser, then attached over CDP.** Letting Playwright
 *   *launch* the browser made Meet answer `ResolveMeetingSpace` with 403 before any
 *   interaction — the page never even rendered a join button. Starting the browser
 *   the way a desktop would (its own process, `--remote-debugging-port`) and
 *   connecting afterwards turns that same call into a 200. Playwright's launch path
 *   adds automation switches and instrumentation that Google reads; attaching does
 *   not.
 * - **Not `--headless`.** Meet's WebRTC path is markedly less reliable headless, so
 *   the browser runs normally against the Xvfb display from `audio-stack.ts`.
 * - **No user-agent override.** A hand-written UA used to be set here to "look
 *   normal". It was actively harmful: the browser still sends `Sec-CH-UA` client
 *   hints from its real build, so requests carried `Chrome/140` in the UA and
 *   `"Chromium";v="151"` in the hints simultaneously. Comparing those is the
 *   cheapest bot check there is; an honest Chromium is quieter than a mismatched
 *   pair.
 *
 * The media flags matter too. `--use-fake-ui-for-media-stream` auto-grants the
 * mic/camera prompt (nobody is there to click "Allow"), while the device behind it
 * is a real PulseAudio source. The similar-looking
 * `--use-fake-device-for-media-stream` is deliberately absent: it substitutes a
 * synthetic tone or a fixed WAV and cannot carry live audio, which would silently
 * make the bot mute.
 *
 * Authentication is deliberately *not* here: signing in is platform-specific and
 * belongs to the provider (`providers/google-meet/sign-in.ts`). What this file owns
 * is the profile that a session is stored in — which is why `EXIT_GRACE_MS` below
 * matters more than it looks: the browser must be given time to flush its cookie
 * store, or every join re-authenticates.
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
// Type-only, deliberately: `chromium` is loaded lazily in `attach()` so
// `playwright-core` stays out of the static import graph. It cannot be bundled into
// the SEA binaries — esbuild can't resolve its optional `chromium-bidi` imports —
// and it doesn't need to be, because a binary ships no browser or audio server and
// therefore never registers the meeting tools at all. See `scripts/build-sea.mjs`.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { resolveDataDir } from '../../lib/data-dir';
import { logger } from '../../logger';

/**
 * Browser binaries to try, best first.
 *
 * Real Google Chrome is preferred over Debian's `chromium` where present: Meet
 * scores the client, and Chrome-branded builds are the documented winning side of
 * that. `PRISM_CHROMIUM_PATH` overrides for hosts with a different layout.
 */
const BROWSER_CANDIDATES = [
  process.env.PRISM_CHROMIUM_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

/**
 * The browser profile, kept in the data dir so a signed-in session survives
 * restarts.
 *
 * This is the whole reason sign-in is affordable: Google challenges a *new* device,
 * not a returning one, so persisting the profile turns login into a rare event
 * instead of a per-meeting gamble.
 */
function profileDir(): string {
  return path.join(resolveDataDir(), 'meeting-browser-profile');
}

/** How long the browser gets to exit — and flush its cookie store — before SIGKILL. */
const EXIT_GRACE_MS = 15_000;

/**
 * Remove the profile's singleton lock files.
 *
 * Chromium writes `SingletonLock` as a symlink naming `<hostname>-<pid>` and
 * refuses to start when it cannot prove that process is gone. After a container is
 * replaced, the hostname in the lock belongs to a container that no longer exists,
 * so Chromium can't check it and simply exits (code 21) — which looks exactly like
 * "the browser is broken" and is really "the last run didn't get to clean up".
 *
 * Safe to clear unconditionally because this profile has exactly one owner: one
 * `AGENT_ID` per container means one data dir, and a meeting tears its browser down
 * before `start()` can be called again. Any lock present here is therefore stale by
 * construction. (If a deployment ever shared one data dir between containers, this
 * assumption — not this function — is what would need revisiting.)
 */
async function clearStaleProfileLocks(userDataDir: string): Promise<void> {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      await fs.unlink(path.join(userDataDir, name));
      logger.info(`[Meeting] Cleared a stale browser profile lock (${name})`);
    } catch {
      // Absent is the normal case.
    }
  }
}

export interface BrowserStackOptions {
  /** DISPLAY, PULSE_SINK, PULSE_SOURCE and friends from the audio stack. */
  env: Record<string, string>;
}

/** An unused localhost port for the browser's debugging endpoint. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export class BrowserStack {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private proc: ChildProcess | null = null;
  /** Tail of the browser's stderr, for explaining a launch failure. */
  private browserStderr = '';

  /** Start the browser on the virtual display and return a blank page. */
  async start(options: BrowserStackOptions): Promise<Page> {
    // Before the spawn below, not just before the CDP attach that needs it: the
    // child is handed `{ ...process.env }`, so doing this later would give the
    // browser of the *first* meeting a different environment from every one after
    // it. Harmless in itself — Chromium bypasses loopback on its own — but an env
    // that changes shape once a meeting has run is a trap for the next reader.
    bypassProxyForLoopback();
    const executablePath = await resolveBrowser();
    const port = await freePort();
    const userDataDir = profileDir();
    await fs.mkdir(userDataDir, { recursive: true });
    await clearStaleProfileLocks(userDataDir);

    // Spawned as its own process rather than through `chromium.launch`. See the
    // module comment: Playwright's launch path is what Meet answers 403 to.
    this.proc = spawn(
      executablePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        // Chromium's own sandbox needs unprivileged user namespaces, which the
        // container usually cannot get: we run as non-root `node` under a default
        // seccomp profile with no `SYS_ADMIN`, so the zygote fails to fork and the
        // browser dies at launch. Disabled deliberately rather than discovered in
        // production. The isolation that matters is the outer one — this whole
        // runtime already runs inside the Nexus sandbox with filtered egress, and
        // the browser visits exactly one origin we chose.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Auto-grant the mic/camera permission prompt. The devices behind it are
        // the real PulseAudio ones, not fakes.
        '--use-fake-ui-for-media-stream',
        // Meet starts playing before any user gesture exists.
        '--autoplay-policy=no-user-gesture-required',
        // Containers give /dev/shm 64 MB by default, which Chrome exhausts and
        // then crashes on; this moves the shared memory to /tmp instead.
        '--disable-dev-shm-usage',
        // No crash reports out of an agent container. Note these do NOT stop the
        // crashpad *handler* from starting — it re-parents itself to PID 1
        // regardless, which is why the image runs under tini to reap it (see the
        // ENTRYPOINT comment in the Dockerfile).
        '--disable-breakpad',
        '--disable-crash-reporter',
        // Meet localizes from Accept-Language or IP geolocation, which would serve
        // a differently-worded lobby and break every selector in the provider.
        '--lang=en-US',
        '--accept-lang=en-US,en',
        '--window-size=1280,720',
        '--no-first-run',
        '--no-default-browser-check',
        // Force PulseAudio rather than letting Chrome pick ALSA and find nothing.
        '--alsa-output-device=pulse',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...options.env } },
    );
    this.proc.on('error', (err) => logger.error({ err }, '[Meeting] Browser process failed'));
    // Kept so a launch failure can say *why*. Without it, an exit code is all the
    // diagnosis there is, and Chromium's codes are not self-explanatory.
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) this.browserStderr = `${this.browserStderr}${line}\n`.slice(-2000);
    });

    this.browser = await this.attach(port);
    // A CDP-attached browser already has a context; making another would lose the
    // persistent profile, and with it the signed-in session.
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());

    const page = await this.context.newPage();
    page.on('crash', () => logger.error('[Meeting] Browser page crashed'));

    return page;
  }

  /** Wait for the debugging endpoint to come up, then connect to it. */
  private async attach(port: number): Promise<Browser> {
    // Resolved once, here rather than at module load — see the import comment.
    const { chromium } = await import('playwright-core');
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (this.proc?.exitCode !== null && this.proc?.exitCode !== undefined) {
        throw new Error(
          `Browser exited before it was ready (code ${this.proc.exitCode})` +
            (this.browserStderr ? `: ${this.browserStderr.trim().split('\n').slice(-3).join(' | ')}` : ''),
        );
      }
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error(
      `Could not attach to the browser: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /** Close the browser. Idempotent, and never throws — teardown must not fail. */
  async stop(): Promise<void> {
    // The context belongs to the persistent profile; closing it would be closing
    // the browser's only window out from under the process we spawned. Detach
    // instead, then stop the process itself.
    try {
      await this.browser?.close();
    } catch (err) {
      logger.debug(`[Meeting] Browser close failed: ${String(err)}`);
    }
    this.context = null;
    this.browser = null;

    // We spawned it, so we have to reap it: closing the CDP connection leaves the
    // process running with the profile locked, and the next meeting would fail to
    // start with a SingletonLock error.
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      // Give it real time to shut down. Chromium flushes its cookie store on exit,
      // and killing it too early leaves a half-rotated session that Google later
      // rejects — which costs a fresh login, and Google challenges new devices. The
      // old 500 ms was not enough for that; 8 s turned out to be marginal too, and
      // the cost of being wrong lands on the *next* join rather than this one, so it
      // is paid for generously here.
      const deadline = Date.now() + EXIT_GRACE_MS;
      while (proc.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (proc.exitCode === null) {
        logger.warn(
          '[Meeting] Browser did not exit in time; killing it — the next join may need a fresh sign-in',
        );
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }
}

/** First browser binary that actually exists on disk, best candidate first. */
export async function resolveBrowser(): Promise<string> {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error(
    `No browser found (looked in ${BROWSER_CANDIDATES.join(', ')}). ` +
      'Voice meetings need the browser toolchain, which ships in the container image.',
  );
}

/** Addresses that must never be sent to an egress proxy. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * Keep the loopback CDP handshake away from any configured egress proxy.
 *
 * `connectOverCDP` fetches `/json/version` over plain HTTP before it opens the
 * WebSocket, and Playwright honours `HTTP_PROXY`/`HTTPS_PROXY` for that fetch. Where
 * those are set without a loopback exemption — an ordinary corporate-proxy shape,
 * not an exotic one — the request to *our own browser* is tunnelled to the proxy,
 * which answers with an empty reply. The join then fails as `socket hang up` after
 * burning the full 30s attach deadline, blaming the browser for something the
 * browser had no part in. It cost an afternoon to find the first time.
 *
 * Two details are load-bearing:
 *
 * - **Merged, not assigned.** A deployment that already sets `NO_PROXY` keeps its
 *   own entries; we only widen the bypass. Assigning would silently disable
 *   whatever exemptions the operator needs.
 * - **The literal `127.0.0.1`, not just `localhost`.** Playwright string-matches the
 *   URL host — no name resolution, no CIDR — and this connects to `127.0.0.1`. So
 *   the conventional `NO_PROXY=localhost` looks correct and still fails, which is
 *   exactly the trap that makes this worth owning in code rather than leaving to
 *   deployment config.
 *
 * Called from `start()` rather than from the attach itself, so the Chromium child —
 * spawned with `{ ...process.env }` — sees the same value on the first meeting as on
 * every one after it. It is unaffected either way, since it bypasses loopback of its
 * own accord and still proxies everything else, which it must to reach the meeting.
 *
 * A lone `*` is left alone. Every proxy client agrees it means "bypass everything",
 * so there is nothing to add; but curl and Python only honour `*` as the *whole*
 * value, not as one entry in a list, so appending would narrow the bypass for the
 * `shell_exec` children that inherit this env — the opposite of the intent.
 */
export function bypassProxyForLoopback(): void {
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const entries = (process.env[key] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.includes('*')) continue;
    const missing = LOOPBACK_HOSTS.filter((host) => !entries.includes(host));
    if (missing.length === 0) continue;
    process.env[key] = [...entries, ...missing].join(',');
  }
}

/** Whether a browser is available — used to gate the meeting tools. */
export async function isBrowserAvailable(): Promise<boolean> {
  try {
    await resolveBrowser();
    return true;
  } catch {
    return false;
  }
}
