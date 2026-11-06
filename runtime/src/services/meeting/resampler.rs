//! Sample-rate conversion between the meeting's audio and the Realtime API's.
//!
//! Meeting audio is captured/played at 48 kHz (what Chrome and PulseAudio speak);
//! the Realtime API's `audio/pcm` format is 24 kHz mono pcm16. Both directions are
//! a factor of exactly 2, so this is decimation/interpolation rather than general
//! resampling — but it still needs a low-pass, and that is the whole reason this
//! file exists. Dropping every other sample aliases everything above 12 kHz back
//! down into the speech band as a metallic warble; duplicating samples on the way
//! up puts a mirror image above 12 kHz that Opus then spends bits encoding.
//!
//! The filter is a windowed-sinc FIR applied at the 48 kHz side of each
//! conversion, cutting just under the 12 kHz Nyquist limit of the 24 kHz signal.
//! Written in plain Rust on purpose: a native resampler (libsamplerate, speex) would
//! be a compiled dependency for a fixed 2:1 ratio a 63-tap FIR handles fine.
//!
//! Both converters are stateful: `carry` holds the filter's tail from the previous
//! chunk so a continuous stream doesn't get a discontinuity at every buffer
//! boundary. One instance per stream direction, not shared.

use std::sync::LazyLock;

pub const MEETING_SAMPLE_RATE: u32 = 48000;
pub const REALTIME_SAMPLE_RATE: u32 = 24000;

/// Filter length.
///
/// 63 taps at 48 kHz is ~1.3 ms of group delay — still inaudible in a conversation —
/// and buys a materially steeper transition than the 33 taps this started with. That
/// matters on the upsampling leg, where a lazy filter leaves image energy just above
/// 12 kHz for Meet's Opus encoder to chew on, which reads as a thin, synthetic edge
/// on the voice. The cost is ~2x the multiplies on a path that is nowhere near being
/// the bottleneck.
const FILTER_TAPS: usize = 63;

/// Cutoff as a fraction of the 48 kHz sample rate. 0.24 (11.5 kHz) rather than a
/// textbook 0.25 (12 kHz): the transition band of a 33-tap filter is not a brick
/// wall, so backing the corner off slightly keeps the residual energy that lands
/// above Nyquist below the stopband floor.
const CUTOFF_RATIO: f64 = 0.24;

/// Blackman-windowed sinc, normalized to unity DC gain.
fn build_low_pass(taps: usize, cutoff_ratio: f64) -> Vec<f64> {
    let mut kernel = vec![0.0f64; taps];
    let mid = (taps as f64 - 1.0) / 2.0;
    let mut sum = 0.0;
    let pi = std::f64::consts::PI;

    for (i, slot) in kernel.iter_mut().enumerate() {
        let x = i as f64 - mid;
        // sinc(2·fc·x), with the removable singularity at x=0 filled in by its limit.
        let sinc = if x == 0.0 {
            2.0 * cutoff_ratio
        } else {
            (2.0 * pi * cutoff_ratio * x).sin() / (pi * x)
        };
        let window = 0.42 - 0.5 * ((2.0 * pi * i as f64) / (taps as f64 - 1.0)).cos()
            + 0.08 * ((4.0 * pi * i as f64) / (taps as f64 - 1.0)).cos();
        *slot = sinc * window;
        sum += *slot;
    }

    // Normalize so a constant input passes through at unity — otherwise the
    // window's DC gain would quietly scale (and clip) every conversion.
    for value in kernel.iter_mut() {
        *value /= sum;
    }
    kernel
}

static LOW_PASS: LazyLock<Vec<f64>> = LazyLock::new(|| build_low_pass(FILTER_TAPS, CUTOFF_RATIO));

/// `Math.round`: the nearest integer, halves toward positive infinity.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Clamp to the int16 range — the filter can overshoot on transients.
fn clamp_to_int16(value: f64) -> i16 {
    if value > 32767.0 {
        return 32767;
    }
    if value < -32768.0 {
        return -32768;
    }
    js_round(value) as i16
}

