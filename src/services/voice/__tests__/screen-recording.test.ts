/**
 * A recording of the user's screen, from the frames the page sends to the items the model
 * is given.
 *
 * What is worth pinning is every cap — a page frame is untrusted input, and each of these
 * bounds something the runtime holds in memory for the length of a call — and the
 * grouping, which is the whole difference between a recording and a pile of pictures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

import { trackEvent } from '../../../lib/telemetry';
import { MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE } from '../../meeting/resampler';
import {
  formatOffset,
  MAX_RECORDING_FRAMES,
  MAX_RECORDING_MS,
  ScreenRecording,
} from '../screen-recording';

/** A picture the page kept, as it arrives: base64 with no data-URI prefix. */
const PICTURE = Buffer.from('a picture').toString('base64');

/** `ms` of pcm16 mono at the client's rate. */
function audio(ms: number, rate = MEETING_SAMPLE_RATE): Buffer {
  return Buffer.alloc(Math.round((ms / 1000) * rate) * 2);
}

function recording(clientSampleRate = MEETING_SAMPLE_RATE): ScreenRecording {
  return new ScreenRecording({ clientSampleRate, userId: 'user-1' });
}

describe('formatOffset', () => {
  it('reads as a place in the recording', () => {
    expect(formatOffset(0)).toBe('0:00');
    expect(formatOffset(7_400)).toBe('0:07');
    expect(formatOffset(90_000)).toBe('1:30');
  });
});

describe('ScreenRecording', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T08:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('takes the microphone only while one runs', () => {
    const rec = recording();
    expect(rec.pushAudio(audio(20))).toBe(false);

    rec.start();
    expect(rec.pushAudio(audio(20))).toBe(true);

    rec.stop('user', 1_000);
    expect(rec.pushAudio(audio(20))).toBe(false);
  });

  it('ignores a second start while one runs', () => {
    const rec = recording();
    expect(rec.start()).toBe(true);
    expect(rec.start()).toBe(false);
  });

  it('holds the audio at the model\'s rate rather than the client\'s', () => {
    const rec = recording(MEETING_SAMPLE_RATE);
    rec.start();
    rec.pushAudio(audio(1_000));
    rec.addFrame(PICTURE, 0);

    const result = rec.stop('user', 1_000);

    // A second of 48 kHz in, a second of 24 kHz out: half the bytes for the same sound.
    expect(result?.audioMs).toBeGreaterThan(900);
    expect(result?.audioMs).toBeLessThanOrEqual(1_000);
    expect(result?.segments[0].audio.length).toBeLessThanOrEqual(REALTIME_SAMPLE_RATE * 2);
  });

  it('passes the audio through when the client already speaks the model\'s rate', () => {
    const rec = recording(REALTIME_SAMPLE_RATE);
    rec.start();
    rec.pushAudio(audio(500, REALTIME_SAMPLE_RATE));

    const result = rec.stop('user', 500);

    expect(result?.segments[0].audio.length).toBe(audio(500, REALTIME_SAMPLE_RATE).length);
  });

  it('groups the pictures and the narration into the windows they happened in', () => {
    const rec = recording();
    rec.start();
    rec.pushAudio(audio(100));
    vi.setSystemTime(Date.now() + 40_000);
    rec.pushAudio(audio(100));
    rec.addFrame(PICTURE, 1_000);
    rec.addFrame(PICTURE, 45_000);

    const result = rec.stop('user', 50_000);

    expect(result?.segments.map((s) => s.label)).toEqual(['0:00', '0:30']);
    expect(result?.segments[0].images).toHaveLength(1);
    expect(result?.segments[1].images).toHaveLength(1);
    expect(result?.segments.every((s) => s.audio.length > 0)).toBe(true);
  });

  it('leaves out a window with nothing in it', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 0);
    rec.addFrame(PICTURE, 70_000);

    const result = rec.stop('user', 80_000);

    // Nothing was said and nothing changed in the middle half-minute, so no item is made
    // for it; the labels are what tell the model there is a gap.
    expect(result?.segments.map((s) => s.label)).toEqual(['0:00', '1:00']);
  });

  it('answers nothing for a recording with neither a picture nor a word in it', () => {
    const rec = recording();
    rec.start();

    expect(rec.stop('user', 400)).toBeNull();
    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith(
      'screen recording finished',
      'user-1',
      expect.objectContaining({ status: 'empty' }),
    );
  });

  it('takes no more pictures than reach the model', () => {
    const rec = recording();
    rec.start();
    for (let i = 0; i < MAX_RECORDING_FRAMES + 10; i++) rec.addFrame(PICTURE, i * 100);

    const result = rec.stop('user', 5_000);

    expect(result?.frames).toBe(MAX_RECORDING_FRAMES);
  });

  it('refuses a picture too large to be one', () => {
    const rec = recording();
    rec.start();
    rec.addFrame('x'.repeat(2 * 1024 * 1024), 0);
    rec.addFrame(PICTURE, 100);

    expect(rec.stop('user', 1_000)?.frames).toBe(1);
  });

  it('keeps no more audio than a recording is allowed to run', () => {
    const rec = recording(REALTIME_SAMPLE_RATE);
    rec.start();
    for (let i = 0; i < 7; i++) rec.pushAudio(audio(60_000, REALTIME_SAMPLE_RATE));

    const result = rec.stop('limit', MAX_RECORDING_MS + 60_000);

    expect(result?.audioMs).toBeLessThanOrEqual(MAX_RECORDING_MS);
    // The page's own figure is taken, but never past the limit it was told to stop at.
    expect(result?.ms).toBe(MAX_RECORDING_MS);
  });

  it('answers whether a cancel had a recording to throw away', () => {
    const rec = recording();

    // Nothing running, so nothing to tell the user's model about.
    expect(rec.cancel()).toBe(false);

    rec.start();
    expect(rec.cancel()).toBe(true);
    expect(rec.cancel()).toBe(false);
  });

  it('reports what it delivered, and throws away what a cancel held', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 0);
    rec.pushAudio(audio(200));
    rec.cancel();

    expect(vi.mocked(trackEvent)).toHaveBeenCalledWith(
      'screen recording finished',
      'user-1',
      expect.objectContaining({ status: 'cancelled' }),
    );

    rec.start();
    const result = rec.stop('share_ended', 1_000);
    expect(result).toBeNull();
  });
});
