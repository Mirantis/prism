/**
 * Using a browser tab from a tool call: go somewhere, click something, type.
 *
 * Every command answers with a reading of the page: the address, the title, the text,
 * and the names of the controls. The next command is written against those names.
 */

import type { Locator, Page } from 'playwright-core';
import { logger } from '../../logger';
import { withTimeout } from '../../utils/with-timeout';

/** What the model asked for. */
export interface BrowserCommand {
  action:
    | 'navigate'
    | 'click'
    | 'type'
    | 'press'
    | 'scroll'
    | 'read'
    | 'new_tab'
    | 'switch_tab'
    | 'close_tab';
  /** Where to go, for `navigate` and for a `new_tab` that should land somewhere. */
  url?: string;
  /** Which tab, as numbered in the last reading. For `switch_tab` and `close_tab`. */
  tab?: number;
  /** What to act on: the words on it, or a CSS selector. */
  target?: string;
  /** What to type, for `type`. */
  text?: string;
  /** A key name, for `press` — `Enter`, `Escape`, `PageDown`. */
  key?: string;
  /** How far to scroll, in pixels; negative goes up. */
  amount?: number;
}

/** Where the page ended up, in the terms the next command will be written in. */
export interface BrowserReading {
  url: string;
  title: string;
  /** The page's rendered text, cut to `TEXT_LIMIT`. */
  text: string;
  /** Names of links, buttons and fields, in page order. */
  controls: string[];
}

export interface BrowserResult extends Partial<BrowserReading> {
  success: boolean;
  /** What happened, or why nothing did. */
  message: string;
  /** Every open tab, numbered as the next command must refer to them. */
  tabs?: TabSummary[];
}

/** One line of the tab list the model works from. */
export interface TabSummary {
  /** What to pass as `tab`. Numbered from 1, because the agent says these out loud. */
  number: number;
  title: string;
  url: string;
  /** Whether this is the tab the commands act on, and the one the room sees. */
  active: boolean;
}

/** Cap on a page load. A page slower than this is one nobody wants shown. */
const NAVIGATE_TIMEOUT_MS = 30_000;

/** Cap on a click, a fill or a keystroke, including waiting for the element. */
const ACTION_TIMEOUT_MS = 10_000;

/** Cap on reading the page back afterwards. */
const READ_TIMEOUT_MS = 5_000;

/**
 * How much page text comes back.
 *
 * A meeting caps a tool result at 12,000 characters. This limit is smaller because the
 * model has to say the answer out loud, so it measures what is worth speaking.
 */
const TEXT_LIMIT = 2_000;

/** How many control names come back, and how long each may be. */
const CONTROL_LIMIT = 40;
const CONTROL_NAME_LIMIT = 60;

/**
 * The slice of the DOM the control probe touches.
 *
 * Structural rather than the real `Document`: this runtime compiles against Node's
 * libs, and pulling in `dom` for one type would put the whole browser surface in scope
 * for every server module. Same reason as `providers/google-meet/index.ts`.
 */
interface ControlElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

interface ControlDocument {
  querySelectorAll(selectors: string): ArrayLike<ControlElement>;
}