/// Read a little-endian pcm16 buffer as samples. Odd trailing byte is ignored.
fn to_samples(pcm: &[u8]) -> Vec<i16> {
    pcm.chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

/// Write samples back out as a little-endian pcm16 buffer.
fn to_buffer(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// The overlap-carry both directions need.
///
/// The filter needs `FILTER_TAPS - 1` samples of history to produce its first
/// output for a chunk, so each `process()` prepends the tail of the previous
/// chunk and keeps a fresh tail for the next one.
#[derive(Debug, Clone)]
struct FirResampler {
    carry: Vec<i16>,
}

impl FirResampler {
    fn new() -> Self {
        Self {
            carry: vec![0; FILTER_TAPS - 1],
        }
    }

    fn filter_and_decimate(&mut self, input: &[i16], step: usize) -> Vec<i16> {
        // History + this chunk, so every output sample sees a full filter window.
        let mut padded = Vec::with_capacity(self.carry.len() + input.len());
        padded.extend_from_slice(&self.carry);
        padded.extend_from_slice(input);

        let step_i = step as i64;
        let numerator = padded.len() as i64 - FILTER_TAPS as i64 + 1 + step_i - 1;
        let out_count = numerator.div_euclid(step_i);
        let out_len = out_count.max(0) as usize;
        let mut out = Vec::with_capacity(out_len);
        let low_pass = &*LOW_PASS;

        let mut i = 0usize;
        for _ in 0..out_len {
            let mut acc = 0.0f64;
            for (t, coefficient) in low_pass.iter().enumerate() {
                acc += padded[i + t] as f64 * coefficient;
            }
            out.push(clamp_to_int16(acc));
            i += step;
        }

        // Keep the last (FILTER_TAPS - 1) samples that the next chunk's first
        // windows need. Consumed input is everything the loop's windows fully
        // covered; the remainder becomes history.
        let consumed = out_count * step_i;
        let keep_from = consumed.max(padded.len() as i64 - (FILTER_TAPS as i64 - 1));
        let keep_from = if keep_from < 0 {
            // A negative start counts from the end, as `slice` does.
            (padded.len() as i64 + keep_from).max(0) as usize
        } else {
            (keep_from as usize).min(padded.len())
        };
        self.carry = padded[keep_from..].to_vec();
        // A short chunk can leave more than a full window of history; trim to the
        // filter length so the carry can't grow without bound.
        if self.carry.len() > FILTER_TAPS - 1 {
            self.carry = self.carry[self.carry.len() - (FILTER_TAPS - 1)..].to_vec();
        }

        out
    }

    /// Reset the filter history — call between independent streams.
    fn reset(&mut self) {
        self.carry = vec![0; FILTER_TAPS - 1];
    }
}

/// 48 kHz → 24 kHz: low-pass, then keep every second sample.
///
/// Used for meeting audio on its way to the Realtime API.
#[derive(Debug, Clone)]
pub struct Downsampler {
    fir: FirResampler,
}

impl Default for Downsampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Downsampler {
    pub fn new() -> Self {
        Self {
            fir: FirResampler::new(),
        }
    }

    pub fn process(&mut self, pcm48k: &[u8]) -> Vec<u8> {
        let out = self.fir.filter_and_decimate(&to_samples(pcm48k), 2);
        to_buffer(&out)
    }

    /// Reset the filter history — call between independent streams.
    pub fn reset(&mut self) {
        self.fir.reset();
    }
}

/// 24 kHz → 48 kHz: zero-stuff to 48 kHz, then low-pass to remove the image.
///
/// Used for the model's speech on its way into Chrome's virtual microphone.
/// Zero-stuffing halves the signal's power, so the interpolation gain of 2 is
/// applied to compensate — otherwise the bot would be 6 dB quieter than it should
/// be, which in a meeting reads as "nobody can hear the bot".
#[derive(Debug, Clone)]
pub struct Upsampler {
    fir: FirResampler,
}

impl Default for Upsampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Upsampler {
    pub fn new() -> Self {
        Self {
            fir: FirResampler::new(),
        }
    }

    pub fn process(&mut self, pcm24k: &[u8]) -> Vec<u8> {
        let input = to_samples(pcm24k);
        let mut stuffed = vec![0i16; input.len() * 2];
        for (i, sample) in input.iter().enumerate() {
            stuffed[i * 2] = *sample;
        }

        let filtered = self.fir.filter_and_decimate(&stuffed, 1);
        // Apply the interpolation gain on the filtered result.
        let gained: Vec<i16> = filtered
            .iter()
            .map(|sample| clamp_to_int16(*sample as f64 * 2.0))
            .collect();
        to_buffer(&gained)
    }

    /// Reset the filter history — call between independent streams.
    pub fn reset(&mut self) {
        self.fir.reset();
    }
}

/// Duration of a pcm16 mono buffer at the given rate, in milliseconds.
pub fn pcm16_duration_ms(pcm: &[u8], sample_rate: u32) -> f64 {
    pcm16_bytes_duration_ms(pcm.len(), sample_rate)
}

/// The same, for a byte count rather than the bytes.
///
/// Callers that track a queue's size rather than holding it as one buffer want
/// this: the playback loop asks how much audio is waiting on every tick, and
/// allocating seconds of zeroes just to measure them is work the hot path can do
/// without.
pub fn pcm16_bytes_duration_ms(bytes: usize, sample_rate: u32) -> f64 {
    (bytes as f64 / 2.0 / sample_rate as f64) * 1000.0
}

/// Byte count of `ms` of pcm16 mono audio at the given rate (even-aligned).
pub fn pcm16_bytes_for_ms(ms: f64, sample_rate: u32) -> i64 {
    js_round((ms / 1000.0) * sample_rate as f64) as i64 * 2
}
