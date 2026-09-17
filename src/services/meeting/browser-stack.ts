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
 * The media flags matter too — see `buildBrowserArgs` below, where the reason each
 * one is present or absent is written down.
 *
 * Authentication is deliberately *not* here: signing in is platform-specific and
 * belongs to the provider (`providers/google-meet/sign-in.ts`). What this file owns
 * is the profile that a session is stored in — which is why the quit request in
 * `stop()` matters more than it looks: a browser that quits when asked flushes its
 * cookie store, and one that is signalled instead does not, so every join
 * re-authenticates.
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
import { withTimeout } from '../../utils/with-timeout';
import { TabSet } from './browser-tabs';

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

/** How long the browser gets to quit when asked, before the signal ladder starts. */
const CLEAN_QUIT_MS = 5_000;

/** How long the browser gets to exit after SIGTERM, before SIGKILL. */
const EXIT_GRACE_MS = 15_000;

/** Whether a spawned process has left, by either route. */
function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Wait for a spawned process to leave, up to `ms`. Reports whether it did.
 *
 * `signalCode` counts as well as `exitCode`: a Chromium that dies *from* the signal
 * sets only the former, and testing the exit code alone waited out the whole grace
 * period for a process that had already gone.
 */
async function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!hasExited(proc) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return hasExited(proc);
}

/**
 * Turn off the browser's password manager on this profile.
 *
 * A real sign-in offers to save the password, and one click writes it into the
 * profile — which sits in the data dir the agent's shell tools read, encrypted with
 * a key a container without a keyring takes from a published constant. The agent
 * never needs a stored password: a person types it, and the session cookie is what
 * the work runs on afterwards.
 *
 * These are the preferences behind the browser's own "Offer to save passwords"
 * setting, written before the launch that reads them. Passwords a profile saved
 * before this stay until somebody removes them.
 */
export async function disablePasswordStorage(userDataDir: string): Promise<void> {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // A profile that has not run yet: the file is written from nothing.
  }
  const profile = { ...(prefs.profile as object), password_manager_enabled: false };
  const next = {
    ...prefs,
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile,
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next));
}

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
  /**
   * Where the profile lives. Defaults to the meeting bot's signed-in profile; a
   * browser that may run beside a live call uses its own, since Chromium refuses a
   * second instance on one profile.
   */
  profileDir?: string;
}

/**
 * The browser's command line.
 *
 * Extracted from `start()` so the media flags are assertable without a browser.
 */
export function buildBrowserArgs(port: number, userDataDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    // Chromium's own sandbox needs unprivileged user namespaces, which the
    // container usually cannot get: we run as non-root `node` under a default
    // seccomp profile with no `SYS_ADMIN`, so the zygote fails to fork and the
    // browser dies at launch. Disabled deliberately rather than discovered in
    // production. The isolation that matters is the outer one — this whole
    // runtime already runs inside the Lens Agents sandbox with filtered egress, and
    // the browser visits exactly one origin we chose.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Auto-grant the mic/camera prompt — nobody is there to click "Allow". The
    // devices behind it are the real PulseAudio ones, not fakes. This flag has to
    // be exactly this one: `--use-fake-ui-for-media-stream` also answers
    // `getDisplayMedia` and rejects the capture, and
    // `--use-fake-device-for-media-stream` alongside it replaces the live
    // PulseAudio source with a tone.
    '--auto-accept-camera-and-microphone-capture',
    // Pick the screen for `getDisplayMedia`. The value is matched against the names
    // in Chromium's own picker list, so it depends on two things below and nearby:
    // `--lang=en-US`, which keeps those names English, and a single-monitor
    // display, which is what `audio-stack.ts` gives us — one screen is named
    // "Entire screen". The space in it is safe because `spawn` is handed an array
    // and no shell.
    //
    // The flag is a browser-wide switch, not a Meet one: *every* page this browser
    // loads gets the auto-selection, so any origin that calls `getDisplayMedia()`
    // receives the whole virtual display — no picker, and no user gesture of any
    // kind. Before this flag that call simply failed. Acceptable only because the
    // browser is ours and visits the one origin we send it to.
    '--auto-select-desktop-capture-source=Entire screen',
    // Meet starts playing before any user gesture exists.
    '--autoplay-policy=no-user-gesture-required',
    // The meeting tab sits in the background for as long as the agent is browsing in
    // the other one, and Chromium throttles a background tab's timers and its whole
    // renderer. The call is the thing that must not slow down, so all three are off.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
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
  ];
}

