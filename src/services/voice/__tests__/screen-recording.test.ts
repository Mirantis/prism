/**
 * A recording of the user's screen, from the frames the page sends to the pictures the
 * model is given.
 *
 * What is worth pinning is every cap — a page frame is untrusted input, and each of these
 * bounds something the runtime holds in memory for the length of a call — and the
 * labels, which tell the model when each picture was taken.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

import { trackEvent } from '../../../lib/telemetry';
import {
  formatOffset,
  MAX_RECORDING_FRAMES,
  MAX_RECORDING_MS,
  ScreenRecording,
} from '../screen-recording';

/** A picture the page kept, as it arrives: base64 with no data-URI prefix. */
const PICTURE = Buffer.from('a picture').toString('base64');

function recording(): ScreenRecording {
  return new ScreenRecording({ userId: 'user-1' });
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

  it('ignores a second start while one runs', () => {
    const rec = recording();
    expect(rec.start()).toBe(true);
    expect(rec.start()).toBe(false);
  });

  it('groups the pictures into the windows they were taken in', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 1_000);
    rec.addFrame(PICTURE, 2_000);
    rec.addFrame(PICTURE, 45_000);

    const result = rec.stop('user', 50_000);

    expect(result?.segments).toEqual([
      { label: '0:00', images: [`data:image/jpeg;base64,${PICTURE}`, `data:image/jpeg;base64,${PICTURE}`] },
      { label: '0:30', images: [`data:image/jpeg;base64,${PICTURE}`] },
    ]);
  });

  it('keeps the windows in the order they happened, whatever order the page sent them in', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 65_000);
    rec.addFrame(PICTURE, 5_000);

    expect(rec.stop('user', 70_000)?.segments.map((s) => s.label)).toEqual(['0:00', '1:00']);
  });

  it('leaves out a window with nothing in it', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 0);
    rec.addFrame(PICTURE, 70_000);

    const result = rec.stop('user', 80_000);

    // Nothing changed in the middle half-minute, so no window is made for it; the labels
    // are what tell the model there is a gap.
    expect(result?.segments.map((s) => s.label)).toEqual(['0:00', '1:00']);
  });

  it('answers nothing for a recording with no picture in it', () => {
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

  it('refuses a huge offset, which would become a label no recording can have', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 0);
    rec.addFrame(PICTURE, 1e308);

    const result = rec.stop('user', 1_000);

    expect(result?.frames).toBe(1);
    expect(result?.segments).toHaveLength(1);
  });

  it('refuses an offset that is not a time at all', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 0);
    rec.addFrame(PICTURE, Number.POSITIVE_INFINITY);
    rec.addFrame(PICTURE, Number.NaN);
    rec.addFrame(PICTURE, -1);
    rec.addFrame(PICTURE, MAX_RECORDING_MS + 1);

    // Only the frame at zero survives; the rest name a time the recording cannot have.
    expect(rec.stop('user', 1_000)?.frames).toBe(1);
  });

  it('keeps a frame at the far end of what a recording may run', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, MAX_RECORDING_MS);

    expect(rec.stop('user', MAX_RECORDING_MS)?.frames).toBe(1);
  });

  it('refuses a picture too large to be one', () => {
    const rec = recording();
    rec.start();
    rec.addFrame('x'.repeat(2 * 1024 * 1024), 0);
    rec.addFrame(PICTURE, 100);

    expect(rec.stop('user', 1_000)?.frames).toBe(1);
  });

  it('reports no longer a run than a recording is allowed', () => {
    const rec = recording();
    rec.start();
    rec.addFrame(PICTURE, 0);

    const result = rec.stop('limit', MAX_RECORDING_MS + 60_000);

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
