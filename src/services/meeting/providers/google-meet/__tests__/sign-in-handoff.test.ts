/**
 * The seam between a failed sign-in and the meeting page load.
 *
 * `join.test.ts` mocks the sign-in module wholesale, and `sign-in.test.ts` never drives
 * the provider, so neither crosses this seam — and the seam is where the production
 * failure was. A join told the user their meeting link was interrupted by a Google
 * sign-in URL, seconds after a sign-in that had failed for reasons of its own.
 *
 * The fake page encodes one Playwright rule and one observed symptom. The rule: a
 * commit on the main frame interrupts every navigation still in flight, which is what
 * `Navigation to "X" is interrupted by another navigation to "Y"` reports. The symptom,
 * read off that message in production: the parking navigation's commit landed after its
 * own `goto` had already resolved, so the page had been handed on by then.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Frame } from 'playwright-core';
import { GoogleMeetProvider } from '../index';
import { signInFailureReason, signInToGoogle } from '../sign-in';
import { logger } from '../../../../../logger';

// Credentials so the sign-in runs at all; `vi.hoisted` because the factory below is
// lifted above this file's own declarations.
const config = vi.hoisted(() => ({
  googleBotEmail: 'bot@example.com' as string | undefined,
  googleBotPassword: 'hunter2' as string | undefined,
}));
vi.mock('../../../../../config', () => ({ config }));

const MEETING_URL = 'https://meet.google.com/abc-defg-hij';

/** How a navigation to one address behaves. */
type Route = {
  /** When the `goto` promise settles. */
  settlesAfterMs: number;
  /** The network error it settles with, if it fails. */
  fails?: string;
  /** When the main frame commits it — later than the settle, for a late bounce. */
  commitsAfterMs?: number;
};

/** Everything the provider looks for on the page, answered quickly and in the negative. */
function absent() {
  const self = {
    waitFor: async () => {
      throw new Error('locator.waitFor: Timeout exceeded');
    },
    isVisible: async () => false,
    isEnabled: async () => false,
    getAttribute: async () => null,
    innerText: async () => '',
    textContent: async () => '',
    count: async () => 0,
    click: async () => {},
    fill: async () => {},
    type: async () => {},
    press: async () => {},
    all: async () => [],
    first: () => self,
    last: () => self,
    nth: () => self,
    or: () => self,
    filter: () => self,
    locator: () => self,
    getByRole: () => self,
  };
  return self;
}

/**
 * A page that navigates the way a browser does, and records what happened.
 *
 * `loads` is every address asked for, `interrupted` every navigation another commit
 * landed on top of. Both are readings the test asserts rather than infers.
 */
function browserPage(route: (url: string) => Route) {
  const mainFrame = {} as Frame;
  const watchers = new Set<(frame: Frame) => void>();
  const nothing = absent();
  const loads: string[] = [];
  const interrupted: string[] = [];
  let committed = 'about:blank';
  const inFlight = new Set<{ url: string; interrupt: (by: string) => void }>();

  const commit = (url: string): void => {
    committed = url;
    // Every navigation still in flight, not just the newest: that is Playwright's rule,
    // and a set rather than one slot is what keeps a second `goto` from stranding the
    // promise of the first.
    for (const entry of inFlight) {
      if (entry.url === url) continue;
      inFlight.delete(entry);
      entry.interrupt(url);
    }
    for (const watcher of watchers) watcher(mainFrame);
  };

  return {
    goto: (url: string): Promise<null> => {
      loads.push(url);
      const plan = route(url);
      return new Promise((resolve, reject) => {
        const entry = {
          url,
          interrupt: (by: string): void => {
            interrupted.push(url);
            reject(
              new Error(
                `page.goto: Navigation to "${url}" is interrupted by another navigation to "${by}"`,
              ),
            );
          },
        };
        inFlight.add(entry);
        if (plan.commitsAfterMs !== undefined) {
          setTimeout(() => commit(url), plan.commitsAfterMs);
        }
        setTimeout(() => {
          // Nothing to settle if a commit already interrupted this one.
          if (!inFlight.delete(entry)) return;
          if (plan.fails) reject(new Error(plan.fails));
          else resolve(null);
        }, plan.settlesAfterMs);
      });
    },
    url: () => committed,
    waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    mainFrame: () => mainFrame,
    on: (event: string, watcher: (frame: Frame) => void) => {
      if (event === 'framenavigated') watchers.add(watcher);
    },
    off: (_event: string, watcher: (frame: Frame) => void) => {
      watchers.delete(watcher);
    },
    locator: () => nothing,
    getByRole: () => nothing,
    evaluate: async () => null,
    screenshot: async () => {},
    loads,
    interrupted,
  };
}

describe('sign-in to meeting-page handoff', () => {
  beforeEach(() => {
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    // Quiet, not asserted: `restoreMocks` in vitest.config.ts puts them back.
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });

  it('loads the meeting page after a failed sign-in, and loads it once', async () => {
    // The ticket's run, at the two speeds that produce it. Google is unreachable, so
    // every sign-in navigation fails and each parking of the page commits 200 ms after
    // its own `goto` has returned; the meeting page then takes 400 ms to load. The
    // parking commit used to land in the middle of that, and the user was told their
    // meeting link had been interrupted by a Google URL.
    const page = browserPage((url) => {
      if (url === 'about:blank') return { settlesAfterMs: 10, commitsAfterMs: 200 };
      if (url === MEETING_URL) return { settlesAfterMs: 400, commitsAfterMs: 400 };
      return { settlesAfterMs: 30, fails: 'net::ERR_TUNNEL_CONNECTION_FAILED' };
    });

    await signInToGoogle(page as never);
    const outcome = await new GoogleMeetProvider().join(page as never, {
      url: MEETING_URL,
      admissionTimeoutMs: 300,
      onRequestSubmitted: () => {},
    });

    // The sign-in failed, which is the precondition and not the subject.
    expect(signInFailureReason()).toContain('net::ERR_TUNNEL_CONNECTION_FAILED');
    // Nothing landed on top of the meeting page, so it loaded once and stuck.
    expect(page.interrupted).toEqual([]);
    expect(page.loads.filter((url) => url === MEETING_URL)).toEqual([MEETING_URL]);
    expect(page.url()).toBe(MEETING_URL);
    // The join then fails at the Meet furniture this bare page never paints, which is
    // two steps past the one under test — and is not `page_load`.
    expect(outcome).toMatchObject({ status: 'failed', step: 'join_button' });
  });
});
