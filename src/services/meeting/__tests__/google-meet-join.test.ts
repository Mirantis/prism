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

  const locator = (matches: () => boolean, attributeKey?: string) => ({
    first: () => locator(matches, attributeKey),
    isVisible: async () => matches(),
    isEnabled: async () => matches(),
    click: async () => {
      clicks.push(attributeKey ?? 'unknown');
    },
    fill: async (value: string) => {
      fills.push(value);
    },
    innerText: async () => state.bodyText,
    getAttribute: async (attr: string) => state.attributes[`${attributeKey}|${attr}`] ?? null,
  });

  const page = {
    goto: async () => {
      if (options.gotoError) throw new Error(options.gotoError);
    },
    getByRole: (_role: string, opts: { name: RegExp }) => {
      const match = () => [...state.visibleButtons].some((label) => opts.name.test(label));
      const label = [...state.visibleButtons].find((l) => opts.name.test(l)) ?? String(opts.name);
      return locator(match, label);
    },
    locator: (selector: string) => {
      if (selector === 'body') return locator(() => true, 'body');
      return locator(() => state.visibleSelectors.has(selector), selector);
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

  it('explains a restricted meeting rather than retrying forever', async () => {
    const { page } = fakePage({ bodyText: "You can't join this video call" });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome.status).toBe('denied');
    expect((outcome as { reason: string }).reason).toMatch(/restricted to signed-in members/i);
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
