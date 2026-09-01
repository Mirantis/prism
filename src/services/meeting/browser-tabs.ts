/**
 * The tabs the agent works in.
 *
 * One of them is active, and the active one is brought to the front — a screen share
 * captures the display, so the tab in front is the tab the room sees.
 *
 * The meeting's own tab is never in here. That page is the call, and a navigation on it
 * would leave the meeting.
 *
 * Separate from `browser-stack.ts` because only that file needs a browser: everything
 * here is bookkeeping over pages, and it is tested without one.
 */

import type { Page } from 'playwright-core';

export class TabSet {
  private pages: Page[] = [];
  private active: Page | null = null;

  /**
   * Track a tab and make it active.
   *
   * A tab the site opened for itself arrives here too, from the context's `page` event.
   * The browser puts such a tab in front, and the agent that clicked the link expects
   * to be looking at it.
   */
  add(page: Page): void {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    this.active = page;
  }

  /** The open tabs, oldest first. */
  list(): Page[] {
    this.prune();
    return [...this.pages];
  }

  /** The tab commands act on, or null when none is open. */
  current(): Page | null {
    this.prune();
    return this.active;
  }

  /** Make tab `index` active and bring it to the front. */
  async select(index: number): Promise<Page | null> {
    this.prune();
    const page = this.pages[index];
    if (!page) return null;

    this.active = page;
    await page.bringToFront();
    return page;
  }

  /** Bring the active tab to the front, for a command that is about to use it. */
  async raise(): Promise<Page | null> {
    const page = this.current();
    if (page) await page.bringToFront();
    return page;
  }

  /**
   * Close tab `index`.
   *
   * Closing a tab the agent is not in leaves the active one alone. The active tab is on
   * the screen the room is watching, and tidying up a background tab must not move it.
   * Closing the active tab falls back to the tab before it.
   */
  async close(index: number): Promise<boolean> {
    this.prune();
    const page = this.pages[index];
    if (!page) return false;

    const wasActive = page === this.active;
    await page.close().catch(() => {});
    this.pages.splice(index, 1);
    if (!wasActive) return true;

    this.active = this.pages[Math.max(0, index - 1)] ?? null;
    if (this.active) await this.active.bringToFront();
    return true;
  }

  /** Forget every tab. The browser they belonged to is gone. */
  clear(): void {
    this.pages = [];
    this.active = null;
  }

  /** Drop tabs that the site or the agent closed. */
  private prune(): void {
    this.pages = this.pages.filter((page) => !page.isClosed());
    if (!this.active || this.active.isClosed()) {
      this.active = this.pages[this.pages.length - 1] ?? null;
    }
  }
}
