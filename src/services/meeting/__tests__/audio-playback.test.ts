/**
 * Playback is paced against a clock: it stays a fixed, small distance ahead of real
 * time. Audio must not be committed far ahead, or dropping it on an interruption comes
 * too late, and a jittery event loop must not starve the device.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioPlayback } from '../audio-playback';
import { MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE, pcm16BytesForMs } from '../resampler';

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
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);

    // Five seconds arrive at once.
    playback.enqueue(audio(5000));

    // Committing all of it is what made interruption sluggish: a full pipe holds
    // most of a second of speech that cannot be recalled.
    expect(s.totalMs()).toBeLessThan(400);
    expect(s.totalMs()).toBeGreaterThan(0);
  });

  it('keeps feeding the device as time passes', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);
    playback.enqueue(audio(5000));

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
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);
    playback.enqueue(audio(5000));

    // Simulates the event loop being blocked — a GC pause or a tool call. A fixed
    // amount-per-tick design under-delivers here and the device runs dry, which is
    // what produced the clicks and chopped syllables.
    vi.advanceTimersByTime(600);

    expect(s.totalMs()).toBeGreaterThan(600);
  });

  it('drops unplayed audio on flush', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);
    playback.enqueue(audio(5000));
    vi.advanceTimersByTime(1000);
    const written = s.totalMs();

    playback.flush();

    vi.advanceTimersByTime(3000);
    // Nothing further reaches the call — a flush has to actually stop it.
    expect(s.totalMs()).toBe(written);
  });

  it('plays audio queued one piece after another, in order', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);

    playback.enqueue(audio(500));
    playback.enqueue(audio(500));
    vi.advanceTimersByTime(2000);

    expect(s.totalMs()).toBeCloseTo(1000, 0);
  });

  it('plays an utterance shorter than the pre-roll rather than holding it forever', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);

    // Below the pre-roll and no more is coming: a deadline releases it, otherwise a
    // brief "mm-hm" from the bot would be silently swallowed.
    playback.enqueue(audio(40));
    expect(s.totalMs()).toBe(0);

    vi.advanceTimersByTime(400);
    expect(s.totalMs()).toBeCloseTo(40, 0);
  });

  it('does not burst after a gap between phrases', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);

    playback.enqueue(audio(300));
    vi.advanceTimersByTime(2000);
    s.writes.length = 0;

    // A long silence must not let the clock race ahead and dump the next phrase in
    // one go, which would undo the pacing entirely.
    playback.enqueue(audio(5000));
    expect(s.totalMs()).toBeLessThan(400);
  });

  describe('the sink it was given', () => {
    it('paces by the rate it was told, not by a fixed one', () => {
      // The same wall time at half the rate is half the bytes. A wrong rate is
      // silent otherwise: the device starves or runs over.
      const fast = recordingSink();
      const slow = recordingSink();
      const at48 = new AudioPlayback(fast.sink, MEETING_SAMPLE_RATE);
      const at24 = new AudioPlayback(slow.sink, REALTIME_SAMPLE_RATE);

      at48.enqueue(Buffer.alloc(pcm16BytesForMs(1000, MEETING_SAMPLE_RATE)));
      at24.enqueue(Buffer.alloc(pcm16BytesForMs(1000, REALTIME_SAMPLE_RATE)));
      vi.advanceTimersByTime(500);

      const bytesAt48 = fast.writes.reduce((n, b) => n + b.length, 0);
      const bytesAt24 = slow.writes.reduce((n, b) => n + b.length, 0);
      expect(bytesAt48).toBeGreaterThan(0);
      expect(bytesAt24).toBeCloseTo(bytesAt48 / 2, -2);
    });

    it('tells a sink that holds a queue to drop it on a flush', () => {
      // The case this exists for: a sink writing to a client across a network has
      // everything already written sitting in that client's buffer, so without
      // this the agent keeps talking after it was told to stop.
      const cleared = vi.fn();
      const playback = new AudioPlayback(
        { write: () => {}, clear: cleared },
        MEETING_SAMPLE_RATE,
      );

      playback.enqueue(audio(1000));
      vi.advanceTimersByTime(200);
      playback.flush();

      expect(cleared).toHaveBeenCalledTimes(1);
    });

    it('clears on dispose as well, so a torn-down call leaves nothing playing', () => {
      const cleared = vi.fn();
      const playback = new AudioPlayback({ write: () => {}, clear: cleared }, MEETING_SAMPLE_RATE);
      playback.enqueue(audio(200));
      playback.dispose();
      expect(cleared).toHaveBeenCalledTimes(1);
    });

    it('asks nothing of a sink that plays what it is given', () => {
      // `pacat` has no queue to drop, so it implements none of this and must not
      // be required to.
      const playback = new AudioPlayback({ write: () => {} }, MEETING_SAMPLE_RATE);
      playback.enqueue(audio(200));
      expect(() => playback.flush()).not.toThrow();
      expect(() => playback.dispose()).not.toThrow();
    });

    it('finishes a flush even when clearing fails', () => {
      const playback = new AudioPlayback(
        {
          write: () => {},
          clear: () => {
            throw new Error('the socket went away');
          },
        },
        MEETING_SAMPLE_RATE,
      );
      playback.enqueue(audio(1000));
      vi.advanceTimersByTime(200);
      expect(() => playback.flush()).not.toThrow();
    });
  });

  it('survives a sink that throws', () => {
    const playback = new AudioPlayback(
      {
        write: () => {
          throw new Error('pacat died');
        },
      },
      MEETING_SAMPLE_RATE,
    );

    playback.enqueue(audio(500));
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
  });

  it('ignores audio enqueued after dispose', () => {
    const s = recordingSink();
    const playback = new AudioPlayback(s.sink, MEETING_SAMPLE_RATE);

    playback.dispose();
    playback.enqueue(audio(500));
    vi.advanceTimersByTime(1000);

    expect(s.totalMs()).toBe(0);
  });
});
