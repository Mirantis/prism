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
 * Sign-in lives here as well, because it is a property of the browser profile
 * rather than of any one meeting — see `signInIfConfigured`.
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { config } from '../../config';
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

/** Wait for a locator to become visible, answering false instead of throwing. */
async function appearsVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
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
  private authenticated = false;

  /** Whether the profile ended up signed into a Google account. */
  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Start the browser on the virtual display and return a blank page. */
  async start(options: BrowserStackOptions): Promise<Page> {
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

    await this.signInIfConfigured(page);
    return page;
  }

  /** Wait for the debugging endpoint to come up, then connect to it. */
  private async attach(port: number): Promise<Browser> {
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

  /**
   * Sign the browser into Google, if an account is configured and the profile
   * isn't signed in already.
   *
   * Signing in is not a nicety — Meet **auto-denies automated anonymous guests**
   * (`CreateMeetingDevice` 403, with the host never prompted), so a bot that isn't
   * signed in can reach the lobby and never get further. A signed-in account is an
   * ordinary participant.
   *
   * Failure is deliberately not fatal: the join attempt continues as a guest and
   * reports Google's own refusal, which is a far clearer symptom than a login error
   * from a screen nobody saw.
   */
  private async signInIfConfigured(page: Page): Promise<void> {
    const email = config.googleBotEmail;
    const password = config.googleBotPassword;
    if (!email || !password) {
      logger.info('[Meeting] No Google account configured — joining as an anonymous guest');
      return;
    }
    if (await this.isSignedIn(page)) {
      this.authenticated = true;
      logger.info('[Meeting] Reusing the signed-in session from the persisted profile');
      return;
    }

    logger.info(`[Meeting] Signing in as ${email.replace(/^[^@]+/, '***')}`);
    try {
      // `hl=en` pins the interface language. Without it Google localizes from the
      // egress IP — a German page rendered here once — and every selector below is
      // written in English. `ServiceLogin` (rather than the bare origin) asks for
      // the identifier form instead of whatever Google decides to show.
      await page.goto(
        'https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F',
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );

      // The identifier field is `type="text"`, not `type="email"` — matching on
      // type finds nothing and times out.
      const identifier = page.locator('#identifierId');
      if (!(await appearsVisible(identifier, 8_000))) {
        // A leftover session shows an account chooser rather than the email form.
        // "Use another account" is the way back to it.
        const another = page
          .getByRole('link', { name: /use another account/i })
          .or(page.getByRole('button', { name: /use another account/i }))
          .first();
        if (await appearsVisible(another, 5_000)) {
          logger.info('[Meeting] Account chooser shown; asking for the sign-in form');
          await another.click({ timeout: 5_000 });
        }
      }
      await identifier.waitFor({ state: 'visible', timeout: 20_000 });
      await identifier.click();
      await identifier.type(email, { delay: 60 });
      await page.getByRole('button', { name: /^next$/i }).first().click({ timeout: 10_000 });

      const pw = page.locator('input[type="password"]:visible, input[name="Passwd"]').first();
      await pw.waitFor({ state: 'visible', timeout: 25_000 });
      await pw.click();
      await pw.type(password, { delay: 60 });
      await page.getByRole('button', { name: /^next$/i }).first().click({ timeout: 10_000 });

      // Settling time: Google interposes redirects and occasional interstitials.
      await page.waitForTimeout(8_000);

      if (await this.isSignedIn(page)) {
        this.authenticated = true;
        logger.info('[Meeting] Signed in; the profile will be reused on later calls');
        return;
      }
      // Most often a "verify it's you" challenge, which needs a code only a human
      // has. Say so plainly instead of leaving a silent guest join to fail later.
      const visible = await page
        .locator('body')
        .innerText({ timeout: 3_000 })
        .catch(() => '');
      logger.warn(
        `[Meeting] Sign-in did not complete — Google is likely challenging this account. ` +
          `Page said: ${visible.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
    } catch (err) {
      logger.warn(`[Meeting] Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Whether Google still accepts this profile's session — asked by navigating, not
   * by looking for a cookie.
   *
   * A cookie check was the obvious implementation and it was wrong in the way that
   * mattered: Google's auth cookies rotate, and a profile whose browser was killed
   * mid-rotation keeps a `__Secure-1PSID` that Google no longer honours. We reported
   * "signed in", Meet disagreed, offered a guest name field, and the join was
   * auto-denied — with nothing in the logs pointing at the session.
   *
   * `myaccount.google.com` is the test because it only stays on that origin for a
   * live session; without one it bounces to `accounts.google.com` or to the
   * `www.google.com/account/about` marketing page. Returning false is what triggers
   * a fresh login, so a stale profile heals itself.
   */
  private async isSignedIn(page: Page): Promise<boolean> {
    try {
      await page.goto('https://myaccount.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Let the redirect chain settle before reading the URL.
      await page.waitForTimeout(2_000);
      return page.url().startsWith('https://myaccount.google.com/');
    } catch (err) {
      logger.debug(`[Meeting] Sign-in check failed: ${String(err)}`);
      return false;
    }
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
      // old 500 ms was not enough for that.
      const deadline = Date.now() + 8_000;
      while (proc.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (proc.exitCode === null) {
        logger.warn('[Meeting] Browser did not exit in time; killing it');
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

/** Whether a browser is available — used to gate the meeting tools. */
export async function isBrowserAvailable(): Promise<boolean> {
  try {
    await resolveBrowser();
    return true;
  } catch {
    return false;
  }
}
