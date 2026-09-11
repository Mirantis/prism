/**
 * The computer the agent works on: a browser, and on a host without a display of its
 * own, a whole desktop around it.
 *
 * One of these belongs to one voice session. It opens a browser on a virtual display
 * with an XFCE desktop, streams pictures of that screen, hands on the sound the browser
 * plays, and carries out the `browse` and `desktop_*` tools. On a host that already has
 * a display the browser opens there, and there is no desktop to act on: the tools that
 * need one say so.
 *
 * What it shows the model goes through `ModelChannel`, so the computer knows nothing
 * about the session it belongs to beyond those two methods.
 */

import path from 'path';
import type { Page } from 'playwright-core';
import { logger } from '../../logger';
import { resolveDataDir } from '../../lib/data-dir';
import { AudioStack, type AudioStackHandles } from '../meeting/audio-stack';
import { BrowserStack } from '../meeting/browser-stack';
import {
  capture,
  normalizeUrl,
  read,
  runBrowserCommand,
  summarizeTabs,
  type BrowserCommand,
  type BrowserReading,
  type BrowserResult,
} from '../meeting/browser-control';
import {
  type DesktopActionResult,
  type TextLocation,
  type ComputerBrowser,
  type ComputerDesktop,
  type ComputerUserScreen,
} from './computer-tools';
import { DesktopControl, type MouseButton, type ScrollDirection } from './desktop-control';
import {
  clampScreen,
  currentScreen,
  DEFAULT_SCREEN,
  MAX_SCREEN,
  OCR_SCALE,
  resizeDisplay,
  sameSize,
  sizeText,
  type ScreenSize,
} from './screen-size';
import { findText, readLines, readScreenWords, upscaleForOcr } from './screen-text';
import { describeElements, findElements, readScreenElements } from './screen-elements';
import { actOnWindow, findWindows, listWindows, type WindowAction } from './desktop-windows';
import { DesktopInput, type InputFrame } from './desktop-input';
import { hasBinaries } from './has-binary';
import { ScreenStream } from './screen-stream';
import { DisplayStream } from './display-stream';
import { DesktopSession } from './desktop-session';
import type { PictureStream } from './picture-stream';

/**
 * How the computer shows the model what it did: a picture into the live session, and a
 * line of narration when something changed that nobody asked about.
 *
 * The note on a picture says the picture is a tool's answer rather than something the
 * user said, since a session takes both on the same conversation.
 */
export interface ModelChannel {
  /** Put a picture in front of the model. False when it did not get through. */
  showImage(imageUrl: string, note: string): boolean;
  /** Tell the model something in words, without asking it to answer. */
  notify(text: string): void;
}

/** Whether a capture chunk is nothing but silence, which is most of them. */
function isSilent(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
  return true;
}

/**
 * What the agent's working tab shows before it goes anywhere. A page with content, so
 * the screen stream has a picture from the first second; `about:blank` never repaints
 * and so never produces a frame.
 */
const START_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><title>Ready</title>' +
      '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#18181b;color:#a1a1aa;font:24px system-ui,sans-serif">Ready</body>',
  );

/** The label a screenshot carries into the session; see `meeting-bot.service.ts`. */
const SCREEN_LOOK_NOTE =
  'This is a picture of your own screen as it looks right now, in answer to your ' +
  'see_screen call. Your user did not say this.';
const DESKTOP_AFTER_NOTE =
  'This is a picture of your own screen right after the desktop action you just took. ' +
  'Your user did not say this.';/** How long the desktop gets to redraw after an action before the picture is taken. */
const ACTION_SETTLE_MS = 400;
const USER_SCREEN_NOTE =
  "This is a picture of your user's own screen, which they are sharing with you, in answer " +
  'to your see_user_screen call. Your user did not say this.';

/**
 * A page frame that is about the user's shared screen rather than the desktop's input:
 * sharing began, a picture of it, sharing ended.
 */
type ScreenShareFrame =
  | { type: 'user_screen_started' }
  | { type: 'user_screen'; data: string; width: number; height: number }
  | { type: 'user_screen_stopped' };

/** The size of the rectangle the page is showing the screen in, in its own device pixels. */
type ViewportFrame = { type: 'viewport'; width: number; height: number };

type PageFrame = InputFrame | ScreenShareFrame | ViewportFrame;

