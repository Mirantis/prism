import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioPlayback } from '../audio-playback';
import { MEETING_SAMPLE_RATE, pcm16BytesForMs } from '../resampler';

/** A sink that records every frame written to it. */
function recordingSink() {
  const writes: Buffer[] = [];
  return {
    writes,
    total: () => writes.reduce((n, b) => n + b.length, 0),
    sink: { write: (chunk: Buffer) => writes.push(chunk) },
  };
}

/** `ms` of silence at the meeting's rate. */
function audio(ms: number): Buffer {
  return Buffer.alloc(pcm16BytesForMs(ms, MEETING_SAMPLE_RATE));
}

describe('AudioPlayback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('meters audio out over time rather than dumping it at once', () => {
    const { sink, total } = recordingSink();
    const playback = new AudioPlayback(sink);

    playback.enqueue(audio(200), 'item-1');

    // One frame goes out immediately; the rest is paced.
    expect(total()).toBeLessThan(pcm16BytesForMs(40, MEETING_SAMPLE_RATE));
    vi.advanceTimersByTime(100);
    const midway = total();
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(pcm16BytesForMs(200, MEETING_SAMPLE_RATE));

    vi.advanceTimersByTime(200);
    expect(total()).toBe(pcm16BytesForMs(200, MEETING_SAMPLE_RATE));
  });

  it('tracks played milliseconds, not received milliseconds', () => {
    const { sink } = recordingSink();
    const playback = new AudioPlayback(sink);

    // A full second arrives instantly, as the Realtime API really delivers it.
    playback.enqueue(audio(1000), 'item-1');
    vi.advanceTimersByTime(100);

    // Truncating the model's context at 1000ms here would be a lie.
    expect(playback.currentPlayedMs).toBeGreaterThan(80);
    expect(playback.currentPlayedMs).toBeLessThan(140);
  });

  it('stops emitting while paused and continues on resume', () => {
    const { sink, total } = recordingSink();
    const playback = new AudioPlayback(sink);

    playback.enqueue(audio(200), 'item-1');
    vi.advanceTimersByTime(60);
    const atPause = total();
    playback.pause();
    vi.advanceTimersByTime(200);

    expect(total()).toBe(atPause);

    playback.resume();
    vi.advanceTimersByTime(200);
    expect(total()).toBeGreaterThan(atPause);
  });

  it('drops unplayed audio on flush and reports what was heard', () => {
    const { sink, total } = recordingSink();
    const playback = new AudioPlayback(sink);

    playback.enqueue(audio(1000), 'item-1');
    vi.advanceTimersByTime(100);
    const played = total();

    const result = playback.flush();

    expect(result.itemId).toBe('item-1');
    expect(result.playedMs).toBeGreaterThan(80);
    expect(result.playedMs).toBeLessThan(140);

    // Nothing more reaches the meeting — this is what makes barge-in instant.
    vi.advanceTimersByTime(1000);
    expect(total()).toBe(played);
    expect(playback.isSpeaking).toBe(false);
  });

  it('restarts the played-ms counter for a new utterance', () => {
    const { sink } = recordingSink();
    const playback = new AudioPlayback(sink);

    playback.enqueue(audio(200), 'item-1');
    vi.advanceTimersByTime(100);
    expect(playback.currentPlayedMs).toBeGreaterThan(0);

    playback.enqueue(audio(200), 'item-2');
    expect(playback.currentPlayedMs).toBe(0);
  });

  it('discards a previous utterance leftovers when a new one arrives', () => {
    const { sink, writes } = recordingSink();
    const playback = new AudioPlayback(sink);

    playback.enqueue(audio(1000), 'item-1');
    vi.advanceTimersByTime(40);
    writes.length = 0;

    // The new item must not play the old item's tail under its own identity.
    playback.enqueue(audio(40), 'item-2');
    vi.advanceTimersByTime(500);

    expect(writes.reduce((n, b) => n + b.length, 0)).toBe(pcm16BytesForMs(40, MEETING_SAMPLE_RATE));
  });

  it('splices across chunk boundaries into whole frames', () => {
    const { sink, writes } = recordingSink();
    const playback = new AudioPlayback(sink);

    // Ragged chunks smaller than one frame must still produce full frames.
    for (let i = 0; i < 10; i++) playback.enqueue(audio(7), 'item-1');
    vi.advanceTimersByTime(200);

    const frameBytes = pcm16BytesForMs(20, MEETING_SAMPLE_RATE);
    // Nothing is lost or duplicated by the splicing...
    expect(writes.reduce((n, b) => n + b.length, 0)).toBe(pcm16BytesForMs(70, MEETING_SAMPLE_RATE));
    // ...and no write exceeds a frame, so playback stays paced. (Writes may be
    // shorter than a frame: a tick emits whatever is queued, which is how the
    // first chunk starts speaking without waiting to fill a frame.)
    for (const w of writes) expect(w.length).toBeLessThanOrEqual(frameBytes);
    // Most frames are full — the splice combines the small chunks.
    expect(writes.filter((w) => w.length === frameBytes).length).toBeGreaterThan(1);
  });

  it('survives a sink that throws', () => {
    const playback = new AudioPlayback({
      write: () => {
        throw new Error('pacat died');
      },
    });

    playback.enqueue(audio(200), 'item-1');
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(playback.isSpeaking).toBe(false);
  });

  it('releases its timer on dispose', () => {
    const { sink, total } = recordingSink();
    const playback = new AudioPlayback(sink);

    playback.enqueue(audio(500), 'item-1');
    playback.dispose();
    const afterDispose = total();
    vi.advanceTimersByTime(1000);

    expect(total()).toBe(afterDispose);
  });
});
