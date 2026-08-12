/**
 * The Google Meet join state machine, against a fake Playwright page.
 *
 * Worth testing without a browser because the outcomes are what the user sees:
 * "a host denied it", "nobody admitted me", "that link isn't valid" all have to
 * come back as reportable outcomes rather than exceptions — and because Meet
 * reshapes this UI regularly, so the branch that decides *which* outcome applies
 * is the part most likely to rot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright-core';
import { GoogleMeetProvider } from '../index';
import { isAuthenticated, signInFailureReason } from '../sign-in';

// The provider reads its own sign-in state rather than being handed it, so the two
// situations that state distinguishes — "signed in and offered a guest field", and
// "the catch-all wall after a failed login" — are set here.
vi.mock('../sign-in', () => ({
  isAuthenticated: vi.fn(() => false),
  signInFailureReason: vi.fn(() => null),
  signInToGoogle: vi.fn(async () => {}),
}));

interface FakePageOptions {
  /** Text the page reports, used for rejection detection. */
  bodyText?: string;
  /** Button labels that are visible and enabled. */
  visibleButtons?: string[];
  /** CSS selectors that report visible (the in-call markers). */
  visibleSelectors?: string[];
  /** Attribute answers, keyed by `${selector}|${attribute}`. */
  attributes?: Record<string, string | null>;
  /** Fail the initial navigation. */
  gotoError?: string;
  /** Called after each `waitForTimeout`, to let a test change the page mid-flow. */
  onTick?: (tick: number) => void;
}

/**
 * A page stub covering only the surface the provider touches. Playwright's real
 * types are enormous, hence the cast at the end.
 */
function fakePage(options: FakePageOptions) {
  const state = {
    bodyText: options.bodyText ?? '',
    visibleButtons: new Set(options.visibleButtons ?? []),
    visibleSelectors: new Set(options.visibleSelectors ?? []),
    attributes: options.attributes ?? {},
  };
  const clicks: string[] = [];
  const fills: string[] = [];
  let ticks = 0;

  type FakeLocator = ReturnType<typeof locator>;
  /** `key` is a thunk so an `or` chain resolves it when used, not when composed. */
  const locator = (matches: () => boolean, key: () => string | undefined = () => undefined) => ({
    /** Exposed so `.or()` can compose, as Playwright's real locator does. */
    _matches: matches,
    _key: key,
    first: () => locator(matches, key),
    or: (other: FakeLocator) =>
      locator(
        () => matches() || other._matches(),
        // Attribution follows whichever side matches at the moment of use, so a
        // click through the chain is still credited to the right element.
        () => (matches() ? key() : other._key()),
      ),
    // Playwright's real `waitFor` polls until the element is visible and throws on
    // timeout. Resolving/throwing immediately here keeps the tests fast; the
    // provider's own retry loops still drive state changes via waitForTimeout.
    waitFor: async () => {
      if (!matches()) throw new Error('locator.waitFor: timeout exceeded');
    },
    // The bug this file exists to prevent: `isVisible()` answers "right now" and
    // never waits, so using it made the provider miss UI Meet had not rendered
    // yet. Fail loudly rather than silently passing if it comes back.
    isVisible: async () => {
      throw new Error('isVisible() must not be used — it does not wait. Use waitFor().');
    },
    isEnabled: async () => matches(),
    click: async () => {
      clicks.push(key() ?? 'unknown');
    },
    fill: async (value: string) => {
      fills.push(value);
    },
    innerText: async () => state.bodyText,
    getAttribute: async (attr: string) => state.attributes[`${key()}|${attr}`] ?? null,
  });

  const page = {
    goto: async () => {
      if (options.gotoError) throw new Error(options.gotoError);
    },
    getByRole: (_role: string, opts: { name: RegExp }) => {
      const match = () => [...state.visibleButtons].some((label) => opts.name.test(label));
      return locator(match, () => [...state.visibleButtons].find((l) => opts.name.test(l)) ?? String(opts.name));
    },
    locator: (selector: string) => {
      if (selector === 'body') return locator(() => true, () => 'body');
      return locator(() => state.visibleSelectors.has(selector), () => selector);
    },
    // Yields to a real timer rather than resolving in a microtask. The provider's
    // waits are all `while (Date.now() < deadline)` loops, so a stub that never
    // reaches the macrotask queue turns them into event-loop blocks for the whole
    // budget — which starved the socket-based suites elsewhere in the run and made
    // them fail intermittently.
    waitForTimeout: async () => {
      ticks += 1;
      options.onTick?.(ticks);
      await new Promise((r) => setTimeout(r, 1));
    },
    on: () => {},
  };

  return { page: page as unknown as Page, state, clicks, fills, ticks: () => ticks };
}