/** A shared-screen picture larger than this is refused; a 1280-wide JPEG is far smaller. */
const USER_SCREEN_MAX_CHARS = 6 * 1024 * 1024;
/** How much of the words read off the user's screen goes back to the model. */
const USER_SCREEN_TEXT_MAX_CHARS = 4_000;

/** The past tense of each window action, for the message that comes back. */
const WINDOW_ACTION_DONE: Record<WindowAction, string> = {
  focus: 'Brought to the front',
  close: 'Closed',
  maximize: 'Maximised',
  restore: 'Restored',
  minimize: 'Minimised',
};

/** Everything one voice session's computer owns, released together when it ends. */
export class AgentComputer implements ComputerBrowser, ComputerDesktop, ComputerUserScreen {
  /** Where pictures and narration go once the session has a model to show them to. */
  private channel: ModelChannel | null = null;
  private browser: BrowserStack | null = null;
  /** The newest picture of the user's shared screen, while they share one. */
  private userScreen: { jpeg: Buffer; width: number; height: number; at: number } | null = null;
  /** Whether ffmpeg and Tesseract are on this host, so the shared screen can be read as text. */
  private ocrAvailable: Promise<boolean> | null = null;
  /** Mouse, keyboard and camera for the virtual display. Null where the browser is on a real one. */
  private desktopControl: DesktopControl | null = null;
  /** DISPLAY plus the session bus, for the tree dump and `wmctrl`. */
  private desktopEnv: Record<string, string> = {};
  /** The user's own pointer and keyboard on that display, from the page. */
  private input: DesktopInput | null = null;
  /** The first, blank tab `BrowserStack.start()` opens; `browse` works in others. */
  private mainPage: Page | null = null;
  /** A virtual display for the browser on a host without one (the container). */
  private display: AudioStack | null = null;
  /**
   * The virtual display's audio devices. The browser plays into their sink, and its
   * monitor is how the page gets to hear what the browser plays. Null on a host with
   * a real display, where the browser's sound comes out of the host's own speakers.
   */
  private audioHandles: AudioStackHandles | null = null;
  /** The XFCE desktop on the virtual display. Null where the browser is on a real one. */
  private desktop: DesktopSession | null = null;
  private screen: PictureStream | null = null;
  /** The size of the agent's screen, which the client's own rectangle decides. */
  private size: ScreenSize = DEFAULT_SCREEN;
  /** Everything that moves the front tab runs in arrival order; see the meeting service. */
  private frontTail: Promise<void> = Promise.resolve();
  /**
   * Resizes run one at a time.
   *
   * A resize can wait seconds for a desktop that is still coming up, and a client that
   * changed its mind in that time would otherwise have two of them racing to say what
   * size the screen is.
   */
  private resizeTail: Promise<void> = Promise.resolve();

  /** Where pictures and narration go. Called once the session has a model to send to. */
  attach(channel: ModelChannel): void {
    this.channel = channel;
  }