/**
 * Camera and microphone permission for every origin the profile visits.
 *
 * The flag above answers the permission *request*, but leaves
 * `navigator.permissions.query({ name: 'microphone' })` reporting `prompt`, where
 * the old fake-UI flag reported `granted`. Meet reads permission state to decide
 * whether to offer its "continue without microphone" panels, so the state is worth
 * keeping as it was.
 *
 * The two mechanisms are not the same thing, which is why both are here. The flag
 * answers a prompt; this overrides the state the page reads. It is a *session*
 * override, not a stored content setting: Playwright issues
 * `Browser.grantPermissions` over CDP, and that writes nothing into the persistent
 * profile. It still recovers a profile that once recorded a block — measured, a
 * stored block reads `denied` and the override turns it into `granted` — but only
 * because `start()` re-applies it on every call. Nothing here clears the stored
 * block itself.
 *
 * The override lives as long as the **CDP connection**, not as long as the browser.
 * Measured: detach and re-attach to the same browser process and both read `prompt`
 * again. So a second CDP client that grants any permission and then disconnects
 * clears these two as well, which would leave a live call deaf and mute. Worth
 * knowing before anything else is driven over the debugging port.
 *
 * Either mechanism alone was measured to open the microphone, so this is the
 * backstop if a browser build drops the flag. A prompt nobody can click is a bot
 * that joins deaf.
 *
 * The call carries no origin, which grants these two everywhere and *denies* every
 * other permission everywhere. Measured: notifications and geolocation move from
 * `prompt` (an unanswerable prompt in a browser nobody watches) to `denied`, while
 * clipboard and screen wake lock move from `granted` to `denied`. Both are
 * acceptable losses here — the agent never copies anything, and there is no real
 * screen to keep awake. Screen capture is not affected.
 *
 * Best effort — a failure here is not a reason to abandon a join the flag can
 * carry on its own.
 */