const provider = new GoogleMeetProvider();
const joinOptions = {
  url: 'https://meet.google.com/abc-defg-hij',
  displayName: 'Prism',
  admissionTimeoutMs: 2_000,
};

beforeEach(() => {
  vi.mocked(isAuthenticated).mockReturnValue(false);
  vi.mocked(signInFailureReason).mockReturnValue(null);
});

describe('join outcomes', () => {
  it('reports admitted once in-call furniture appears', async () => {
    const { page, fills, clicks } = fakePage({
      visibleButtons: ['Ask to join'],
      visibleSelectors: [
        'input[aria-label="Your name"]',
        'button[aria-label*="Leave call" i]',
      ],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(clicks).toContain('Ask to join');
    // Nothing is typed any more: Meet refuses automated anonymous guests, so a join
    // without an account is rejected before a browser is ever launched.
    expect(fills).toEqual([]);
  });

  it('waits out the waiting room and reports admission when it arrives', async () => {
    const harness = fakePage({
      visibleButtons: ['Ask to join'],
      // Admitted only on the third poll, as a real host would.
      onTick: (tick) => {
        if (tick >= 3) harness.state.visibleSelectors.add('button[aria-label*="People" i]');
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
  });

  it('reports a denial in the user\'s terms, not as an exception', async () => {
    const { page } = fakePage({
      visibleButtons: ['Ask to join'],
      bodyText: 'Your request to join was denied',
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome.status).toBe('denied');
    expect((outcome as { reason: string }).reason).toMatch(/host denied/i);
  });

  it("names every cause of Meet's catch-all wall rather than asserting one", async () => {
    // The same page text covers an ended meeting, a stale link and a tenant that
    // blocks guests. Blaming one sent us hunting the wrong problem once already.
    const { page } = fakePage({ bodyText: "You can't join this video call" });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome.status).toBe('denied');
    const { reason } = outcome as { reason: string };
    expect(reason).toMatch(/has ended/i);
    expect(reason).toMatch(/no longer valid/i);
    expect(reason).toMatch(/signed-in members/i);
  });

  it('recognizes an unrecognized meeting code', async () => {
    const { page } = fakePage({ bodyText: 'Check your meeting code' });

    const outcome = await provider.join(page, joinOptions);

    expect((outcome as { reason: string }).reason).toMatch(/did not recognize/i);
  });

  it('recognizes a meeting that already ended', async () => {
    const { page } = fakePage({ bodyText: 'The meeting has ended' });

    const outcome = await provider.join(page, joinOptions);

    expect((outcome as { reason: string }).reason).toMatch(/already ended/i);
  });

  it('gives up when nobody admits it', async () => {
    // No in-call marker ever appears and no rejection text is shown.
    const { page } = fakePage({ visibleButtons: ['Ask to join'] });

    const outcome = await provider.join(page, { ...joinOptions, admissionTimeoutMs: 200 });

    expect(outcome.status).toBe('denied');
    expect((outcome as { reason: string }).reason).toMatch(/nobody admitted/i);
  });

  it('fails clearly when the page will not load', async () => {
    const { page } = fakePage({ gotoError: 'net::ERR_NAME_NOT_RESOLVED' });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toMatch(/could not load/i);
  });

  it('loads the page again when another navigation lands on top of it', async () => {
    // Observed in production and reported to the user as a broken meeting link: a
    // sign-in that had just failed was still redirecting, and its navigation landed
    // on the meeting load. The link was fine.
    const { page } = fakePage({
      visibleButtons: ['Ask to join'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });
    const original = page.goto;
    const visited: string[] = [];
    page.goto = async (...args: Parameters<typeof original>) => {
      visited.push(String(args[0]));
      if (visited.length === 1) {
        throw new Error(
          'page.goto: Navigation to "https://meet.google.com/abc-defg-hij" is interrupted ' +
            'by another navigation to "https://accounts.google.com/v3/signin/identifier"',
        );
      }
      return original(...args);
    };

    const outcome = await provider.join(page, joinOptions);

    // Counted by destination: the retry parks the page in between, so the raw call
    // count includes an about:blank the assertion is not about.
    expect(visited.filter((url) => url.includes('meet.google.com'))).toHaveLength(2);
    // And it started the second attempt from a page that had stopped moving.
    expect(visited[1]).toBe('about:blank');
    expect(outcome.status).toBe('admitted');
  });

  it('does not retry a page load that failed for a real reason', async () => {
    // Only the interruption earns a second go. Retrying a dead link would double the
    // wait before the user is told anything.
    const { page } = fakePage({ gotoError: 'net::ERR_NAME_NOT_RESOLVED' });
    const original = page.goto;
    let attempts = 0;
    page.goto = async (...args: Parameters<typeof original>) => {
      attempts += 1;
      return original(...args);
    };

    await provider.join(page, joinOptions);

    // One try, and no parking navigation either — nothing was retried.
    expect(attempts).toBe(1);
  });

  it('fails with a UI-changed message when no join button is ever found', async () => {
    const { page } = fakePage({});

    const outcome = await provider.join(page, { ...joinOptions, admissionTimeoutMs: 200 });

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toMatch(/may have changed/i);
  });

  it('matches the join button by the accessible name Meet really uses', async () => {
    // Observed live: the guest button's accessible name is "Ask to join without
    // camera", not "Ask to join". An anchored match found nothing and the join
    // silently failed, which is the bug this test pins down.
    const { page, clicks } = fakePage({
      visibleButtons: ['Ask to join without camera'],
      visibleSelectors: [
        'input[aria-label="Your name"]',
        'button[aria-label*="Leave call" i]',
      ],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(clicks).toContain('Ask to join without camera');
  });

  it('keeps waiting while the join button is present but disabled', async () => {
    // Meet disables it until the name field has a value and device probing ends.
    const harness = fakePage({
      visibleSelectors: ['input[aria-label="Your name"]'],
      onTick: (tick) => {
        // Only becomes clickable on the third poll.
        if (tick >= 3) {
          harness.state.visibleButtons.add('Ask to join without camera');
          harness.state.visibleSelectors.add('button[aria-label*="Leave call" i]');
        }
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
  });

  it('reports a join button that never became available', async () => {
    // One reason now, not two: the name-field branch it used to distinguish is gone
    // along with guest joining, so selector rot on the button is the only way here.
    const { page } = fakePage({});

    const outcome = await provider.join(page, { ...joinOptions, admissionTimeoutMs: 200 });

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toMatch(/join button never became available/i);
  });

  it('accepts "Join now" when Meet treats it as a member', async () => {
    const { page, clicks } = fakePage({
      visibleButtons: ['Join now'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(clicks).toContain('Join now');
  });

  it('ignores a rejection message that does not survive the next read', async () => {
    // The bug this whole debounce exists for. Meet renders interstitials on the way
    // to the lobby, and reading the page once at `domcontentloaded` caught one — so
    // joining a live call failed intermittently and asking again walked straight in.
    const harness = fakePage({
      bodyText: "You can't join this video call",
      visibleButtons: ['Ask to join'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
      onTick: () => {
        harness.state.bodyText = '';
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
  });

  it('reports a rejection confirmed during the button hunt even if the text then clears', async () => {
    // The reason used to be discarded and confirmed a second time by the caller. If
    // the wall had repainted away in between — several seconds later — a genuine
    // denial was reported as "the join button never became available", blaming the
    // Meet UI for a refusal already read three times.
    const harness = fakePage({
      visibleSelectors: ['input[aria-label="Your name"]'],
      onTick: (tick) => {
        if (tick >= 1) harness.state.bodyText = "You can't join this video call";
        // Long enough to be confirmed inside the hunt, gone by the time a second
        // confirmation would have run.
        if (tick >= 4) harness.state.bodyText = '';
      },
    });

    const outcome = await provider.join(harness.page, { ...joinOptions, admissionTimeoutMs: 8_000 });

    expect(outcome.status).toBe('denied');
    expect((outcome as { reason: string }).reason).toMatch(/wouldn't let me in/i);
    expect((outcome as { step: string }).step).toBe('lobby');
  });

  it('prefers being in the call over stale rejection text on the page', async () => {
    // Once admitted, "This meeting has ended" can be anything on screen — a caption,
    // a chat line. Ejecting on it would drop the bot out of a live call.
    const { page } = fakePage({
      bodyText: 'This meeting has ended',
      visibleButtons: ['Join now'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
  });

  it('does not read "meeting ended" in unrelated text as a rejection', async () => {
    // The pattern used to make "has" optional, so this sentence denied the join.
    const { page } = fakePage({
      bodyText: 'Alice: sorry I am late, my last meeting ended late',
      visibleButtons: ['Ask to join'],
      visibleSelectors: [
        'input[aria-label="Your name"]',
        'button[aria-label*="Leave call" i]',
      ],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
  });

  it('does not mistake an unrelated named input for the guest name field', async () => {
    // The old selector matched any text input whose label merely contained "name".
    const { page, fills } = fakePage({
      visibleButtons: ['Join now'],
      visibleSelectors: [
        'input[type="text"][aria-label*="name" i]',
        'button[aria-label*="Leave call" i]',
      ],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(fills).toEqual([]);
  });

  it('classifies a lobby offering "Join anyway" as signed in', async () => {
    // The click loop always accepted this label; the classification race did not, so
    // such a lobby reported that it had found neither control.
    const { page, clicks, fills } = fakePage({
      visibleButtons: ['Join anyway'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(clicks).toContain('Join anyway');
    expect(fills).toEqual([]);
  });

  it('names a failed sign-in as the likely cause behind the catch-all wall', async () => {
    // Meet shows the same wall for an ended meeting and for refusing an automated
    // anonymous guest. When the runtime already knows sign-in failed, saying so beats
    // letting the user chase a link they can see is live.
    const { page } = fakePage({ bodyText: "You can't join this video call" });

    vi.mocked(signInFailureReason).mockReturnValue('Google is challenging this account');

    const outcome = await provider.join(page, joinOptions);

    expect(outcome.status).toBe('denied');
    const { reason } = outcome as { reason: string };
    expect(reason).toMatch(/couldn't sign in/i);
    expect(reason).toMatch(/challenging this account/i);
    expect(reason).toMatch(/anonymous guests/i);
  });

  it('leaves the denial alone when no sign-in failure is known', async () => {
    const { page } = fakePage({ bodyText: "You can't join this video call" });

    const outcome = await provider.join(page, joinOptions);

    expect((outcome as { reason: string }).reason).not.toMatch(/sign in/i);
  });

  it('gives the waiting room its own budget after a slow lobby', async () => {
    // The deadline used to be taken before `page.goto`, so page load and the button
    // hunt spent the admission budget — and in the tail the waiting room was entered
    // already expired and reported "nobody admitted" without waiting once.
    const harness = fakePage({
      visibleButtons: ['Ask to join'],
      onTick: (tick) => {
        if (tick >= 3) harness.state.visibleSelectors.add('button[aria-label*="Leave call" i]');
      },
    });
    // Deliberately shorter than the time the lobby phase takes to settle.
    harness.page.goto = (async () => {
      await new Promise((r) => setTimeout(r, 120));
    }) as never;

    const outcome = await provider.join(harness.page, { ...joinOptions, admissionTimeoutMs: 100 });

    expect(outcome).toEqual({ status: 'admitted' });
  });

  it('joins a meeting with no name field', async () => {
    // Some meetings don't ask a guest for a name; that is not a failure.
    const { page, fills } = fakePage({
      visibleButtons: ['Ask to join'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(fills).toEqual([]);
  });
});

/**
 * `participantCount` is exercised in `provider.test.ts`, against a real
 * DOM built from the markup Meet actually serves. It reads the page in one
 * `page.evaluate` rather than through locators, so the selector-shaped fake below
 * cannot express what it does — and a fake that only proves "an absent selector
 * reads as null" was exactly what let a live call return null for a whole meeting
 * with every test still green.
 */

describe('leave', () => {
  it('clicks the leave button when present', async () => {
    const { page, clicks } = fakePage({ visibleButtons: ['Leave call'] });

    await provider.leave(page);

    expect(clicks).toContain('Leave call');
  });

  it('does not throw when there is no leave button', async () => {
    // The browser is closed straight after, which drops the session anyway.
    const { page } = fakePage({});

    await expect(provider.leave(page)).resolves.toBeUndefined();
  });

  it('does not throw when the click fails', async () => {
    const { page } = fakePage({ visibleButtons: ['Leave call'] });
    vi.spyOn(page, 'getByRole').mockImplementation(
      () =>
        ({
          first: () => ({
            isVisible: async () => true,
            click: async () => {
              throw new Error('detached');
            },
          }),
        }) as never,
    );

    await expect(provider.leave(page)).resolves.toBeUndefined();
  });
});

/**
 * A signed-in profile that Meet treats as a guest.
 *
 * Not a rare edge: on a live deployment this happened on *every* join, because the
 * browser is torn down between calls and the session does not survive it. Before
 * this outcome existed the flow filled in a guest name and asked to join, which
 * Meet auto-denies for automated anonymous guests — so a recoverable stale cookie
 * cost a page load, a lobby wait and a refusal, and only recovered if the agent
 * happened to call the tool again.
 */
describe('a stale signed-in session', () => {
  it('reports it instead of joining as a guest', async () => {
    const { page, clicks, fills } = fakePage({
      // The signature: a guest name field on a browser we believe is authenticated.
      visibleSelectors: ['input[aria-label="Your name"]'],
      visibleButtons: ['Ask to join'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'reauth_required' });
    // Nothing was typed and nothing was clicked: going further is a guaranteed
    // refusal, and the caller can fix this by signing in again.
    expect(fills).toEqual([]);
    expect(clicks).toEqual([]);
  });

  it('leaves the name field alone when not signed in', async () => {
    // There is no guest path any more: `MeetingBotService` refuses a Meet join with
    // no Google account before any of this runs, because Meet denies automated
    // anonymous guests before a host is prompted. Typing a name only ever bought a
    // clearer refusal, at the cost of a browser and a lobby wait.
    const { page, fills } = fakePage({
      visibleSelectors: [
        'input[aria-label="Your name"]',
        'button[aria-label*="Leave call" i]',
      ],
      visibleButtons: ['Ask to join'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(false);

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
    expect(fills).toEqual([]);
  });

  it('does not report it for a signed-in lobby with no name field', async () => {
    const { page } = fakePage({
      visibleButtons: ['Join now'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted' });
  });
});