  /**
   * Open the browser. Every voice chat has one, so a browser that cannot start ends
   * the chat before it begins: the error names the reason for the page.
   */
  async openBrowser(screen?: ScreenSize): Promise<void> {
    if (screen) this.size = clampScreen(screen.width, screen.height);
    const browser = new BrowserStack();
    let display: AudioStack | null = null;
    let desktop: DesktopSession | null = null;
    try {
      let env: Record<string, string> = {};
      let handles: AudioStackHandles | null = null;
      if (process.platform === 'linux' && !process.env.DISPLAY) {
        display = new AudioStack();
        // The largest screen a client may ask for, since a framebuffer is allocated once
        // and cropped from there.
        handles = await display.start({ screen: sizeText(MAX_SCREEN) });
        env = handles.browserEnv;
        // A meeting ends on this; here the browser's sound just stops reaching the page.
        handles.onLost((reason) =>
          logger.warn(`[VoiceChat] Browser audio capture lost: ${reason}`),
        );
        // The desktop is part of the deal here, the same as the browser: an image
        // without its packages ends the chat with a message rather than a lesser page.
        if (
          !(await hasBinaries(
            'dbus-launch',
            'startxfce4',
            'xdotool',
            'xrandr',
            'ffmpeg',
            'wmctrl',
            'tesseract',
          ))
        ) {
          throw new Error(
            'this image lacks the desktop packages (xfce4, dbus-x11, ffmpeg, xdotool, wmctrl, ' +
              'x11-xserver-utils, tesseract-ocr, at-spi2-core, python3-pyatspi); rebuild it with ' +
              '`npm run docker:build`',
          );
        }
        // The desktop before the browser, so the window manager is there to place the
        // browser's window when it opens, and the session bus exists for it to join.
        desktop = new DesktopSession(env);
        await desktop.start();
        // Then cropped to what the client is showing, which needs that desktop: the
        // output has to be moved aside for the screen to shrink under it, and the
        // desktop's display manager is what does that. Before the browser, so its window
        // opens at the size it will keep.
        //
        // Not fatal. A screen at the size the server reserved is a working screen, and a
        // client that cannot have its own size should still get a call. What it actually
        // became is what everything below is told.
        await resizeDisplay(env, this.size).catch((err: unknown) => {
          logger.warn({ err }, '[VoiceChat] The screen stayed at the size the display reserved');
        });
        const actual = await currentScreen(env).catch(() => null);
        if (actual) this.size = actual;
        this.desktopEnv = { ...env, ...desktop.busEnv };
        this.desktopControl = new DesktopControl(env, this.size);
        this.input = new DesktopInput(env, this.desktopControl.width, this.desktopControl.height);
      }
      this.mainPage = await browser.start({
        // On the desktop's bus with accessibility on, so the browser's frame is in the tree.
        env: desktop ? { ...env, ...desktop.busEnv } : env,
        profileDir: path.join(resolveDataDir(), 'voice-chat-browser-profile'),
      });
      // The agent's working tab, open from the start so the page has something to show
      // and the agent's first navigation lands in it rather than opening a second one.
      const tab = await browser.openTab();
      await tab
        .goto(START_PAGE, { waitUntil: 'domcontentloaded', timeout: 10_000 })
        .catch((err) => logger.warn({ err }, '[VoiceChat] Start page did not load'));
      this.browser = browser;
      this.display = display;
      this.desktop = desktop;
      this.audioHandles = handles;
    } catch (err) {
      this.desktopControl = null;
      this.input?.stop();
      this.input = null;
      await browser.stop().catch(() => undefined);
      await desktop?.stop().catch(() => undefined);
      await display?.stop().catch(() => undefined);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not open the browser: ${reason}`);
    }
  }

  /**
   * Start sending pictures; `openBrowser()` has to have run.
   *
   * Where the runtime owns the display, the page sees the whole desktop. Where the
   * browser is on the host's own display, it sees the tab in front.
   */
  startScreenStream(onFrame: (jpegBase64: string) => void): void {
    this.screen = this.audioHandles
      ? new DisplayStream(this.audioHandles.browserEnv.DISPLAY, sizeText(this.size), onFrame)
      : new ScreenStream(() => this.browser?.front() ?? null, onFrame);
    this.screen.start();
  }

  /**
   * Start handing on what the browser plays, 48 kHz pcm16 mono, silence left out.
   *
   * Returns false on a host with a real display: there the browser's sound already
   * comes out of the host's speakers, and there is no device to record it from.
   */
  startBrowserAudio(onPcm: (pcm48k: Buffer) => void): boolean {
    if (!this.audioHandles) return false;
    this.audioHandles.onCapture((pcm) => {
      if (!isSilent(pcm)) onPcm(pcm);
    });
    return true;
  }

  async browse(command: BrowserCommand): Promise<BrowserResult> {
    const browser = this.browser;
    if (!browser) return { success: false, message: 'There is no browser in this voice chat.' };

    return this.onFrontQueue(async () => {
      try {
        const result = await this.runBrowseCommand(browser, command);
        return { ...result, tabs: await summarizeTabs(browser.listTabs(), browser.front()) };
      } catch (err) {
        logger.error({ err }, '[VoiceChat] Browser command failed');
        return { success: false, message: 'I could not reach the browser.' };
      }
    });
  }

  /**
   * Show the model the screen: the whole desktop where the runtime owns the display,
   * else the browser tab in front. The tab's reading rides along in both cases, since
   * the words on the page are worth more to a voice model than pixels.
   */
  async lookAtScreen(): Promise<{ success: boolean; message: string } & Partial<BrowserReading>> {
    const page = this.browser?.front();
    const control = this.desktopControl;

    if (control) {
      try {
        const shown = await this.showDesktop(control, SCREEN_LOOK_NOTE);
        const reading = page ? await read(page).catch(() => ({})) : {};
        return {
          success: true,
          message: shown
            ? `This is my whole screen, as a ${control.pictureWidth} by ${control.pictureHeight} ` +
              'picture; the desktop tools take coordinates from it.'
            : 'Here is what the browser tab says. I could not get the picture through.',
          ...reading,
        };
      } catch (err) {
        logger.error({ err }, '[VoiceChat] Desktop capture failed');
        return { success: false, message: 'I could not get a picture of the screen.' };
      }
    }

    if (!page) return { success: false, message: 'There is no browser window open.' };
    try {
      const { imageUrl, reading } = await capture(page);
      const shown = this.channel?.showImage(imageUrl, SCREEN_LOOK_NOTE) ?? false;
      return {
        success: true,
        message: shown
          ? 'This is what my browser is showing.'
          : 'Here is what the page says. I could not get the picture through.',
        ...reading,
      };
    } catch (err) {
      logger.error({ err }, '[VoiceChat] Screen capture failed');
      return { success: false, message: 'I could not get a picture of the browser.' };
    }
  }

  /** The model's picture size; its coordinates refer to this, not to the screen. */
  get width(): number {
    return this.desktopControl?.pictureWidth ?? 0;
  }

  get height(): number {
    return this.desktopControl?.pictureHeight ?? 0;
  }

  /** Whether `desktop_*` tools have anything to act on. */
  get hasDesktop(): boolean {
    return this.desktopControl !== null;
  }

  /**
   * Make the screen the size of the client's own rectangle.
   *
   * Called before the display exists as well as after: an early call records the size the
   * display comes up at, which saves the desktop laying itself out twice.
   *
   * The model is told, because its prompt states the size of the picture it works in and
   * that picture follows the screen. It is told only when that size really changed, since
   * a screen below the cap is its own picture and one above it is not.
   */
  async resize(width: number, height: number): Promise<void> {
    const run = this.resizeTail.then(() => this.applyResize(width, height));
    this.resizeTail = run.catch(() => {});
    return run;
  }

  private async applyResize(width: number, height: number): Promise<void> {
    const wanted = clampScreen(width, height);
    if (sameSize(wanted, this.size)) return;
    const control = this.desktopControl;
    if (!control || !this.audioHandles) {
      // Before the display exists: this is the size it will come up at.
      this.size = wanted;
      return;
    }

    const before = { width: control.pictureWidth, height: control.pictureHeight };
    try {
      await resizeDisplay(this.audioHandles.browserEnv, wanted);
    } catch (err) {
      // The screen is still the size it was, and everything that describes it still
      // describes it correctly. The client draws a picture of one shape into a box of
      // another until it asks again.
      logger.warn({ err }, '[VoiceChat] The display would not resize');
      return;
    }
    this.size = wanted;
    control.resize(wanted);
    this.screen?.resize?.(sizeText(wanted));
    logger.info(`[VoiceChat] Screen is now ${sizeText(wanted)}`);

    const after = { width: control.pictureWidth, height: control.pictureHeight };
    if (before && !sameSize(before, after)) {
      this.channel?.notify(
        `Your screen is now ${after.width} by ${after.height} in the pictures you get of it. ` +
          'Coordinates you read off an older picture no longer point where they did.',
      );
    }
  }

  /**
   * A text frame from the page: the user's shared screen, or their pointer and keyboard
   * while they hold the desktop.
   */
  handleInput(text: string): void {
    let frame: PageFrame;
    try {
      frame = JSON.parse(text) as PageFrame;
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null || typeof frame.type !== 'string') return;

    switch (frame.type) {
      case 'viewport':
        void this.resize(Number(frame.width), Number(frame.height));
        return;
      case 'user_screen_started':
        logger.info('[VoiceChat] User started sharing their screen');
        this.channel?.notify(
          'Your user has just started sharing their screen with you. Call see_user_screen ' +
            'whenever you want to look at it, and do look when they refer to something on it.',
        );
        return;
      case 'user_screen':
        if (typeof frame.data !== 'string' || frame.data.length > USER_SCREEN_MAX_CHARS) return;
        if (!this.userScreen) {
          logger.info(`[VoiceChat] First picture of the user's shared screen, ${frame.width} by ${frame.height}`);
        }
        this.userScreen = {
          jpeg: Buffer.from(frame.data, 'base64'),
          width: Number(frame.width) || 0,
          height: Number(frame.height) || 0,
          at: Date.now(),
        };
        return;
      case 'user_screen_stopped':
        logger.info('[VoiceChat] User stopped sharing their screen');
        this.userScreen = null;
        this.channel?.notify('Your user has stopped sharing their screen.');
        return;
      default:
        this.input?.handle(frame);
    }
  }

  /**
   * Show the model the user's shared screen, as last received: the picture into the
   * session, and the words on it as text, since a model reading a picture gets the gist
   * of a dialog but garbles an error code or a hostname, which is what people share.
   */
  async lookAtUserScreen(): Promise<DesktopActionResult & { text?: string }> {
    const shared = this.userScreen;
    if (!shared) {
      return {
        success: false,
        message: 'Your user is not sharing their screen right now. Ask them to press the share button.',
      };
    }
    const shown =
      this.channel?.showImage(`data:image/jpeg;base64,${shared.jpeg.toString('base64')}`, USER_SCREEN_NOTE) ??
      false;
    const ageSeconds = Math.round((Date.now() - shared.at) / 1000);
    const text = await this.readUserScreenText(shared.jpeg);
    return {
      success: shown,
      message: shown
        ? `This is your user's shared screen, ${shared.width} by ${shared.height}, ` +
          `${ageSeconds <= 1 ? 'as of now' : `as of ${ageSeconds} seconds ago`}.` +
          (text ? ' The words on it are attached, read off the picture, top to bottom.' : '')
        : "I could not get the picture of your user's screen through.",
      ...(text ? { text } : {}),
    };
  }

  /** The words on a shared-screen picture, or undefined where this host cannot read them. */
  private async readUserScreenText(jpeg: Buffer): Promise<string | undefined> {
    this.ocrAvailable ??= hasBinaries('ffmpeg', 'tesseract');
    if (!(await this.ocrAvailable)) return undefined;
    try {
      const png = await upscaleForOcr(jpeg, OCR_SCALE);
      const lines = readLines(await readScreenWords(png, OCR_SCALE));
      const text = lines.join('\n');
      return text.length > USER_SCREEN_TEXT_MAX_CHARS
        ? `${text.slice(0, USER_SCREEN_TEXT_MAX_CHARS)}\n…`
        : text || undefined;
    } catch (err) {
      logger.info(`[VoiceChat] Could not read the user's screen as text: ${String(err)}`);
      return undefined;
    }
  }

  /** The desktop's controls as a reading, from the accessibility tree. */
  async listElements(input: { filter?: string }): Promise<DesktopActionResult> {
    if (!this.desktopControl) return { success: false, message: 'There is no desktop in this voice chat.' };
    try {
      const elements = await this.onFrontQueue(() => readScreenElements(this.desktopEnv));
      return { success: true, message: describeElements(elements, input.filter) };
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.info(`[VoiceChat:Desktop] list elements failed: ${detail}`);
      return { success: false, message: `I could not read the desktop's controls: ${detail}` };
    }
  }

  async listWindows(): Promise<DesktopActionResult> {
    if (!this.desktopControl) return { success: false, message: 'There is no desktop in this voice chat.' };
    try {
      const windows = await listWindows(this.desktopEnv);
      if (windows.length === 0) return { success: true, message: 'No windows are open.' };
      const lines = windows.map(
        (w) => `"${w.title}" at (${w.x}, ${w.y}), ${w.width} by ${w.height}`,
      );
      return { success: true, message: `${windows.length} window(s):\n${lines.join('\n')}` };
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.info(`[VoiceChat:Desktop] list windows failed: ${detail}`);
      return { success: false, message: `I could not list the windows: ${detail}` };
    }
  }

  async windowAction(input: { title: string; action: WindowAction }): Promise<DesktopActionResult> {
    if (!this.desktopControl) return { success: false, message: 'There is no desktop in this voice chat.' };
    let windows;
    try {
      windows = await listWindows(this.desktopEnv);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { success: false, message: `I could not list the windows: ${detail}` };
    }
    const [window] = findWindows(windows, input.title);
    if (!window) {
      return { success: false, message: `There is no window with "${input.title}" in its title.` };
    }
    return this.desktopAction(
      () => actOnWindow(this.desktopEnv, window, input.action),
      `${WINDOW_ACTION_DONE[input.action]} "${window.title}"`,
    );
  }

  /** Where a control or some words are on the screen right now, in picture coordinates. */
  async findText(input: { text: string }): Promise<DesktopActionResult & { matches?: TextLocation[] }> {
    const control = this.desktopControl;
    if (!control) return { success: false, message: 'There is no desktop in this voice chat.' };
    try {
      const matches = await this.locateText(control, input.text);
      if (matches.length === 0) {
        return { success: false, message: `I cannot see the text "${input.text}" on the screen right now.` };
      }
      return {
        success: true,
        message: `"${input.text}" appears ${matches.length === 1 ? 'once' : `${matches.length} times`} on the screen.`,
        matches,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.info(`[VoiceChat:Desktop] find text failed: ${detail}`);
      return { success: false, message: `I could not read the screen: ${detail}` };
    }
  }

  /** Click the centre of some words on the screen. */
  async clickText(input: {
    text: string;
    occurrence?: number;
    button?: MouseButton;
    double?: boolean;
  }): Promise<DesktopActionResult> {
    const control = this.desktopControl;
    if (!control) return { success: false, message: 'There is no desktop in this voice chat.' };
    let matches: TextLocation[];
    try {
      matches = await this.locateText(control, input.text);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.info(`[VoiceChat:Desktop] click text failed: ${detail}`);
      return { success: false, message: `I could not read the screen: ${detail}` };
    }
    if (matches.length === 0) {
      return { success: false, message: `I cannot see the text "${input.text}" on the screen right now.` };
    }
    const index = Math.min(matches.length, Math.max(1, input.occurrence ?? 1)) - 1;
    const target = matches[index];
    const button = input.button ?? 'left';
    const others = matches.length > 1 ? ` (${matches.length} matches; clicked number ${index + 1}, in "${target.line}")` : '';
    return this.desktopAction(
      (c) => c.click({ x: target.x, y: target.y }, button, input.double ? 2 : 1),
      `${input.double ? 'Double-clicked' : 'Clicked'} "${target.text}" at (${Math.round(target.x)}, ${Math.round(target.y)})${others}`,
    );
  }

  /**
   * Find `query` on the screen: a control of that name in the accessibility tree first,
   * which is exact and quick, else words read off the screen. Queued with the other
   * screen work.
   */
  private locateText(control: DesktopControl, query: string): Promise<TextLocation[]> {
    return this.onFrontQueue(async () => {
      const elements = await readScreenElements(this.desktopEnv).catch((err) => {
        logger.debug(`[VoiceChat:Desktop] accessibility tree unavailable: ${String(err)}`);
        return [];
      });
      const widgets = findElements(elements, query);
      if (widgets.length > 0) {
        return widgets.map((e) => {
          const [x, y] = control.toPicture(e.x + e.width / 2, e.y + e.height / 2);
          return { text: e.name, line: `${e.role} in ${e.app}`, x: Math.round(x), y: Math.round(y) };
        });
      }
      const png = await control.captureForOcr();
      const words = await readScreenWords(png, OCR_SCALE);
      return findText(words, query).map((m) => {
        const [x, y] = control.toPicture(m.x, m.y);
        return { text: m.text, line: m.line, x: Math.round(x), y: Math.round(y) };
      });
    });
  }

  move(input: { x: number; y: number }): Promise<DesktopActionResult> {
    return this.desktopAction(
      (control) => control.move(input.x, input.y),
      `Moved the pointer to (${Math.round(input.x)}, ${Math.round(input.y)})`,
    );
  }

  click(input: { x?: number; y?: number; button?: MouseButton; double?: boolean }): Promise<DesktopActionResult> {
    const button = input.button ?? 'left';
    const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : null;
    const verb = input.double ? 'Double-clicked' : 'Clicked';
    return this.desktopAction(
      (control) => control.click(at, button, input.double ? 2 : 1),
      at
        ? `${verb} ${button} at (${Math.round(at.x)}, ${Math.round(at.y)})`
        : `${verb} ${button} where the pointer was`,
    );
  }

  drag(input: { fromX: number; fromY: number; toX: number; toY: number; button?: MouseButton }): Promise<DesktopActionResult> {
    const button = input.button ?? 'left';
    return this.desktopAction(
      (control) => control.drag({ x: input.fromX, y: input.fromY }, { x: input.toX, y: input.toY }, button),
      `Dragged ${button} from (${Math.round(input.fromX)}, ${Math.round(input.fromY)}) to ` +
        `(${Math.round(input.toX)}, ${Math.round(input.toY)})`,
    );
  }

  type(input: { text: string }): Promise<DesktopActionResult> {
    return this.desktopAction(
      (control) => control.type(input.text),
      `Typed ${input.text.length} character${input.text.length === 1 ? '' : 's'}`,
    );
  }

  key(input: { keys: string }): Promise<DesktopActionResult> {
    return this.desktopAction((control) => control.key(input.keys), `Pressed ${input.keys}`);
  }

  scroll(input: { x: number; y: number; direction: ScrollDirection; clicks?: number }): Promise<DesktopActionResult> {
    return this.desktopAction(
      (control) => control.scroll(input.x, input.y, input.direction, input.clicks ?? 3),
      `Scrolled ${input.direction} at (${Math.round(input.x)}, ${Math.round(input.y)})`,
    );
  }

  /**
   * Run one desktop action, wait for the screen to settle, and show the model the
   * result. Queued with the browser commands, since both move what is on the screen.
   */
  private desktopAction(
    act: (control: DesktopControl) => Promise<void>,
    message: string,
  ): Promise<DesktopActionResult> {
    const control = this.desktopControl;
    if (!control) {
      return Promise.resolve({ success: false, message: 'There is no desktop in this voice chat.' });
    }
    return this.onFrontQueue(async () => {
      try {
        await act(control);
        await new Promise((r) => setTimeout(r, ACTION_SETTLE_MS));
        const shown = await this.showDesktop(control, DESKTOP_AFTER_NOTE);
        return {
          success: true,
          message: shown
            ? `${message}. The picture shows the screen now.`
            : `${message}. I could not get a picture afterwards.`,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
        logger.info(`[VoiceChat:Desktop] ${message} failed: ${detail}`);
        return { success: false, message: `That did not work: ${detail}` };
      }
    });
  }

  /** One picture of the desktop into the session. Returns whether the model got it. */
  private async showDesktop(control: DesktopControl, note: string): Promise<boolean> {
    const jpeg = await control.capture();
    return this.channel?.showImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`, note) ?? false;
  }

  /** Release everything. Safe to call more than once. */
  async stop(): Promise<void> {
    this.channel = null;
    this.input?.stop();
    this.input = null;
    const screen = this.screen;
    this.screen = null;
    await screen?.stop();
    const browser = this.browser;
    const desktop = this.desktop;
    const display = this.display;
    this.browser = null;
    this.desktop = null;
    this.desktopControl = null;
    this.display = null;
    this.mainPage = null;
    this.audioHandles = null;
    await browser?.stop().catch(() => undefined);
    await desktop?.stop().catch(() => undefined);
    await display?.stop().catch(() => undefined);
  }

  private async onFrontQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.frontTail.then(fn);
    this.frontTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** The tab commands are answered here; the rest go to the page. Same shape as the meeting's. */
  private async runBrowseCommand(
    browser: BrowserStack,
    command: BrowserCommand,
  ): Promise<BrowserResult> {
    switch (command.action) {
      case 'new_tab': {
        if (command.url && !normalizeUrl(command.url)) {
          return { success: false, message: `"${command.url}" is not a web address I can open.` };
        }
        const page = await browser.openTab();
        if (command.url) return runBrowserCommand(page, { action: 'navigate', url: command.url });
        return { success: true, message: 'Opened a new tab.', ...(await read(page)) };
      }

      case 'switch_tab': {
        const page = command.tab === undefined ? null : await browser.selectTab(command.tab - 1);
        if (!page) {
          return { success: false, message: `There is no tab ${command.tab ?? 'of that number'}.` };
        }
        return { success: true, message: `Switched to tab ${command.tab}.`, ...(await read(page)) };
      }

      case 'close_tab': {
        const tabs = browser.listTabs();
        const index =
          command.tab === undefined ? tabs.indexOf(browser.front() as Page) : command.tab - 1;
        if (index < 0 || !(await browser.closeTab(index))) {
          return { success: false, message: 'There is no such tab to close.' };
        }
        const page = browser.front();
        if (!page || page === this.mainPage) {
          return { success: true, message: 'Closed the last tab. Nothing is open now.' };
        }
        return { success: true, message: 'Closed the tab.', ...(await read(page)) };
      }

      default:
        return runBrowserCommand(await browser.workbench(), command);
    }
  }
}