async function grantMediaPermissions(context: BrowserContext): Promise<void> {
  try {
    await context.grantPermissions(['microphone', 'camera']);
  } catch (err) {
    logger.warn({ err }, '[Meeting] Could not pre-grant the media permissions');
  }
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
  /** The meeting's own tab, kept so `front()` can answer before a second one exists. */
  private mainPage: Page | null = null;
  /**
   * The tabs the agent browses in. The meeting's tab is never one of them.
   *
   * A tab the site opened itself is in here too — a link with `target="_blank"` makes a
   * page the agent never asked for, and a list without it would report a click that did
   * nothing.
   */
  private readonly tabs = new TabSet();
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
    const userDataDir = options.profileDir ?? profileDir();
    await fs.mkdir(userDataDir, { recursive: true });
    await clearStaleProfileLocks(userDataDir);
    // Fatal on purpose: a browser that would offer to save a password is the one
    // thing this profile must never be.
    await disablePasswordStorage(userDataDir);

    // Spawned as its own process rather than through `chromium.launch`. See the
    // module comment: Playwright's launch path is what Meet answers 403 to.
    this.proc = spawn(
      executablePath,
      buildBrowserArgs(port, userDataDir),
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
    await grantMediaPermissions(this.context);

    const page = await this.context.newPage();
    page.on('crash', () => logger.error('[Meeting] Browser page crashed'));
    this.mainPage = page;
    // A page the site opens for itself — a link with `target="_blank"` — arrives here
    // and nowhere else. Registered after the meeting's own page, so that one is never
    // adopted as a tab the agent may navigate.
    this.context.on('page', (opened) => this.tabs.add(opened));

    return page;
  }

  /**
   * The tab the display is showing, which is the tab a screen share presents.
   *
   * Only the methods below bring a tab to the front. So the active tab is in front once
   * one exists, and before that the meeting tab is the only tab.
   */
  front(): Page | null {
    return this.tabs.current() ?? this.mainPage;
  }

  /**
   * The tab the agent is working in, opening the first one on demand.
   *
   * A `goto` on the meeting page would end the call, so every address the agent opens
   * lands here instead. Reading that page is a different matter: the participants
   * panel, the share controls and a screenshot of the call all come off it.
   *
   * Every call brings the tab to the front, because a screen share captures the display
   * and not one window.
   *
   * The meeting tab then runs in the background. The anti-throttling flags in
   * `buildBrowserArgs()` keep it working there.
   */
  async workbench(): Promise<Page> {
    return (await this.tabs.raise()) ?? this.openTab();
  }

  /** Open a tab and make it the active one. */
  async openTab(): Promise<Page> {
    if (!this.context) throw new Error('The browser is not running.');

    const page = await this.context.newPage();
    page.on('crash', () => logger.error('[Meeting] Browser tab crashed'));
    this.tabs.add(page);
    await page.bringToFront();
    return page;
  }

  /** The open tabs, oldest first. The active one is `front()`. */
  listTabs(): Page[] {
    return this.tabs.list();
  }

  /** Match the browser's visible tab after the user has used its tab strip. */
  async observeFront(): Promise<void> {
    for (const page of this.tabs.list()) {
      if (await page.evaluate("document.visibilityState === 'visible'").catch(() => false)) {
        this.tabs.observe(page);
        return;
      }
    }
  }

  /**
   * Put the active tab back in front, if there is one.
   *
   * For a caller that had to work in the meeting tab and now owes the room the tab it
   * was watching. Opens nothing: a call that never browsed has no tab to raise.
   */
  async raiseActiveTab(): Promise<Page | null> {
    return this.tabs.raise();
  }

  /** Make tab `index` (zero-based, as `listTabs` orders them) the active one. */
  async selectTab(index: number): Promise<Page | null> {
    return this.tabs.select(index);
  }

  /** Close tab `index`. The tab before it becomes active. */
  async closeTab(index: number): Promise<boolean> {
    return this.tabs.close(index);
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
    // Taken and released in the same act, so a second call has nothing to work with
    // and the ladder below cannot run twice against one process.
    const browser = this.browser;
    const proc = this.proc;
    this.context = null;
    this.browser = null;
    this.mainPage = null;
    this.proc = null;
    this.tabs.clear();

    // Ask the browser to quit before signalling it. Chromium batches cookie writes
    // and flushes them when it quits normally; killed by a signal it takes a fast
    // path that skips the flush, leaving the store as it was some seconds earlier and
    // a `-journal` file beside it. The session Google handed this profile is what is
    // lost that way, so the next start signs in again — and an account that logs in
    // on every start gets challenged. `Browser.close` is the request; it is not
    // `browser.close()`, which on a CDP connection only detaches.
    if (browser && proc) {
      try {
        const session = await browser.newBrowserCDPSession();
        await withTimeout(session.send('Browser.close'), CLEAN_QUIT_MS);
      } catch (err) {
        // A connection that drops while the request is in flight is the browser
        // leaving, so the exit test below is the answer rather than this.
        logger.debug(`[Meeting] Browser quit request ended early: ${String(err)}`);
      }
      logger.debug(
        (await waitForExit(proc, CLEAN_QUIT_MS))
          ? '[Meeting] Browser quit when asked, so its cookie store is flushed'
          : '[Meeting] Browser did not quit when asked — signalling it',
      );
    }

    // The context belongs to the persistent profile; closing it would be closing
    // the browser's only window out from under the process we spawned. Detach
    // instead, then stop the process itself.
    try {
      await browser?.close();
    } catch (err) {
      logger.debug(`[Meeting] Browser close failed: ${String(err)}`);
    }

    // We spawned it, so we have to reap it: closing the CDP connection leaves the
    // process running with the profile locked, and the next meeting would fail to
    // start with a SingletonLock error.
    if (!proc || hasExited(proc)) return;

    try {
      proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    // Fifteen seconds, because the cost of being wrong lands on the *next* join: a
    // browser killed mid-write loses the session it was holding.
    if (!(await waitForExit(proc, EXIT_GRACE_MS))) {
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
