/**
 * Playback is paced against a clock: it stays a fixed, small distance ahead of real
 * time. The two properties these tests pin down are the ones that broke in
 * production — audio must not be committed far ahead (or interruption is sluggish),
 * and a new response item must not discard the previous one (or the bot cuts itself
 * off mid-word when a tool result arrives).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioPlayback } from '../audio-playback';
import { MEETING_SAMPLE_RATE, pcm16BytesForMs } from '../resampler';

/** `ms` of silence at the meeting's rate. */
function audio(ms: number): Buffer {
  return Buffer.alloc(pcm16BytesForMs(ms, MEETING_SAMPLE_RATE));
}

function recordingSink() {
  const writes: Buffer[] = [];
  return {
    writes,
    totalMs: () => (writes.reduce((n, b) => n + b.length, 0) / 2 / MEETING_SAMPLE_RATE) * 1000,
    sink: { write: (c: Buffer) => void writes.push(c) },
  };
}

describe('AudioPlayback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hands over only a small lead, not the whole utterance', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    // Five seconds arrive at once, as the Realtime API really delivers them.
    playback.enqueue(audio(5000), 'item-1');

    // Committing all of it is what made interruption sluggish: a full pipe holds
    // most of a second of speech that cannot be recalled.
    expect(s.totalMs()).toBeLessThan(400);
    expect(s.totalMs()).toBeGreaterThan(0);
  });

  it('keeps feeding the device as time passes', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);
    playback.enqueue(audio(5000), 'item-1');

    vi.advanceTimersByTime(1000);
    const afterOneSecond = s.totalMs();
    // Roughly a second of audio plus the lead.
    expect(afterOneSecond).toBeGreaterThan(900);
    expect(afterOneSecond).toBeLessThan(1400);

    vi.advanceTimersByTime(1000);
    expect(s.totalMs()).toBeGreaterThan(afterOneSecond + 800);
  });

  it('catches up after a late tick instead of starving the device', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);
    playback.enqueue(audio(5000), 'item-1');

    // Simulates the event loop being blocked — a GC pause or a tool call. A fixed
    // amount-per-tick design under-delivers here and the device runs dry, which is
    // what produced the clicks and chopped syllables.
    vi.advanceTimersByTime(600);

    expect(s.totalMs()).toBeGreaterThan(600);
  });

  it('does NOT discard the previous item when a new one arrives', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    // The exact production bug: the model says "let me check that" (item-1), calls a
    // tool, and the follow-up response arrives as item-2. Discarding item-1 cut the
    // filler off mid-word and sounded like the bot interrupting itself.
    playback.enqueue(audio(500), 'item-1');
    playback.enqueue(audio(500), 'item-2');
    vi.advanceTimersByTime(2000);

    expect(s.totalMs()).toBeCloseTo(1000, 0);
  });

  it('reports played time measured from the clock', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);
    playback.enqueue(audio(3000), 'item-1');

    vi.advanceTimersByTime(1000);

    // Measured, not inferred from an assumed buffer depth: what the room heard is
    // what elapsed, and truncation has to be told that.
    expect(playback.currentPlayedMs).toBeGreaterThan(900);
    expect(playback.currentPlayedMs).toBeLessThan(1100);
  });

  it('never claims more was heard than was handed over', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);
    playback.enqueue(audio(200), 'item-1');

    vi.advanceTimersByTime(5000);

    expect(playback.currentPlayedMs).toBeLessThanOrEqual(200);
  });

  it('attributes played time to the audible item after a switch', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    playback.enqueue(audio(400), 'item-1');
    playback.enqueue(audio(2000), 'item-2');
    vi.advanceTimersByTime(1500);

    // Both items are reported: item-1 was heard in full, item-2 partially. Only
    // reporting the newest left the preamble's unheard tail in the model's context.
    const items = playback.flush();
    expect(items.map((i) => i.itemId)).toEqual(['item-1', 'item-2']);
    expect(items[0].playedMs).toBeCloseTo(400, 0);
    expect(items[1].playedMs).toBeGreaterThan(900);
    // `sentMs` accompanies each: the recommended truncation point is derived from
    // played *and* sent, so reporting only one would under-determine it.
    expect(items[0].sentMs).toBeCloseTo(400, 0);
    expect(items[1].sentMs).toBeGreaterThan(items[1].playedMs);
  });

  it('drops unplayed audio on flush and reports what was heard', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);
    playback.enqueue(audio(5000), 'item-1');
    vi.advanceTimersByTime(1000);
    const written = s.totalMs();

    const items = playback.flush();
    expect(items).toHaveLength(1);
    expect(items[0].itemId).toBe('item-1');
    expect(items[0].playedMs).toBeGreaterThan(900);

    vi.advanceTimersByTime(3000);
    // Nothing further reaches the meeting — barge-in has to actually stop it.
    expect(s.totalMs()).toBe(written);
    expect(playback.isSpeaking).toBe(false);
  });

  it('stops while paused and continues on resume', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);
    playback.enqueue(audio(5000), 'item-1');
    vi.advanceTimersByTime(300);

    playback.pause();
    const atPause = s.totalMs();
    vi.advanceTimersByTime(1000);
    expect(s.totalMs()).toBe(atPause);

    playback.resume();
    vi.advanceTimersByTime(500);
    expect(s.totalMs()).toBeGreaterThan(atPause);
  });

  it('plays an utterance shorter than the pre-roll rather than holding it forever', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    // Below the pre-roll and no more is coming: a deadline releases it, otherwise a
    // brief "mm-hm" from the bot would be silently swallowed.
    playback.enqueue(audio(40), 'item-1');
    expect(s.totalMs()).toBe(0);

    vi.advanceTimersByTime(400);
    expect(s.totalMs()).toBeCloseTo(40, 0);
  });

  it('counts itself as speaking while audio is still in the device', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    playback.enqueue(audio(1000), 'item-1');
    // Barge-in must work during the lead as well as while queued.
    expect(playback.isSpeaking).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(playback.isSpeaking).toBe(false);
  });

  it('does not burst after a gap between phrases', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    playback.enqueue(audio(300), 'item-1');
    vi.advanceTimersByTime(2000);
    s.writes.length = 0;

    // A long silence must not let the clock race ahead and dump the next phrase in
    // one go, which would undo the pacing entirely.
    playback.enqueue(audio(5000), 'item-2');
    expect(s.totalMs()).toBeLessThan(400);
  });

  it('reports never-played items so their transcript is truncated too', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    // item-2's audio arrived but never reached the device: nothing was heard, and
    // without a 0ms truncate its transcript would stay in the model's context.
    playback.enqueue(audio(3000), 'item-1');
    playback.enqueue(audio(500), 'item-2');
    const items = playback.flush();

    expect(items.map((i) => i.itemId)).toEqual(['item-1', 'item-2']);
    expect(items[1].playedMs).toBe(0);
  });

  it('survives a sink that throws', () => {
    const playback = new AudioPlayback({
      write: () => {
        throw new Error('pacat died');
      },
    });

    playback.enqueue(audio(500), 'item-1');
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(playback.isSpeaking).toBe(false);
  });

  it('ignores audio enqueued after dispose', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink);

    playback.dispose();
    playback.enqueue(audio(500), 'item-1');
    vi.advanceTimersByTime(1000);

    expect(s.totalMs()).toBe(0);
  });
});
