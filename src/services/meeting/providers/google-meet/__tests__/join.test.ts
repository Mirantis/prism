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
// The two audio selectors are imported rather than restated so the stub and the
// provider cannot drift apart. Unit tests can't prove a selector matches real Meet
// markup — nothing without a browser can — so pinning a copy here would only buy a
// test that passes against a string production stopped using.
import {
  BLOCKING_DIALOG_SELECTOR,
  CHAT_COMPOSER_SELECTOR,
  CHAT_SEND_SELECTOR,
  CHAT_TOGGLE_SELECTOR,
  GoogleMeetProvider,
  MIC_TOGGLE_SELECTOR,
} from '../index';
import { isAuthenticated, quiesce, sessionEvidence, signInFailureReason } from '../sign-in';
import { logger } from '../../../../../logger';

// The provider reads its own sign-in state rather than being handed it, so the three
// situations that state distinguishes — "an account is configured", "Google refused
// the session", and "the catch-all wall after a failed login" — are set here.
// `quiesce` is a spy that parks nothing: what the provider owes is calling it before
// the retry, and what it does with the page is proven in `sign-in.test.ts`.
vi.mock('../sign-in', () => ({
  isAuthenticated: vi.fn(() => false),
  quiesce: vi.fn(async () => {}),
  sessionEvidence: vi.fn(() => null),
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
  /**
   * Called before each read of the page's text, with the running count.
   *
   * Lets a test paint something *late* — a chat history that arrives a read after the
   * composer, which no arrangement of the static state can express.
   */
  onBodyRead?: (reads: number, state: FakeState) => void;
  /** Called after each `waitForTimeout`, to let a test change the page mid-flow. */
  onTick?: (tick: number) => void;
  /**
   * State of the microphone toggle.
   *
   * `on` — live, `off` — muted (what Meet does to a new joiner once a call is past
   * a handful of people), `absent` — no toggle in the DOM at all, i.e. the
   * selector has rotted.
   *
   * Defaults to `on` so the join-state-machine cases, which are about admission
   * and rejection rather than audio, stay about that. The microphone cases below
   * opt in explicitly, so the default cannot hide a regression in them.
   */
  mic?: 'on' | 'off' | 'absent';
  /** Whether a modal dialog is on screen, scrim and all. */
  dialog?: boolean;
  /**
   * Called with the clicked element's key, after the click is recorded.
   *
   * Two jobs: let a test move the page on in response to a click (dismiss the
   * dialog, flip the mic live), and let it *throw* — which is how Playwright
   * reports a click the dialog's scrim swallowed.
   */
  onClick?: (key: string, state: FakeState) => void;
  /**
   * Called before each read of the microphone toggle, with the running count.
   *
   * Lets a test make one particular read unreadable — the case where the toggle
   * momentarily vanishes right after the click that unmuted it, which no arrangement
   * of the static state can express.
   */
  onMicRead?: (reads: number, state: FakeState) => void;
  /**
   * State of the call's chat panel.
   *
   * `closed` — a chat control on the page, panel shut, which is how a call starts.
   * `open` — the panel already showing, which is how Meet leaves it after one send.
   * `absent` — no chat control at all, i.e. the selector has rotted.
   */
  chat?: 'closed' | 'open' | 'absent';
  /**
   * Whether the chat toggle publishes `aria-expanded`, which is where the provider reads
   * the panel's state. `missing` is the toggle refusing to say, i.e. a rotted attribute.
   */
  chatExpanded?: 'reported' | 'missing';
  /**
   * What the open panel paints.
   *
   * `contenteditable` is a composer whose value cannot be read with `inputValue`, so
   * the provider has to fall back to `innerText`. The stub still matches it with the
   * textarea selector — one fake locator stands in for the whole `or` chain — because
   * what is under test is the read fallback, not which selector found the box.
   */
  composer?: 'present' | 'absent' | 'contenteditable';
  /**
   * How many reads report no composer before it appears — Meet painting the panel a
   * render ahead of its input, which the provider has to wait out rather than read as a
   * shut panel.
   */
  composerPaintsLate?: number;
  /** What `fill` throws, i.e. the box went away between the probe and the typing. */
  fillError?: string;
  /** Whether the panel offers a send button beside the composer. */
  sendButton?: boolean;
  /**
   * What submitting does.
   *
   * `sends` — clears the composer and puts the text in the room, i.e. it worked.
   * `clears-only` — empties the composer and posts nothing, which is what a send the
   * server dropped looks like from the DOM.
   * `ignores` — leaves the draft where it is, which is a handler that has moved.
   */
  submit?: 'sends' | 'clears-only' | 'ignores';
  /** Whether Enter submits at all. */
  enterSends?: boolean;
}

interface FakeState {
  bodyText: string;
  visibleButtons: Set<string>;
  visibleSelectors: Set<string>;
  attributes: Record<string, string | null>;
  mic: 'on' | 'off' | 'absent';
  dialog: boolean;
  chatOpen: boolean;
  composer: 'present' | 'absent' | 'contenteditable';
  /** The text currently sitting in the composer, unsent. */
  draft: string;
  /** Messages the room received, in order. */
  sent: string[];
}

/**
 * A page stub covering only the surface the provider touches. Playwright's real
 * types are enormous, hence the cast at the end.
 */
function fakePage(options: FakePageOptions) {
  const chat = options.chat ?? 'closed';
  const state: FakeState = {
    bodyText: options.bodyText ?? '',
    visibleButtons: new Set(options.visibleButtons ?? []),
    visibleSelectors: new Set(options.visibleSelectors ?? []),
    attributes: options.attributes ?? {},
    mic: options.mic ?? 'on',
    dialog: options.dialog ?? false,
    chatOpen: chat === 'open',
    composer: options.composer ?? 'present',
    draft: '',
    sent: [],
  };
  // The chat control is a real button on the page, so it belongs in the same set the
  // provider's `getByRole` reads — a test says `chat: 'closed'` instead of knowing that.
  if (chat !== 'absent') state.visibleButtons.add('Chat with everyone');
  if (options.sendButton) state.visibleSelectors.add(CHAT_SEND_SELECTOR);
  /** Every phrasing the provider's toggle locator can be credited with. */
  const isChatToggle = (k: string | undefined) =>
    k === CHAT_TOGGLE_SELECTOR || /^chat/i.test(k ?? '');
  const clicks: string[] = [];
  const fills: string[] = [];
  const presses: string[] = [];
  let ticks = 0;
  let micReads = 0;
  let bodyReads = 0;

  /** What Meet does when the composer is submitted, per `options.submit`. */
  const submit = () => {
    const mode = options.submit ?? 'sends';
    if (mode === 'ignores') return;
    const text = state.draft;
    state.draft = '';
    if (mode !== 'sends' || !text) return;
    state.sent.push(text);
    // The sent message joins the page text, which is where the provider looks for it.
    state.bodyText = `${state.bodyText}\n${text}`;
  };

  type FakeLocator = ReturnType<typeof locator>;
  /**
   * `key` is a thunk so an `or` chain resolves it when used, not when composed.
   *
   * `rereads` is how many extra times `waitFor` asks — zero for everything except a
   * locator a test asked to paint late, so no test pays a real wait for it.
   */
  const locator = (
    matches: () => boolean,
    key: () => string | undefined = () => undefined,
    rereads = 0,
  ) => ({
    /** Exposed so `.or()` can compose, as Playwright's real locator does. */
    _matches: matches,
    _key: key,
    first: () => locator(matches, key, rereads),
    or: (other: FakeLocator) =>
      locator(
        () => matches() || other._matches(),
        // Attribution follows whichever side matches at the moment of use, so a
        // click through the chain is still credited to the right element.
        () => (matches() ? key() : other._key()),
        rereads,
      ),
    // Playwright's real `waitFor` polls until the element is visible and throws on
    // timeout. Resolving/throwing immediately here keeps the tests fast; the
    // provider's own retry loops still drive state changes via waitForTimeout.
    waitFor: async () => {
      for (let read = 0; read < rereads; read += 1) {
        if (matches()) return;
        await new Promise((r) => setTimeout(r, 1));
      }
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
      const k = key() ?? 'unknown';
      // Recorded before `onClick` runs, so a click the scrim swallowed still shows
      // as attempted — which is the thing a retry test needs to see.
      clicks.push(k);
      // The chat panel's two buttons behave structurally rather than by arrangement,
      // for the same reason the microphone does: a test should say what the panel is,
      // not wire up what each click does to it.
      if (k === CHAT_SEND_SELECTOR) submit();
      if (isChatToggle(k)) state.chatOpen = !state.chatOpen;
      options.onClick?.(k, state);
    },
    fill: async (value: string) => {
      fills.push(value);
      if (options.fillError) throw new Error(options.fillError);
      if (key() === CHAT_COMPOSER_SELECTOR) state.draft = value;
    },
    press: async (keyName: string) => {
      presses.push(`${key() ?? 'unknown'}:${keyName}`);
      if (keyName === 'Enter' && options.enterSends !== false) submit();
    },
    inputValue: async () => {
      // Playwright throws on anything that is not an input, which is what makes the
      // provider's `innerText` fallback reachable.
      if (key() !== CHAT_COMPOSER_SELECTOR || state.composer === 'contenteditable') {
        throw new Error('inputValue: Node is not an <input>, <textarea> or <select> element');
      }
      return state.draft;
    },
    innerText: async () => {
      if (key() === CHAT_COMPOSER_SELECTOR) return state.draft;
      bodyReads += 1;
      options.onBodyRead?.(bodyReads, state);
      return state.bodyText;
    },
    getAttribute: async (attr: string) => {
      const k = key();
      // Derived rather than stored, so `state.mic` is the single place a test (or
      // an `onClick`) has to change to move the microphone.
      if (k === MIC_TOGGLE_SELECTOR && attr === 'data-is-muted' && state.mic !== 'absent') {
        return state.mic === 'off' ? 'true' : 'false';
      }
      // Same reason: the panel's state is `state.chatOpen`, and the toggle reports it —
      // when there is a toggle at all, and when the test did not take the attribute away.
      if (
        isChatToggle(k) &&
        attr === 'aria-expanded' &&
        chat !== 'absent' &&
        options.chatExpanded !== 'missing'
      ) {
        return state.chatOpen ? 'true' : 'false';
      }
      return state.attributes[`${k}|${attr}`] ?? null;
    },
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
      // The two selectors the audio path drives, answered from their own state so a
      // test says `mic: 'off'` rather than hand-writing a selector string.
      if (selector === MIC_TOGGLE_SELECTOR) {
        // Counted here rather than in `getAttribute` because "is it there" is the read
        // that can come back empty, and a test wanting to fake that has to answer this.
        return locator(() => {
          micReads += 1;
          options.onMicRead?.(micReads, state);
          return state.mic !== 'absent';
        }, () => selector);
      }
      if (selector === BLOCKING_DIALOG_SELECTOR) {
        return locator(() => state.dialog, () => selector);
      }
      if (selector === CHAT_COMPOSER_SELECTOR) {
        let late = options.composerPaintsLate ?? 0;
        return locator(
          () => {
            if (late > 0) {
              late -= 1;
              return false;
            }
            return state.chatOpen && state.composer !== 'absent';
          },
          () => selector,
          late,
        );
      }
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

  return { page: page as unknown as Page, state, clicks, fills, presses, ticks: () => ticks };
}

const provider = new GoogleMeetProvider();
const joinOptions = {
  url: 'https://meet.google.com/abc-defg-hij',
  displayName: 'Prism',
  admissionTimeoutMs: 2_000,
  // Required by the contract, so every case supplies one; the two that care about it
  // override it with a recorder.
  onRequestSubmitted: () => {},
};

beforeEach(() => {
  vi.mocked(isAuthenticated).mockReturnValue(false);
  vi.mocked(sessionEvidence).mockReturnValue(null);
  vi.mocked(signInFailureReason).mockReturnValue(null);
});

/** The reading a refused session leaves behind, as `sessionEvidence()` reports it. */
const REFUSED_SESSION = {
  live: false,
  signal: 'the account page settled on https://accounts.google.com',
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    expect(clicks).toContain('Ask to join');
    // Nothing is typed any more: Meet refuses automated anonymous guests, so a join
    // without an account is rejected before a browser is ever launched.
    expect(fills).toEqual([]);
  });

  it('waits out the waiting room and reports admission when it arrives', async () => {
    const harness = fakePage({
      visibleButtons: ['Ask to join'],
      // Admitted only on the third poll, as a real host would. The marker is the Leave
      // control: this used to add a People button, which a live probe of the page found Meet
      // never renders — so the fake was proving admission by furniture that does not exist.
      onTick: (tick) => {
        if (tick >= 3) harness.state.visibleSelectors.add('button[aria-label*="Leave call" i]');
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
  });

  it('says the request is in once the join button is clicked, and not before', async () => {
    // The runtime answers its caller on this signal, so it has to come after the click
    // and before the wait for a host. Admitted only on the third poll, so the two are
    // separable: a signal raised with the outcome would prove nothing.
    const submittedAt: number[] = [];
    const harness = fakePage({
      visibleButtons: ['Ask to join'],
      onTick: (tick) => {
        if (tick >= 3) harness.state.visibleSelectors.add('button[aria-label*="Leave call" i]');
      },
    });

    const outcome = await provider.join(harness.page, {
      ...joinOptions,
      onRequestSubmitted: () => submittedAt.push(harness.ticks()),
    });

    expect(outcome.status).toBe('admitted');
    expect(harness.clicks).toContain('Ask to join');
    // Once, and while the waiting room was still being polled.
    expect(submittedAt).toHaveLength(1);
    expect(submittedAt[0]).toBeLessThan(harness.ticks());
  });

  it('says nothing about a request it never made', async () => {
    // The page never loaded, so there was no button to click. A signal here is the
    // false success the runtime would report to the room.
    const submitted = vi.fn();
    const { page } = fakePage({ gotoError: 'net::ERR_NAME_NOT_RESOLVED' });

    const outcome = await provider.join(page, { ...joinOptions, onRequestSubmitted: submitted });

    expect(outcome).toEqual({
      status: 'failed',
      step: 'page_load',
      reason: expect.stringMatching(/could not load/i),
    });
    expect(submitted).not.toHaveBeenCalled();
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

    expect(visited).toEqual([joinOptions.url, joinOptions.url]);
    // And it started the second attempt from a page that had stopped moving. Without
    // that, the retry inherits the interloper's next hop and dies the same way — which
    // is what production did, twice per join.
    expect(quiesce).toHaveBeenCalledWith(page);
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

    // One try, and the page was not parked either — nothing was retried.
    expect(attempts).toBe(1);
    expect(quiesce).not.toHaveBeenCalled();
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
  });

  it('joins a meeting with no name field', async () => {
    // Some meetings don't ask a guest for a name; that is not a failure.
    const { page, fills } = fakePage({
      visibleButtons: ['Ask to join'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
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
      // The signature: a guest name field on a browser whose session Google refused.
      visibleSelectors: ['input[aria-label="Your name"]'],
      visibleButtons: ['Ask to join'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(sessionEvidence).mockReturnValue(REFUSED_SESSION);

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'reauth_required' });
    // Nothing was typed and nothing was clicked: going further is a guaranteed
    // refusal, and the caller can fix this by signing in again.
    expect(fills).toEqual([]);
    expect(clicks).toEqual([]);
  });

  it('joins a lobby that offers a name field when the account session is live', async () => {
    // The defect this fixes. A name field alone used to end the join, so a session
    // Google had just accepted was thrown away and the password typed again — which
    // is what earns the account a challenge. Two readings now have to agree, and this
    // one has them disagreeing.
    const { page } = fakePage({
      visibleSelectors: [
        'input[aria-label="Your name"]',
        'button[aria-label*="Leave call" i]',
      ],
      visibleButtons: ['Ask to join'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(sessionEvidence).mockReturnValue({
      live: true,
      signal: 'the account page stayed on myaccount.google.com',
    });

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
  });

  it('names the signal that refused the session', async () => {
    // A login this account did not need is what gets it challenged, so a log that
    // says only "the session is stale" leaves nobody able to tell a real refusal from
    // a probe that was interrupted.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const { page } = fakePage({
      visibleSelectors: ['input[aria-label="Your name"]'],
      visibleButtons: ['Ask to join'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(sessionEvidence).mockReturnValue(REFUSED_SESSION);

    await provider.join(page, joinOptions);

    expect(warn.mock.calls.map(String).join('\n')).toContain(REFUSED_SESSION.signal);
    warn.mockRestore();
  });

  it('signs in again when the session was never checked', async () => {
    // The sign-in call throws before it reads anything, or never ran. Nothing
    // confirms the session, so the guest field is taken at face value — the safe
    // direction, since a session nobody checked may well be refused.
    const { page } = fakePage({
      visibleSelectors: ['input[aria-label="Your name"]'],
      visibleButtons: ['Ask to join'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(sessionEvidence).mockReturnValue(null);

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'reauth_required' });
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

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    expect(fills).toEqual([]);
  });

  it('does not report it for a signed-in lobby with no name field', async () => {
    const { page } = fakePage({
      visibleButtons: ['Join now'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
    });

    vi.mocked(isAuthenticated).mockReturnValue(true);

    const outcome = await provider.join(page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
  });
});

/**
 * The microphone.
 *
 * Meet auto-mutes a new joiner once a call is past a handful of participants, and
 * nothing downstream can see it: the bot is admitted, the participant count reads
 * fine, the Realtime socket is healthy, and the model cheerfully greets a room that
 * hears silence. So `admitted` has to mean "and they can hear us", which makes the
 * unmute part of the join rather than something the call does later.
 *
 * The scrim matters as much as the toggle. A post-join dialog ("Others may see your
 * video differently") renders over the controls and swallows pointer events, so a
 * plain click on the unmute button retries until it times out — the mic is reachable
 * only after the dialog is gone.
 */
describe('the microphone', () => {
  /** Admitted, with the mic toggle and the in-call furniture both on screen. */
  const inCall = (extra: Partial<FakePageOptions> = {}) =>
    fakePage({
      visibleButtons: ['Ask to join'],
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
      ...extra,
    });

  it('unmutes a microphone Meet muted on the way in', async () => {
    const harness = inCall({
      mic: 'off',
      // Clicking the toggle is what makes it live, as it does in a real call.
      onClick: (key, state) => {
        if (key === MIC_TOGGLE_SELECTOR) state.mic = 'on';
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    // Reported as admitted *and* as having arrived muted — the second half is the
    // measurement that would have caught this bug on the first call.
    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: true, micConfirmed: true });
    expect(harness.clicks).toContain(MIC_TOGGLE_SELECTOR);
  });

  it('leaves an already-live microphone alone', async () => {
    const harness = inCall({ mic: 'on' });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: true });
    // Clicking a live mic would mute it — the exact bug, inverted.
    expect(harness.clicks).not.toContain(MIC_TOGGLE_SELECTOR);
  });

  it('dismisses the dialog covering the controls before it clicks unmute', async () => {
    const harness = inCall({
      mic: 'off',
      dialog: true,
      visibleButtons: ['Ask to join', 'Got it'],
      onClick: (key, state) => {
        // The scrim swallows the click while the dialog is up, the way Playwright
        // reports it: "subtree intercepts pointer events".
        if (key === MIC_TOGGLE_SELECTOR) {
          if (state.dialog) throw new Error('element intercepts pointer events');
          state.mic = 'on';
        }
        if (key === 'Got it') state.dialog = false;
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: true, micConfirmed: true });
    // The order is the point: unmuting is only reachable once the scrim is gone.
    expect(harness.clicks.indexOf(MIC_TOGGLE_SELECTOR)).toBeGreaterThan(
      harness.clicks.indexOf('Got it'),
    );
  });

  it('retries an unmute the scrim swallowed instead of giving up on the first throw', async () => {
    let thrown = 0;
    const harness = inCall({
      mic: 'off',
      dialog: true,
      visibleButtons: ['Ask to join', 'Got it'],
      onClick: (key, state) => {
        if (key !== MIC_TOGGLE_SELECTOR) {
          if (key === 'Got it') state.dialog = false;
          return;
        }
        // Swallowed once, then lands — a dialog that outlived the first sweep.
        if (thrown === 0) {
          thrown += 1;
          throw new Error('element intercepts pointer events');
        }
        state.mic = 'on';
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: true, micConfirmed: true });
    expect(thrown).toBe(1);
  });

  it('does not click again when it cannot read the toggle it just unmuted', async () => {
    // A click that landed, followed by a read that comes back empty — Meet re-rendering
    // the control bar, or the selector rotting between two reads. Treating that as
    // "still muted" spends another attempt, and since a toggle toggles, that attempt
    // mutes the microphone it just turned on: the original bug, re-entered backwards.
    const harness = inCall({
      mic: 'off',
      onClick: (key, state) => {
        if (key === MIC_TOGGLE_SELECTOR) state.mic = state.mic === 'on' ? 'off' : 'on';
      },
      // 1 is the read on arrival (muted), 2 the recheck right after the click, which
      // finds nothing, and 3 the patient re-read, by which time the control is back.
      onMicRead: (reads, state) => {
        if (reads === 2) state.mic = 'absent';
        if (reads === 3) state.mic = 'on';
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: true, micConfirmed: true });
    expect(harness.clicks.filter((c) => c === MIC_TOGGLE_SELECTOR)).toHaveLength(1);
  });

  it('joins anyway when the toggle never goes live, and says it is not confirmed', async () => {
    // A toggle that is there and clickable but never flips. The agent joins: it still
    // hears the room, which arrives on a device that has nothing to do with the
    // microphone, and it keeps every tool it has. What it must not do is claim the room
    // can hear it — the runtime decides who to tell, and it can only do that if this is
    // reported rather than smoothed over.
    const harness = inCall({ mic: 'off' });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: true, micConfirmed: false });
    // And it stopped clicking. This control is a toggle, so an unbounded retry is not
    // persistence, it is a coin-flip on the state it is trying to fix.
    expect(harness.clicks.filter((c) => c === MIC_TOGGLE_SELECTOR)).toHaveLength(2);
  });

  it('joins unconfirmed when there is no toggle at all, without inventing an auto-mute', async () => {
    // Selector rot. Two things must not happen: "no toggle" must not read as "already
    // unmuted" (that is indistinguishable from success until nobody can hear the agent),
    // and it must not be filed as `mutedOnEntry` either — that number exists to decide
    // whether the unmute step earns its keep, and a reading nobody took would inflate it
    // during exactly the outage that produced it.
    const harness = inCall({ mic: 'absent' });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toEqual({ status: 'admitted', mutedOnEntry: false, micConfirmed: false });
    // Nothing was clicked: there was nothing to click, and guessing at coordinates on a
    // UI we cannot read is how a bot turns a camera on.
    expect(harness.clicks).not.toContain(MIC_TOGGLE_SELECTOR);
  });

  it('never clicks its way into a call with no microphone', async () => {
    // The regression. Meet offers "Continue without microphone" in the lobby and
    // the dismissal list used to click it, which joins with no capture device at
    // all — permanently inaudible, and unrecoverable by unmuting afterwards.
    const harness = inCall({
      visibleButtons: [
        'Ask to join',
        'Continue without microphone and camera',
        'Continue without microphone',
      ],
    });

    await provider.join(harness.page, joinOptions);

    expect(harness.clicks).not.toContain('Continue without microphone');
    expect(harness.clicks).not.toContain('Continue without microphone and camera');
  });

  it('does not press a dialog button that is not merely dismissive', async () => {
    // The dialog sweep clears scrims, so it is tempting to have it press whatever
    // button the dialog offers. That is the same bug by another route: this dialog's
    // only button joins without a microphone.
    const harness = inCall({
      mic: 'off',
      dialog: true,
      visibleButtons: ['Ask to join', 'Continue without microphone'],
      onClick: (key, state) => {
        if (key === MIC_TOGGLE_SELECTOR && state.dialog) {
          throw new Error('element intercepts pointer events');
        }
      },
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(harness.clicks).not.toContain('Continue without microphone');
    // And it still reports the microphone as unconfirmed rather than pretending the
    // click it never landed had worked.
    expect(outcome).toMatchObject({ status: 'admitted', micConfirmed: false });
  });

  it('names the microphone, not the page, when Meet only offers to join without one', async () => {
    // The cost of no longer clicking that offer: its panel covers the join button, so
    // the visible symptom is a button hunt that finds nothing — a true observation
    // that sends whoever reads it looking at Meet's markup instead of at the
    // container's audio devices.
    const harness = fakePage({
      visibleButtons: ['Continue without microphone'],
      bodyText: "Meet can't find your microphone. Continue without microphone?",
    });

    const outcome = await provider.join(harness.page, joinOptions);

    expect(outcome).toMatchObject({ status: 'failed', step: 'microphone' });
    expect((outcome as { reason: string }).reason).toMatch(/microphone/i);
    expect(harness.clicks).not.toContain('Continue without microphone');
  });

});

/**
 * The chat panel.
 *
 * Meet publishes no chat API, so posting a message is selector-matching against the
 * in-call panel — and none of those selectors has been verified against a live call.
 * Which makes the direction of a failure the thing worth testing: every case below
 * that cannot read the outcome has to report the step it stopped at, and none of them
 * may report a success. A room that got nothing while the agent says it sent something
 * is the failure this block exists to prevent.
 *
 * The panel's own hazard is that its control is a *toggle*, the same shape as the
 * microphone: pressing it while the panel is open closes the panel.
 */
describe('the chat panel', () => {
  /** In a call, with a chat control on screen and the panel shut. */
  const inCall = (extra: Partial<FakePageOptions> = {}) =>
    fakePage({
      visibleSelectors: ['button[aria-label*="Leave call" i]'],
      ...extra,
    });

  it('sends a message, confirms it landed, and puts the panel back', async () => {
    const harness = inCall();

    const result = await provider.sendChatMessage(harness.page, 'https://example.test/run/42');

    expect(result).toEqual({ sent: true });
    expect(harness.state.sent).toEqual(['https://example.test/run/42']);
    // Opened, then closed again: an open panel shares the side rail with People and
    // can push the participant count down, which is what makes the runtime leave.
    expect(harness.clicks.filter((c) => /^chat/i.test(c))).toHaveLength(2);
    expect(harness.state.chatOpen).toBe(false);
  });

  it('does not press the toggle when the panel is already open', async () => {
    const harness = inCall({ chat: 'open' });

    const result = await provider.sendChatMessage(harness.page, 'ready when you are');

    expect(result).toEqual({ sent: true });
    expect(harness.state.sent).toEqual(['ready when you are']);
    // One click, the close. Pressing it to "open" an open panel would have shut it.
    expect(harness.clicks.filter((c) => /^chat/i.test(c))).toHaveLength(1);
  });

  it('reports the panel step, not a success, when there is no chat control', async () => {
    const harness = inCall({ chat: 'absent' });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result).toEqual({ sent: false, step: 'panel', reason: expect.any(String) });
    expect(harness.fills).toEqual([]);
    expect(harness.state.sent).toEqual([]);
  });

  it('reports the composer step when the panel opens but paints no input', async () => {
    const harness = inCall({ composer: 'absent' });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result).toEqual({ sent: false, step: 'composer', reason: expect.any(String) });
    expect(harness.state.sent).toEqual([]);
    // The panel was clicked open before the input was found missing, so this failure is
    // the one that would leave it standing over the participant tiles.
    expect(harness.state.chatOpen).toBe(false);
  });

  it('closes the panel when the composer goes away between the probe and the typing', async () => {
    const harness = inCall({ fillError: 'element is not attached to the DOM' });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result).toEqual({ sent: false, step: 'composer', reason: expect.any(String) });
    expect(harness.state.chatOpen).toBe(false);
  });

  it('leaves an open panel open when its input paints a render late', async () => {
    // The panel's state is `aria-expanded` on the toggle, not whether the box is there
    // yet: a composer one render behind reads as a shut panel, and a click to "open" it
    // shuts the panel over the send.
    const harness = inCall({ chat: 'open', composerPaintsLate: 1 });

    const result = await provider.sendChatMessage(harness.page, 'ready when you are');

    expect(result).toEqual({ sent: true });
    // One click, the close at the end.
    expect(harness.clicks.filter((c) => /^chat/i.test(c))).toHaveLength(1);
  });

  it('sends anyway when the toggle will not say whether the panel is open', async () => {
    const harness = inCall({ chatExpanded: 'missing' });

    const result = await provider.sendChatMessage(harness.page, 'the build is green');

    expect(result).toEqual({ sent: true });
    // Unreadable is treated as "click it": a panel left open reads the participant count
    // down, and a panel clicked open by mistake is undone by the next send.
    expect(harness.state.chatOpen).toBe(false);
  });

  it('reports the send step when Enter does nothing and there is no send button', async () => {
    const harness = inCall({ enterSends: false });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result).toEqual({ sent: false, step: 'send', reason: expect.any(String) });
    expect(harness.state.draft).toBe('anyone there');
    expect(harness.state.sent).toEqual([]);
  });

  it('does not report success when the draft is still sitting in the composer', async () => {
    // Enter is accepted and a send button exists, so both paths are tried — and the
    // text never leaves the box. This is the silent-success case: the message is
    // visible on the page the whole time, in the composer, so a containment check on
    // its own would have called this sent.
    const harness = inCall({ submit: 'ignores', sendButton: true, bodyText: 'anyone there' });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result).toEqual({ sent: false, step: 'confirm', reason: expect.any(String) });
    expect(harness.state.sent).toEqual([]);
  });

  it('does not report success when the composer clears but the message never appears', async () => {
    const harness = inCall({ submit: 'clears-only', sendButton: true });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result).toEqual({ sent: false, step: 'confirm', reason: expect.any(String) });
    expect(harness.state.sent).toEqual([]);
  });

  it('falls back to the send button when Enter will not send', async () => {
    const harness = inCall({ enterSends: false, sendButton: true });

    const result = await provider.sendChatMessage(harness.page, 'the build is green');

    expect(result).toEqual({ sent: true });
    expect(harness.state.sent).toEqual(['the build is green']);
    expect(harness.clicks).toContain(CHAT_SEND_SELECTOR);
  });

  it('prefers the tag-pinned send button over anything else named send', async () => {
    // The composer carries the same accessible name as the send button, so the phrasings
    // are probed in order rather than unioned — a union resolves by DOM order, which is
    // not something this code gets to choose.
    const harness = inCall({
      enterSends: false,
      sendButton: true,
      visibleButtons: ['Send a message'],
    });

    const result = await provider.sendChatMessage(harness.page, 'the build is green');

    expect(result).toEqual({ sent: true });
    expect(harness.clicks).toContain(CHAT_SEND_SELECTOR);
    expect(harness.clicks).not.toContain('Send a message');
  });

  it('reads a composer whose value cannot be read as an input', async () => {
    const harness = inCall({ composer: 'contenteditable' });

    const result = await provider.sendChatMessage(harness.page, 'the build is green');

    expect(result).toEqual({ sent: true });
    expect(harness.state.sent).toEqual(['the build is green']);
  });

  it('clears a dialog scrim before pressing the chat control', async () => {
    // The same scrim that swallows the unmute click swallows this one, and reports
    // success on the scrim rather than on the button underneath.
    const harness = inCall({
      dialog: true,
      visibleButtons: ['Got it'],
      onClick: (key, state) => {
        if (key === 'Got it') state.dialog = false;
      },
    });

    const result = await provider.sendChatMessage(harness.page, 'the build is green');

    expect(result).toEqual({ sent: true });
    expect(harness.clicks[0]).toBe('Got it');
  });

  it('does not confirm a send off an identical message already in the panel', async () => {
    // The agent posts the same link twice in one call — a plausible thing to do, since
    // nothing reads the chat back and it cannot see whether anyone acted on the first
    // one. The second send clears the box and posts nothing. The first message is still
    // on the page, so "is this text present" was true before this send even started.
    const harness = inCall({
      submit: 'clears-only',
      sendButton: true,
      bodyText: 'Alice: thanks\nPrism: https://example.test/run/42',
    });

    const result = await provider.sendChatMessage(harness.page, 'https://example.test/run/42');

    expect(result).toEqual({ sent: false, step: 'confirm', reason: expect.any(String) });
    expect(harness.state.sent).toEqual([]);
  });

  it('confirms the second of two identical messages when it does land', async () => {
    const harness = inCall({ bodyText: 'Prism: https://example.test/run/42' });

    const result = await provider.sendChatMessage(harness.page, 'https://example.test/run/42');

    expect(result).toEqual({ sent: true });
    expect(harness.state.sent).toEqual(['https://example.test/run/42']);
  });

  it('does not count a history that paints after the first read as this send', async () => {
    // The composer can be there a moment before the messages are, and the message the
    // history brings is the agent's own from earlier in the call. A baseline taken in that
    // moment is too low, so the late paint reads as this send having landed — while the
    // send in fact cleared the box and posted nothing.
    const harness = inCall({
      submit: 'clears-only',
      sendButton: true,
      onBodyRead: (reads, state) => {
        if (reads === 2) state.bodyText = 'Prism: https://example.test/run/42';
      },
    });

    const result = await provider.sendChatMessage(harness.page, 'https://example.test/run/42');

    expect(result).toEqual({ sent: false, step: 'confirm', reason: expect.any(String) });
    expect(harness.state.sent).toEqual([]);
  });

  it('closes the panel after a failed send, without turning it into a success', async () => {
    const harness = inCall({ submit: 'clears-only', sendButton: true });

    const result = await provider.sendChatMessage(harness.page, 'anyone there');

    expect(result.sent).toBe(false);
    expect(harness.state.chatOpen).toBe(false);
  });
});

/**
 * Reading and setting the microphone mid-call, which is a different job from the join.
 *
 * The join gets the microphone live once, with two attempts and a long deadline. These
 * two run on a call that is already up: one reading, one click at most, and an answer
 * that says "I could not read it" rather than guessing.
 */
describe('mid-call microphone control', () => {
  it('reads the toggle without touching it', async () => {
    const live = fakePage({ mic: 'on' });
    expect(await provider.microphoneLive(live.page)).toBe(true);
    expect(live.clicks).toEqual([]);

    const muted = fakePage({ mic: 'off' });
    expect(await provider.microphoneLive(muted.page)).toBe(false);
    expect(muted.clicks).toEqual([]);
  });

  it('answers null for a toggle it cannot find, rather than the convenient value', async () => {
    // The reading a rotted selector gives. Reported as live it would look like a healthy
    // call; reported as muted it would arm a clicker on a control bar nobody can see.
    const harness = fakePage({ mic: 'absent' });

    expect(await provider.microphoneLive(harness.page)).toBeNull();
    expect(await provider.setMicrophone(harness.page, true)).toBeNull();
    expect(harness.clicks).toEqual([]);
  });

  it('mutes a live microphone with one click', async () => {
    const harness = fakePage({
      mic: 'on',
      onClick: (key, state) => {
        if (key === MIC_TOGGLE_SELECTOR) state.mic = 'off';
      },
    });

    expect(await provider.setMicrophone(harness.page, false)).toBe(false);
    expect(harness.clicks).toEqual([MIC_TOGGLE_SELECTOR]);
  });

  it('unmutes a muted microphone with one click', async () => {
    const harness = fakePage({
      mic: 'off',
      onClick: (key, state) => {
        if (key === MIC_TOGGLE_SELECTOR) state.mic = 'on';
      },
    });

    expect(await provider.setMicrophone(harness.page, true)).toBe(true);
    expect(harness.clicks).toEqual([MIC_TOGGLE_SELECTOR]);
  });

  it('clicks nothing when the microphone already reads what was asked for', async () => {
    // A toggle toggles, so an unconditional click is how "turn it on" turns it off.
    const live = fakePage({ mic: 'on' });
    expect(await provider.setMicrophone(live.page, true)).toBe(true);
    expect(live.clicks).toEqual([]);

    const muted = fakePage({ mic: 'off' });
    expect(await provider.setMicrophone(muted.page, false)).toBe(false);
    expect(muted.clicks).toEqual([]);
  });

  it('dismisses a dialog covering the controls before it clicks', async () => {
    const harness = fakePage({
      mic: 'off',
      dialog: true,
      visibleButtons: ['Got it'],
      onClick: (key, state) => {
        if (key === MIC_TOGGLE_SELECTOR) {
          if (state.dialog) throw new Error('element intercepts pointer events');
          state.mic = 'on';
        }
        if (key === 'Got it') state.dialog = false;
      },
    });

    expect(await provider.setMicrophone(harness.page, true)).toBe(true);
    expect(harness.clicks).toEqual(['Got it', MIC_TOGGLE_SELECTOR]);
  });

  it('reports the state it last read when the click is swallowed', async () => {
    // One click and no more: this is not the join, and a second click on a control the
    // scrim is eating is how the next poll mutes what this one unmuted.
    const harness = fakePage({
      mic: 'off',
      dialog: true,
      onClick: () => {
        throw new Error('element intercepts pointer events');
      },
    });

    expect(await provider.setMicrophone(harness.page, true)).toBe(false);
    expect(harness.clicks).toEqual([MIC_TOGGLE_SELECTOR]);
  });
});
