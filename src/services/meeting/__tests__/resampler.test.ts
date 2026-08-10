import { describe, it, expect } from 'vitest';
import {
  Downsampler,
  Upsampler,
  MEETING_SAMPLE_RATE,
  REALTIME_SAMPLE_RATE,
  pcm16DurationMs,
  pcm16BytesForMs,
} from '../resampler';

/** Generate `ms` of a mono pcm16 sine wave at `freq` Hz. */
function tone(freq: number, ms: number, sampleRate: number, amplitude = 12000): Buffer {
  const samples = Math.round((ms / 1000) * sampleRate);
  const buf = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  return buf;
}

/** Peak absolute amplitude, ignoring the filter's start-up transient. */
function peak(pcm: Buffer, skipSamples = 64): number {
  let max = 0;
  for (let i = skipSamples * 2; i + 1 < pcm.length; i += 2) {
    max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  }
  return max;
}

/**
 * Estimate the energy at `freq` by correlating against a reference sine/cosine
 * pair (a single-bin Goertzel-style projection). Returned as an amplitude.
 */
function energyAt(pcm: Buffer, freq: number, sampleRate: number, skipSamples = 64): number {
  let re = 0;
  let im = 0;
  let n = 0;
  for (let i = skipSamples * 2; i + 1 < pcm.length; i += 2, n++) {
    const s = pcm.readInt16LE(i);
    const phase = (2 * Math.PI * freq * n) / sampleRate;
    re += s * Math.cos(phase);
    im += s * Math.sin(phase);
  }
  if (n === 0) return 0;
  return (2 * Math.sqrt(re * re + im * im)) / n;
}

describe('Downsampler (48k -> 24k)', () => {
  it('halves the sample count', () => {
    const input = tone(440, 100, MEETING_SAMPLE_RATE);
    const out = new Downsampler().process(input);
    // Within one filter window of exactly half — the first output needs a full
    // window of history, so the very first chunk is slightly short.
    expect(out.length / 2).toBeGreaterThan(input.length / 2 / 2 - 40);
    expect(out.length / 2).toBeLessThanOrEqual(input.length / 2 / 2);
  });

  it('preserves a speech-band tone at roughly unity gain', () => {
    const input = tone(1000, 200, MEETING_SAMPLE_RATE, 12000);
    const out = new Downsampler().process(input);
    const amplitude = energyAt(out, 1000, REALTIME_SAMPLE_RATE);
    expect(amplitude).toBeGreaterThan(12000 * 0.9);
    expect(amplitude).toBeLessThan(12000 * 1.1);
  });

  it('rejects content above the 24k Nyquist limit instead of aliasing it down', () => {
    // 18 kHz would alias to 6 kHz — squarely in the speech band — if the
    // low-pass were missing. This is the whole reason the filter exists.
    const input = tone(18000, 200, MEETING_SAMPLE_RATE, 12000);
    const out = new Downsampler().process(input);
    const aliasAmplitude = energyAt(out, 6000, REALTIME_SAMPLE_RATE);
    expect(aliasAmplitude).toBeLessThan(12000 * 0.02);
  });

  it('is continuous across chunk boundaries', () => {
    const whole = tone(1000, 200, MEETING_SAMPLE_RATE);
    const chunked = new Downsampler();
    const parts: Buffer[] = [];
    // Deliberately ragged chunk sizes (odd sample counts) to exercise the carry.
    for (let offset = 0; offset < whole.length; offset += 1234) {
      parts.push(chunked.process(whole.subarray(offset, Math.min(offset + 1234, whole.length))));
    }
    const streamed = Buffer.concat(parts);
    const oneShot = new Downsampler().process(whole);

    // Same length (the carry means no samples are lost at boundaries) and no
    // discontinuity spikes: a clean 1 kHz tone never exceeds its own amplitude.
    expect(Math.abs(streamed.length - oneShot.length)).toBeLessThanOrEqual(2);
    expect(peak(streamed)).toBeLessThan(13000);
    expect(energyAt(streamed, 1000, REALTIME_SAMPLE_RATE)).toBeGreaterThan(12000 * 0.9);
  });
});

describe('Upsampler (24k -> 48k)', () => {
  it('doubles the sample count', () => {
    const input = tone(440, 100, REALTIME_SAMPLE_RATE);
    const out = new Upsampler().process(input);
    expect(out.length / 2).toBeGreaterThan((input.length / 2) * 2 - 40);
    expect(out.length / 2).toBeLessThanOrEqual((input.length / 2) * 2);
  });

  it('preserves amplitude (interpolation gain compensates zero-stuffing)', () => {
    // Without the ×2 gain the bot would come through 6 dB too quiet.
    const input = tone(1000, 200, REALTIME_SAMPLE_RATE, 12000);
    const out = new Upsampler().process(input);
    const amplitude = energyAt(out, 1000, MEETING_SAMPLE_RATE);
    expect(amplitude).toBeGreaterThan(12000 * 0.85);
    expect(amplitude).toBeLessThan(12000 * 1.15);
  });

  it('suppresses the mirror image above Nyquist', () => {
    // Zero-stuffing a 3 kHz tone creates an image at 24k - 3k = 21 kHz.
    const input = tone(3000, 200, REALTIME_SAMPLE_RATE, 12000);
    const out = new Upsampler().process(input);
    expect(energyAt(out, 21000, MEETING_SAMPLE_RATE)).toBeLessThan(12000 * 0.05);
  });

  it('is continuous across chunk boundaries', () => {
    const whole = tone(1000, 200, REALTIME_SAMPLE_RATE);
    const chunked = new Upsampler();
    const parts: Buffer[] = [];
    for (let offset = 0; offset < whole.length; offset += 998) {
      parts.push(chunked.process(whole.subarray(offset, Math.min(offset + 998, whole.length))));
    }
    const streamed = Buffer.concat(parts);
    expect(peak(streamed)).toBeLessThan(14000);
    expect(energyAt(streamed, 1000, MEETING_SAMPLE_RATE)).toBeGreaterThan(12000 * 0.85);
  });
});

describe('round trip', () => {
  it('survives 48k -> 24k -> 48k with the speech band intact', () => {
    const input = tone(800, 300, MEETING_SAMPLE_RATE, 10000);
    const down = new Downsampler().process(input);
    const up = new Upsampler().process(down);
    expect(energyAt(up, 800, MEETING_SAMPLE_RATE)).toBeGreaterThan(10000 * 0.8);
  });
});

describe('duration helpers', () => {
  it('converts between bytes and milliseconds at 24k', () => {
    const oneSecond = pcm16BytesForMs(1000, REALTIME_SAMPLE_RATE);
    expect(oneSecond).toBe(REALTIME_SAMPLE_RATE * 2);
    expect(pcm16DurationMs(Buffer.alloc(oneSecond), REALTIME_SAMPLE_RATE)).toBe(1000);
  });

  it('reports a partial buffer proportionally', () => {
    expect(pcm16DurationMs(Buffer.alloc(REALTIME_SAMPLE_RATE), REALTIME_SAMPLE_RATE)).toBe(500);
  });
});
