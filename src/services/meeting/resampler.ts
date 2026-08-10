/**
 * Sample-rate conversion between the meeting's audio and the Realtime API's.
 *
 * Meeting audio is captured/played at 48 kHz (what Chrome and PulseAudio speak);
 * the Realtime API's `audio/pcm` format is 24 kHz mono pcm16. Both directions are
 * a factor of exactly 2, so this is decimation/interpolation rather than general
 * resampling — but it still needs a low-pass, and that is the whole reason this
 * file exists. Dropping every other sample aliases everything above 12 kHz back
 * down into the speech band as a metallic warble; duplicating samples on the way
 * up puts a mirror image above 12 kHz that Opus then spends bits encoding.
 *
 * The filter is a windowed-sinc FIR applied at the 48 kHz side of each
 * conversion, cutting just under the 12 kHz Nyquist limit of the 24 kHz signal.
 * Pure TypeScript on purpose: a native resampler (libsamplerate, speex) would be
 * a compiled dependency for a fixed 2:1 ratio a 33-tap FIR handles fine.
 *
 * Both converters are stateful: `carry` holds the filter's tail from the previous
 * chunk so a continuous stream doesn't get a discontinuity at every buffer
 * boundary. One instance per stream direction, not shared.
 */

export const MEETING_SAMPLE_RATE = 48000;
export const REALTIME_SAMPLE_RATE = 24000;

/**
 * Filter length. 33 taps at 48 kHz is ~0.7 ms of group delay — inaudible in a
 * conversation — and gives roughly 60 dB of stopband rejection with the Blackman
 * window below, which is well past what a voice codec preserves anyway.
 */
const FILTER_TAPS = 33;

/**
 * Cutoff as a fraction of the 48 kHz sample rate. 0.24 (11.5 kHz) rather than a
 * textbook 0.25 (12 kHz): the transition band of a 33-tap filter is not a brick
 * wall, so backing the corner off slightly keeps the residual energy that lands
 * above Nyquist below the stopband floor.
 */
const CUTOFF_RATIO = 0.24;

/** Blackman-windowed sinc, normalized to unity DC gain. */
function buildLowPass(taps: number, cutoffRatio: number): Float64Array {
  const kernel = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;

  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    // sinc(2·fc·x), with the removable singularity at x=0 filled in by its limit.
    const sinc = x === 0 ? 2 * cutoffRatio : Math.sin(2 * Math.PI * cutoffRatio * x) / (Math.PI * x);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }

  // Normalize so a constant input passes through at unity — otherwise the
  // window's DC gain would quietly scale (and clip) every conversion.
  for (let i = 0; i < taps; i++) kernel[i] /= sum;
  return kernel;
}

const LOW_PASS = buildLowPass(FILTER_TAPS, CUTOFF_RATIO);

/** Clamp to the int16 range — the filter can overshoot on transients. */
function clampToInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return Math.round(value);
}

/** Read a little-endian pcm16 buffer as samples. Odd trailing byte is ignored. */
function toSamples(pcm: Buffer): Int16Array {
  const count = Math.floor(pcm.length / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = pcm.readInt16LE(i * 2);
  return samples;
}

/** Write samples back out as a little-endian pcm16 buffer. */
function toBuffer(samples: Int16Array | number[], length: number): Buffer {
  const out = Buffer.allocUnsafe(length * 2);
  for (let i = 0; i < length; i++) out.writeInt16LE(samples[i], i * 2);
  return out;
}

/**
 * Base class holding the overlap-carry both directions need.
 *
 * The filter needs `FILTER_TAPS - 1` samples of history to produce its first
 * output for a chunk, so each `process()` prepends the tail of the previous
 * chunk and keeps a fresh tail for the next one.
 */
abstract class FirResampler {
  private carry: Int16Array = new Int16Array(FILTER_TAPS - 1);

  protected filterAndDecimate(input: Int16Array, step: number): Buffer {
    // History + this chunk, so every output sample sees a full filter window.
    const padded = new Int16Array(this.carry.length + input.length);
    padded.set(this.carry, 0);
    padded.set(input, this.carry.length);

    const outCount = Math.floor((padded.length - FILTER_TAPS + 1 + step - 1) / step);
    const out = new Int16Array(Math.max(outCount, 0));

    for (let o = 0, i = 0; o < outCount; o++, i += step) {
      let acc = 0;
      for (let t = 0; t < FILTER_TAPS; t++) acc += padded[i + t] * LOW_PASS[t];
      out[o] = clampToInt16(acc);
    }

    // Keep the last (FILTER_TAPS - 1) samples that the next chunk's first
    // windows need. Consumed input is everything the loop's windows fully
    // covered; the remainder becomes history.
    const consumed = outCount * step;
    const keepFrom = Math.max(consumed, padded.length - (FILTER_TAPS - 1));
    this.carry = padded.slice(keepFrom);
    // A short chunk can leave more than a full window of history; trim to the
    // filter length so the carry can't grow without bound.
    if (this.carry.length > FILTER_TAPS - 1) {
      this.carry = this.carry.slice(this.carry.length - (FILTER_TAPS - 1));
    }

    return toBuffer(out, out.length);
  }

  /** Reset the filter history — call between independent streams. */
  reset(): void {
    this.carry = new Int16Array(FILTER_TAPS - 1);
  }
}

/**
 * 48 kHz → 24 kHz: low-pass, then keep every second sample.
 *
 * Used for meeting audio on its way to the Realtime API.
 */
export class Downsampler extends FirResampler {
  process(pcm48k: Buffer): Buffer {
    return this.filterAndDecimate(toSamples(pcm48k), 2);
  }
}

/**
 * 24 kHz → 48 kHz: zero-stuff to 48 kHz, then low-pass to remove the image.
 *
 * Used for the model's speech on its way into Chrome's virtual microphone.
 * Zero-stuffing halves the signal's power, so the interpolation gain of 2 is
 * applied to compensate — otherwise the bot would be 6 dB quieter than it should
 * be, which in a meeting reads as "nobody can hear the bot".
 */
export class Upsampler extends FirResampler {
  process(pcm24k: Buffer): Buffer {
    const input = toSamples(pcm24k);
    const stuffed = new Int16Array(input.length * 2);
    for (let i = 0; i < input.length; i++) stuffed[i * 2] = input[i];

    const filtered = this.filterAndDecimate(stuffed, 1);
    // Apply the interpolation gain in place on the filtered result.
    for (let i = 0; i + 1 < filtered.length; i += 2) {
      filtered.writeInt16LE(clampToInt16(filtered.readInt16LE(i) * 2), i);
    }
    return filtered;
  }
}

/** Duration of a pcm16 mono buffer at the given rate, in milliseconds. */
export function pcm16DurationMs(pcm: Buffer, sampleRate: number): number {
  return (pcm.length / 2 / sampleRate) * 1000;
}

/** Byte count of `ms` of pcm16 mono audio at the given rate (even-aligned). */
export function pcm16BytesForMs(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate) * 2;
}
