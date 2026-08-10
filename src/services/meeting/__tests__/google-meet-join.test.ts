/**
 * The Google Meet join state machine, against a fake Playwright page.
 *
 * Worth testing without a browser because the outcomes are what the user sees:
 * "a host denied it", "nobody admitted me", "that link isn't valid" all have to
 * come back as reportable outcomes rather than exceptions — and because Meet
 * reshapes this UI regularly, so the branch that decides *which* outcome applies
 * is the part most likely to rot.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { GoogleMeetProvider } from '../providers/google-meet.provider';

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
    waitForTimeout: async () => {
      ticks += 1;
      options.onTick?.(ticks);
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
    expect(fills).toContain('Prism');
    expect(clicks).toContain('Ask to join');
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

  it('says the name field was the problem when it could not be filled', async () => {
    // Distinguishes "Meet changed its name field" from "the button never enabled",
    // because they need different fixes.
    const { page } = fakePage({});

    const outcome = await provider.join(page, { ...joinOptions, admissionTimeoutMs: 200 });

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toMatch(/could not enter a name/i);
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

describe('participantCount', () => {
  it('reads the explicit participant-count attribute', async () => {
    const { page } = fakePage({
      visibleSelectors: ['[data-participant-count]'],
      attributes: { '[data-participant-count]|data-participant-count': '4' },
    });

    expect(await provider.participantCount(page)).toBe(4);
  });

  it('falls back to the count in the People button label', async () => {
    const { page } = fakePage({
      visibleSelectors: ['button[aria-label*="People" i]'],
      attributes: { 'button[aria-label*="People" i]|aria-label': 'People (3)' },
    });

    expect(await provider.participantCount(page)).toBe(3);
  });

  it('returns null when the count cannot be read', async () => {
    // Null means "don't know" — the service treats that as a reason to stay, so a
    // selector change can't eject the bot from a live meeting.
    const { page } = fakePage({});

    expect(await provider.participantCount(page)).toBeNull();
  });

  it('returns null rather than NaN for a non-numeric attribute', async () => {
    const { page } = fakePage({
      visibleSelectors: ['[data-participant-count]'],
      attributes: { '[data-participant-count]|data-participant-count': 'lots' },
    });

    expect(await provider.participantCount(page)).toBeNull();
  });
});

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
