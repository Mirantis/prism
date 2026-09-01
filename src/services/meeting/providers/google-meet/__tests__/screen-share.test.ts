/**
 * Starting a presentation, against a fake Playwright page.
 *
 * Every step of this flow is a click on a control Meet renders differently between
 * builds, so what is worth pinning is not the selectors — no test without a browser
 * can prove those — but the shape around them: that the source menu and the self-view
 * warning are optional, that the answer comes from Meet offering to stop the share
 * rather than from a click having landed, and that a share already running is left
 * alone. The last one matters most: a second click on a control bar that is already
 * presenting is how a share tool stops a share.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { GoogleMeetProvider } from '../index';

interface FakePageOptions {
  /** Accessible names of the controls currently on the page. */
  buttons?: string[];
  /** Called after each click, so a test can move the page on the way Meet does. */
  onClick?: (label: string, buttons: Set<string>) => void;
  /**
   * Milliseconds to move a faked clock on by per page wait.
   *
   * For the case that has to reach a deadline: the confirmation loop is written
   * against `Date.now()`, so without this the test sits through the real budget.
   */
  clockStep?: number;
}

function fakePage(options: FakePageOptions) {
  const buttons = new Set(options.buttons ?? []);
  const clicks: string[] = [];

  type FakeLocator = ReturnType<typeof locator>;
  /** `key` is a thunk so an `or` chain resolves it when used, not when composed. */
  const locator = (matches: () => boolean, key: () => string | undefined = () => undefined) => ({
    _matches: matches,
    _key: key,
    first: () => locator(matches, key),
    or: (other: FakeLocator) =>
      locator(
        () => matches() || other._matches(),
        () => (matches() ? key() : other._key()),
      ),
    waitFor: async () => {
      if (!matches()) throw new Error('locator.waitFor: timeout exceeded');
    },
    click: async () => {
      const label = key() ?? 'unknown';
      clicks.push(label);
      options.onClick?.(label, buttons);
    },
  });

  const page = {
    // Both roles answer from one list: the provider searches button and menu item
    // together precisely because it cannot tell which one Meet used today.
    getByRole: (_role: string, opts: { name: RegExp }) =>
      locator(
        () => [...buttons].some((label) => opts.name.test(label)),
        () => [...buttons].find((label) => opts.name.test(label)),
      ),
    // No dialog in any of these cases; the sweep is exercised by the join tests.
    locator: () => locator(() => false),
    waitForTimeout: async () => {
      if (options.clockStep) vi.advanceTimersByTime(options.clockStep);
      await new Promise((r) => setTimeout(r, 1));
    },
  };

  return { page: page as unknown as Page, buttons, clicks };
}

const provider = new GoogleMeetProvider();

afterEach(() => {
  vi.useRealTimers();
});

describe('GoogleMeetProvider.startScreenShare', () => {
  it('shares through the source menu and confirms off the stop control', async () => {
    const { page, clicks } = fakePage({
      buttons: ['Share screen'],
      onClick: (label, buttons) => {
        if (label === 'Share screen') buttons.add('Your entire screen');
        if (label === 'Your entire screen') {
          buttons.delete('Your entire screen');
          buttons.add('Stop sharing');
        }
      },
    });

    expect(await provider.startScreenShare(page)).toEqual({ status: 'sharing' });
    expect(clicks).toEqual(['Share screen', 'Your entire screen']);
  });

  it('shares on a build that offers no source menu', async () => {
    const { page, clicks } = fakePage({
      buttons: ['Present now'],
      onClick: (label, buttons) => {
        if (label === 'Present now') buttons.add('Stop presenting');
      },
    });

    expect(await provider.startScreenShare(page)).toEqual({ status: 'sharing' });
    expect(clicks).toEqual(['Present now']);
  });

  it('answers the self-view warning, which is what keeps the presentation up', async () => {
    // The display holds the meeting window, so Meet always asks. Left unanswered the
    // warning covers the presentation, and the room sees nothing.
    const { page, clicks } = fakePage({
      buttons: ['Share screen'],
      onClick: (label, buttons) => {
        if (label === 'Share screen') buttons.add('Show my screen anyway');
        if (label === 'Show my screen anyway') {
          buttons.delete('Show my screen anyway');
          buttons.add('Stop sharing');
        }
      },
    });

    expect(await provider.startScreenShare(page)).toEqual({ status: 'sharing' });
    expect(clicks).toContain('Show my screen anyway');
  });

  it('leaves a running share alone', async () => {
    const { page, clicks } = fakePage({ buttons: ['Stop sharing', 'Share screen'] });

    expect(await provider.startScreenShare(page)).toEqual({ status: 'already_sharing' });
    expect(clicks).toEqual([]);
  });

  it('reports a control it cannot find, without clicking anything', async () => {
    const { page, clicks } = fakePage({ buttons: ['Leave call'] });

    const outcome = await provider.startScreenShare(page);
    expect(outcome.status).toBe('failed');
    expect(clicks).toEqual([]);
  });

  it('stops a running share, and knows when it is gone', async () => {
    const { page, clicks } = fakePage({
      buttons: ['Stop sharing'],
      onClick: (label, buttons) => {
        if (label === 'Stop sharing') buttons.delete('Stop sharing');
      },
    });

    expect(await provider.stopScreenShare(page)).toEqual({ status: 'stopped' });
    expect(clicks).toEqual(['Stop sharing']);
  });

  it('answers a stop with nothing to stop', async () => {
    // Somebody may have stopped it from the room's own controls. That is a fact about
    // the call, not a failure of the ask.
    const { page, clicks } = fakePage({ buttons: ['Share screen'] });

    expect(await provider.stopScreenShare(page)).toEqual({ status: 'not_sharing' });
    expect(clicks).toEqual([]);
  });

  it('reports a stop that did not take', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The control stays put: the click landed on something that is not listening.
    const { page } = fakePage({ buttons: ['Stop sharing'], clockStep: 1_000 });

    const outcome = await provider.stopScreenShare(page);

    expect(outcome.status).toBe('failed');
  });

  it('reports a share that never started', async () => {
    // The click landed and nothing came of it — a capture Chromium refused, or a
    // renegotiation that failed. Saying so is better than an agent telling a room to
    // look at a screen nobody is being shown.
    //
    // Only `Date` is faked, so the page's own waits still run on real timers; the
    // fake page moves the clock on with each of them until the deadline passes.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { page } = fakePage({ buttons: ['Share screen'], clockStep: 1_000 });

    const outcome = await provider.startScreenShare(page);
    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('reason');
  });
});