/** Only an http(s) page can be shown to a room; `file:` and `chrome:` cannot. */
export function normalizeUrl(raw: string): string | null {
  const candidate = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a target reads as a CSS selector rather than as the words on a control.
 *
 * The test is narrow. A model that writes `#search` or `input[name="q"]` means a
 * selector. Everything else is treated as text, because the reading gives it text.
 */
export function looksLikeSelector(target: string): boolean {
  return /^[#.[]/.test(target) || /^[a-z][a-z0-9]*[#.[>]/i.test(target);
}

/**
 * Find the control the target names.
 *
 * Roles come first, then labels and placeholders, then any text. "Sign in" more often
 * means the button than a heading with the same words, and a control whose text is an
 * icon is found by its accessible name only.
 */
async function locate(page: Page, target: string): Promise<Locator> {
  if (looksLikeSelector(target)) return page.locator(target).first();

  // Exact first. Playwright matches a name as a substring by default, so "Sign in" also
  // matches "Sign in with Google", and `.or()` resolves in document order rather than by
  // how well each side matched. The model writes the name it was given, so an exact hit
  // is the one it meant. The substring pass still covers a name the 60-character reading
  // limit cut short.
  const exact = byName(page, target, true);
  if ((await exact.count()) > 0) return exact.first();

  return byName(page, target, false).first();
}

/**
 * One locator that matches a button, a link, a text box, a label, a placeholder or plain
 * text with this name. `exact` chooses between a whole-name match and a substring match.
 */
function byName(page: Page, target: string, exact: boolean): Locator {
  return page
    .getByRole('button', { name: target, exact })
    .or(page.getByRole('link', { name: target, exact }))
    .or(page.getByRole('textbox', { name: target, exact }))
    .or(page.getByLabel(target, { exact }))
    .or(page.getByPlaceholder(target, { exact }))
    .or(page.getByText(target, { exact }));
}

/** Read the page back: where it is, what it says, what can be clicked. */
export async function read(page: Page): Promise<BrowserReading> {
  const [title, text, controls] = await Promise.all([
    withTimeout(page.title(), READ_TIMEOUT_MS).catch(() => ''),
    withTimeout(page.locator('body').innerText({ timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS).catch(
      () => '',
    ),
    withTimeout(
      page.evaluate(
        ({ limit, nameLimit }: { limit: number; nameLimit: number }) => {
          const doc = (globalThis as unknown as { document: ControlDocument }).document;
          const names: string[] = [];
          const seen = new Set<string>();

          for (const el of Array.from(
            doc.querySelectorAll('a, button, [role="button"], [role="link"], input, textarea, select'),
          )) {
            const name = (
              el.getAttribute('aria-label') ??
              el.getAttribute('placeholder') ??
              el.textContent ??
              el.getAttribute('value') ??
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, nameLimit);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
            if (names.length >= limit) break;
          }
          return names;
        },
        { limit: CONTROL_LIMIT, nameLimit: CONTROL_NAME_LIMIT },
      ),
      READ_TIMEOUT_MS,
    ).catch(() => [] as string[]),
  ]);

  return {
    url: page.url(),
    title,
    text: text.replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_LIMIT),
    controls,
  };
}

/**
 * JPEG, and not at full quality. The picture stays in the live session's context for
 * the rest of the call, and a lossless screenshot of a web page adds nothing the model
 * can use.
 */
const SCREENSHOT_QUALITY = 75;
const SCREENSHOT_TIMEOUT_MS = 10_000;

/**
 * List the open tabs for the model.
 *
 * Numbered from 1, since the agent says these numbers out loud. A title that does not
 * arrive in time is left empty: the address alone still tells the model which tab it is.
 */
export async function summarizeTabs(pages: Page[], active: Page | null): Promise<TabSummary[]> {
  return Promise.all(
    pages.map(async (page, index) => ({
      number: index + 1,
      title: await withTimeout(page.title(), READ_TIMEOUT_MS).catch(() => ''),
      url: page.url(),
      active: page === active,
    })),
  );
}

/** A picture of the page, as a data URL, with the same reading attached. */
export async function capture(page: Page): Promise<{ imageUrl: string; reading: BrowserReading }> {
  const [shot, reading] = await Promise.all([
    withTimeout(
      page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY, timeout: SCREENSHOT_TIMEOUT_MS }),
      SCREENSHOT_TIMEOUT_MS,
    ),
    read(page),
  ]);

  return { imageUrl: `data:image/jpeg;base64,${shot.toString('base64')}`, reading };
}

/**
 * Run one command against a page.
 *
 * A command that fails answers `success: false` and still carries the reading. Without
 * it the model cannot tell a click that missed from a click that went somewhere
 * unexpected.
 */
export async function runBrowserCommand(page: Page, command: BrowserCommand): Promise<BrowserResult> {
  const done = async (message: string, success = true): Promise<BrowserResult> => ({
    success,
    message,
    ...(await read(page)),
  });

  try {
    switch (command.action) {
      case 'navigate': {
        if (!command.url) return { success: false, message: 'Say which URL to open.' };
        const url = normalizeUrl(command.url);
        if (!url) {
          return { success: false, message: `"${command.url}" is not a web address I can open.` };
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
        return done(`Opened ${url}`);
      }

      case 'click': {
        if (!command.target) return { success: false, message: 'Say what to click.' };
        await (await locate(page, command.target)).click({ timeout: ACTION_TIMEOUT_MS });
        return done(`Clicked "${command.target}"`);
      }

      case 'type': {
        if (command.text === undefined) return { success: false, message: 'Say what to type.' };
        if (command.target) {
          await (await locate(page, command.target)).fill(command.text, {
            timeout: ACTION_TIMEOUT_MS,
          });
        } else {
          // No target: type wherever the page put the cursor, which is what a person
          // does after clicking a field.
          await page.keyboard.type(command.text, { delay: 20 });
        }
        return done(command.target ? `Typed into "${command.target}"` : 'Typed');
      }

      case 'press': {
        if (!command.key) return { success: false, message: 'Say which key to press.' };
        await page.keyboard.press(command.key);
        // A key can start a navigation (Enter in a search box), and the reading has to
        // be of where that lands rather than of the page being left.
        await page.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
        return done(`Pressed ${command.key}`);
      }

      case 'scroll': {
        const amount = command.amount ?? 600;
        await page.mouse.wheel(0, amount);
        return done(amount >= 0 ? 'Scrolled down' : 'Scrolled up');
      }

      case 'read':
        return done('Read the page');

      case 'new_tab':
      case 'switch_tab':
      case 'close_tab':
        // The set of tabs belongs to the browser, not to one page. `browse` in
        // `meeting-bot.service.ts` answers these.
        return { success: false, message: `${command.action} is not a page command.` };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    logger.info(`[Meeting:Browser] ${command.action} failed: ${detail}`);
    return {
      success: false,
      message: `That ${command.action} did not work: ${detail}`,
      ...(await read(page).catch(() => ({}))),
    };
  }
}
