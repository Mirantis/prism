/**
 * The browser half of a meeting: a real Chromium on a virtual display.
 *
 * Two choices worth knowing about:
 *
 * - **The system Chromium, via `playwright-core`.** Playwright drives the browser
 *   Debian installed rather than downloading its own. That keeps the image from
 *   carrying two browsers, and it's what makes the feature work on arm64 at all —
 *   Google Chrome ships amd64-only, Debian's `chromium` package does not.
 * - **Not `--headless`.** Meet's WebRTC path is markedly less reliable headless, so
 *   Chrome runs normally against the Xvfb display from `audio-stack.ts`.
 *
 * The media flags are the load-bearing ones. `--use-fake-ui-for-media-stream`
 * auto-grants the mic/camera prompt (there is nobody to click "Allow"), while the
 * device itself is a real PulseAudio source. The related-looking
 * `--use-fake-device-for-media-stream` is deliberately absent: it substitutes a
 * synthetic test tone or a fixed WAV file and cannot carry live audio, which would
 * quietly make the bot mute.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { logger } from '../../logger';

/**
 * Where Debian's chromium package puts the binary.
 *
 * `PRISM_CHROMIUM_PATH` overrides it for hosts that place it elsewhere (macOS dev
 * boxes, a distro with a different layout).
 */
const CHROMIUM_CANDIDATES = [
  process.env.PRISM_CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter((p): p is string => Boolean(p));

/**
 * A recent desktop Chrome UA.
 *
 * Meet gates features on the user agent and degrades (or refuses) for anything it
 * reads as unsupported; Playwright's default UA advertises automation.
 */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface BrowserStackOptions {
  /** DISPLAY, PULSE_SINK, PULSE_SOURCE and friends from the audio stack. */
  env: Record<string, string>;
}

export class BrowserStack {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  /** Launch Chromium on the virtual display and return a blank page. */
  async start(options: BrowserStackOptions): Promise<Page> {
    const executablePath = await resolveChromium();

    this.browser = await chromium.launch({
      executablePath,
      // Real rendering on Xvfb — see the note above.
      headless: false,
      env: { ...process.env, ...options.env } as Record<string, string>,
      args: [
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
        // Drop the `navigator.webdriver` tell.
        '--disable-blink-features=AutomationControlled',
        // Containers give /dev/shm 64 MB by default, which Chrome exhausts and
        // then crashes on; this moves the shared memory to /tmp instead.
        '--disable-dev-shm-usage',
        // No GPU on the virtual display.
        '--disable-gpu',
        '--window-size=1280,720',
        // Force PulseAudio rather than letting Chrome pick ALSA and find nothing.
        '--alsa-output-device=pulse',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 720 },
      permissions: ['microphone'],
    });

    const page = await this.context.newPage();
    page.on('crash', () => logger.error('[Meeting] Browser page crashed'));
    return page;
  }

  /** Close the browser. Idempotent, and never throws — teardown must not fail. */
  async stop(): Promise<void> {
    try {
      await this.context?.close();
    } catch (err) {
      logger.debug(`[Meeting] Context close failed: ${String(err)}`);
    }
    try {
      await this.browser?.close();
    } catch (err) {
      logger.debug(`[Meeting] Browser close failed: ${String(err)}`);
    }
    this.context = null;
    this.browser = null;
  }
}

/** First Chromium that actually exists on disk. */
export async function resolveChromium(): Promise<string> {
  const { promises: fs } = await import('fs');
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error(
    `No Chromium found (looked in ${CHROMIUM_CANDIDATES.join(', ')}). ` +
      'Voice meetings need the browser toolchain, which ships in the container image.',
  );
}

/** Whether a browser is available — used to gate the meeting tools. */
export async function isChromiumAvailable(): Promise<boolean> {
  try {
    await resolveChromium();
    return true;
  } catch {
    return false;
  }
}
