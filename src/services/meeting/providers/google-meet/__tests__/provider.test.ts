import { describe, it, expect } from 'vitest';
import {
  GoogleMeetProvider,
  nameFromOptionsLabel,
  unglueTileName,
} from '../index';

const provider = new GoogleMeetProvider();

describe('GoogleMeetProvider.matchesUrl', () => {
  it('accepts a Meet link', () => {
    expect(provider.matchesUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
  });

  it('accepts a Meet link with query parameters', () => {
    expect(provider.matchesUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe(true);
  });

  it('rejects other platforms', () => {
    expect(provider.matchesUrl('https://teams.microsoft.com/l/meetup-join/x')).toBe(false);
    expect(provider.matchesUrl('https://zoom.us/j/123456')).toBe(false);
  });

  it('rejects a lookalike host', () => {
    // Would be a real hazard: an attacker-controlled host that ends in the same
    // string. Hostname is compared exactly, not by suffix.
    expect(provider.matchesUrl('https://meet.google.com.evil.test/abc')).toBe(false);
    expect(provider.matchesUrl('https://notmeet.google.com/abc')).toBe(false);
  });

  it('rejects plain http', () => {
    expect(provider.matchesUrl('http://meet.google.com/abc-defg-hij')).toBe(false);
  });

  it('rejects junk without throwing', () => {
    expect(provider.matchesUrl('not a url')).toBe(false);
    expect(provider.matchesUrl('')).toBe(false);
  });
});

describe('GoogleMeetProvider identity', () => {
  it('names itself for tools, logs and telemetry', () => {
    expect(provider.name).toBe('google-meet');
    expect(provider.displayName).toBe('Google Meet');
  });
});

/**
 * Reading the room.
 *
 * The first version of this looked for `[data-participant-count]` and a
 * `button[aria-label*="People"]`. A live call renders neither, so the count came
 * back null for the whole meeting — which pinned the agent to one response mode
 * and disabled the empty-room check, both silently. These cases are built from
 * the markup Meet actually served, so the same drift fails a test next time.
 */
describe('GoogleMeetProvider.participantCount', () => {
  /** A page whose `evaluate` runs the probe against `html` in a real DOM. */
  const pageWith = (html: string) => ({
    async evaluate<T>(fn: () => T): Promise<T> {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM(`<body>${html}</body>`);
      const previous = globalThis.document;
      (globalThis as { document?: Document }).document = dom.window.document;
      try {
        return fn();
      } finally {
        (globalThis as { document?: Document }).document = previous;
      }
    },
  }) as unknown as Parameters<GoogleMeetProvider['participantCount']>[0];

  it('reads the count badge on the People control', async () => {
    // Label and badge are separate nodes, so the control's text reads "People3".
    // Every class on that subtree is a generated hash, hence matching on text.
    const html = `<div><div class="nI4yAd"><span>People</span><div class="fs3avc">3</div></div></div>`;
    expect(await provider.participantCount(pageWith(html))).toBe(3);
  });

  it('counts distinct participant ids when the control is unreadable', async () => {
    // The language-independent reading, and the one that survives a relabelled
    // People control. Ids repeat across the grid and the roster panel.
    const html = `
      <div data-participant-id="a"></div>
      <div data-participant-id="b"></div>
      <div data-participant-id="a"></div>`;
    expect(await provider.participantCount(pageWith(html))).toBe(2);
  });

  it('takes the largest reading when they disagree', async () => {
    // Meet stops rendering off-screen tiles in a big call, so the tile count can
    // read low. Reading low is the dangerous direction: it would put the agent
    // back to answering every sentence in a room full of people.
    const html = `
      <div class="nI4yAd"><span>People</span><div>9</div></div>
      <div data-participant-id="a"></div>
      <div data-participant-id="b"></div>`;
    expect(await provider.participantCount(pageWith(html))).toBe(9);
  });

  it('still reads the two legacy attributes', async () => {
    expect(await provider.participantCount(pageWith('<div data-participant-count="5"></div>'))).toBe(5);
    expect(
      await provider.participantCount(pageWith('<button aria-label="People (4)"></button>')),
    ).toBe(4);
  });

  it('discards a reading that is not a number', async () => {
    // `parseInt('lots')` is NaN, and NaN reaching the caller would compare false
    // against every threshold — neither "leave" nor "stay", just quietly wrong.
    expect(
      await provider.participantCount(pageWith('<div data-participant-count="lots"></div>')),
    ).toBeNull();
  });

  it('returns null when the page says nothing about people', async () => {
    // Never a guess: the caller uses this to leave, and a selector change must
    // not eject the agent from a call that is still going.
    expect(await provider.participantCount(pageWith('<div>call in progress</div>'))).toBeNull();
  });

  it('returns null rather than hanging when the page cannot answer', async () => {
    const wedged = {
      evaluate: () => new Promise(() => {}),
    } as unknown as Parameters<GoogleMeetProvider['participantCount']>[0];

    // `page.evaluate` has no timeout of its own, and this runs on a timer for the
    // whole call: one read that never settles would stall every later poll.
    await expect(provider.participantCount(wedged)).resolves.toBeNull();
  }, 10_000);
});

/**
 * Name extraction, against the exact strings a live Meet call produced.
 *
 * Written this way on purpose: the participant *count* selectors were invented from
 * first principles, passed every test, and matched nothing Meet actually serves —
 * the count read `null` for entire meetings while the suite stayed green. These
 * inputs were copied out of a running call over CDP.
 */
describe('reading participant names', () => {
  it('undoubles the name in a tile', () => {
    // Meet renders the name twice and glues a control label on the end.
    expect(unglueTileName('Mario SarcherMario Sarcherdevices')).toBe('Mario Sarcher');
  });

  it('rejects a tile that is only controls', () => {
    expect(
      unglueTileName('visual_effectsBackgrounds and effectsShow in a tilemore_vert'),
    ).toBeNull();
  });

  it('takes the name out of the per-participant menu label', () => {
    expect(nameFromOptionsLabel('More options for Emma Sky')).toBe('Emma Sky');
    expect(nameFromOptionsLabel('Pin Emma Sky to the screen')).toBeNull();
  });

  it('declines a tile it cannot read as doubled', () => {
    // The first version stripped trailing lowercase as "control labels" and turned
    // "Miska" into "M" — a single letter handed to the transcriber as a hint to bias
    // towards. Undoubled tiles are left to the menu-label reading instead.
    expect(unglueTileName('Miska')).toBeNull();
    expect(unglueTileName('Lee')).toBeNull();
  });
});
