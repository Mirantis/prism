//! A recording of the user's own screen, with the words they said over it.
//!
//! It belongs to the voice call the Computer page started, not to the desktop that page
//! shows: the microphone it takes is the call's, and the model it is handed to is the
//! call's. The desktop outlives any one call, so a recording cannot live there.
//!
//! The page samples the screen it is sharing and hands over the pictures it kept when the
//! recording stops. The microphone the call already carries is diverted here while one
//! runs, so the model hears the narration once, at the end, instead of answering over the
//! demonstration and then being told the same thing again.
//!
//! The result is grouped into windows of a fixed length, each holding the pictures taken
//! in it and the audio recorded over them. That grouping is what a recording has and a
//! shared screen does not: which words go with which picture.
//!
//! Nothing is written to disk. A recording lives for the call it was made in, as the rest
//! of a voice chat does.

use std::collections::BTreeMap;

use bytes::{Bytes, BytesMut};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::lib::telemetry::track_event;
use crate::log_info;
use crate::services::meeting::audio_playback::clock_ms;
use crate::services::meeting::resampler::pcm16_bytes_duration_ms;

pub use crate::services::meeting::realtime_session::RecordingSegment;
use crate::services::meeting::resampler::{Downsampler, REALTIME_SAMPLE_RATE};
use crate::support::js::round as js_round;

/// The longest recording the runtime keeps. The page stops itself at the same figure.
pub const MAX_RECORDING_MS: i64 = 5 * 60_000;
/// How many pictures reach the model. The page selects which ones; this is the ceiling.
pub const MAX_RECORDING_FRAMES: usize = 24;
/// A picture larger than this is refused; a 1280-wide JPEG is an order of magnitude smaller.
const MAX_FRAME_CHARS: usize = 1024 * 1024;
/// How much of the recording goes in one conversation item.
const WINDOW_MS: i64 = 30_000;

/// The audio the recording keeps, in bytes: its whole length at the model's own rate.
const MAX_AUDIO_BYTES: usize =
    (MAX_RECORDING_MS as usize / 1000) * REALTIME_SAMPLE_RATE as usize * 2;

/// Why a recording ended, as the page reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingEndReason {
    User,
    Limit,
    ShareEnded,
}

impl RecordingEndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordingEndReason::User => "user",
            RecordingEndReason::Limit => "limit",
            RecordingEndReason::ShareEnded => "share_ended",
        }
    }
}

/// A finished recording, ready to put in front of the model.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordingResult {
    pub segments: Vec<RecordingSegment>,
    /// How long the recording ran, by the page's clock.
    pub ms: f64,
    pub frames: usize,
    pub audio_ms: i64,
    pub reason: RecordingEndReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenRecordingOptions {
    /// The rate the client's audio arrives at. The recording is kept at the model's.
    pub client_sample_rate: u32,
    /// Who is recording, for the two lifecycle events.
    pub user_id: String,
}

/// `0:07`, `1:30` — the offset a segment is labelled with.
pub fn format_offset(ms: f64) -> String {
    let total = (ms / 1000.0).floor().max(0.0) as i64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// The window an offset falls in.
fn window_of(ms: f64) -> usize {
    (ms / WINDOW_MS as f64).floor().max(0.0) as usize
}

/// How a recording ended, as the `screen recording finished` event reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecordingStatus {
    Delivered,
    Empty,
    Cancelled,
}

impl RecordingStatus {
    fn as_str(self) -> &'static str {
        match self {
            RecordingStatus::Delivered => "delivered",
            RecordingStatus::Empty => "empty",
            RecordingStatus::Cancelled => "cancelled",
        }
    }
}

pub struct ScreenRecording {
    options: ScreenRecordingOptions,
    /// Epoch ms.
    started_at: Option<i64>,
    /// Audio per window, at the model's rate, in arrival order.
    audio: Vec<Vec<Bytes>>,
    audio_bytes: usize,
    /// Pictures as the page sent them, with the offset each was taken at.
    frames: Vec<(String, f64)>,
    /// The client's rate is 48 kHz on the page that records, and the model's is 24 kHz, so
    /// the audio is converted as it arrives rather than at the end: a recording then holds
    /// what it will send, at half the bytes.
    downsampler: Option<Downsampler>,
}

impl ScreenRecording {
    pub fn new(options: ScreenRecordingOptions) -> Self {
        let downsampler = if options.client_sample_rate == REALTIME_SAMPLE_RATE {
            None
        } else {
            Some(Downsampler::new())
        };
        Self {
            options,
            started_at: None,
            audio: Vec::new(),
            audio_bytes: 0,
            frames: Vec::new(),
            downsampler,
        }
    }

    /// Begin. A second start while one runs is the page repeating itself, and is ignored.
    ///
    /// Logs `[VoiceChat] The user is recording their screen` and emits
    /// `screen recording started`.
    pub fn start(&mut self) -> bool {
        if self.started_at.is_some() {
            return false;
        }
        self.started_at = Some(clock_ms());
        self.audio = Vec::new();
        self.audio_bytes = 0;
        self.frames = Vec::new();
        if let Some(downsampler) = self.downsampler.as_mut() {
            downsampler.reset();
        }
        log_info!("[VoiceChat] The user is recording their screen");
        track_event(
            "screen recording started",
            Some(&self.options.user_id),
            None,
        );
        true
    }

    /// Take a frame of the client's audio. Answers whether the recording took it, which is
    /// what keeps the same frame from also reaching the model live.
    pub fn push_audio(&mut self, pcm: &[u8]) -> bool {
        let Some(started_at) = self.started_at else {
            return false;
        };
        if self.audio_bytes >= MAX_AUDIO_BYTES {
            return true;
        }
        let converted = match self.downsampler.as_mut() {
            Some(downsampler) => Bytes::from(downsampler.process(pcm)),
            None => Bytes::copy_from_slice(pcm),
        };
        if converted.is_empty() {
            return true;
        }
        // Timed here while the pictures are timed in the page, a round trip apart. Windows
        // are half a minute, so the two agree on which one a moment belongs to.
        let index = window_of((clock_ms() - started_at) as f64);
        if self.audio.len() <= index {
            self.audio.resize_with(index + 1, Vec::new);
        }
        self.audio_bytes += converted.len();
        self.audio[index].push(converted);
        true
    }

    /// A picture the page kept, with the offset it was taken at.
    ///
    /// The offset is the page's claim rather than a fact, and it decides how many windows
    /// `build_segments` walks: a frame claiming 1e308 milliseconds would hold the runtime in
    /// that loop for the rest of the process. One outside the length a recording may run is
    /// refused rather than clamped, since clamping would file the picture under a time it
    /// was not taken at.
    pub fn add_frame(&mut self, data: &str, at: f64) {
        if self.started_at.is_none() {
            return;
        }
        if self.frames.len() >= MAX_RECORDING_FRAMES {
            return;
        }
        let length = crate::support::js::len16(data);
        if length == 0 || length > MAX_FRAME_CHARS {
            return;
        }
        if !at.is_finite() || at < 0.0 || at > MAX_RECORDING_MS as f64 {
            return;
        }
        self.frames
            .push((format!("data:image/jpeg;base64,{data}"), at));
    }

    /// Throw away what is held. Nobody is left to hand it to, so it carries no reason.
    ///
    /// Answers whether a recording was running, so a caller can tell the user's model about
    /// the one that will not arrive without announcing a recording nobody made.
    pub fn cancel(&mut self) -> bool {
        let Some(started_at) = self.started_at else {
            return false;
        };
        self.finish_event(
            RecordingStatus::Cancelled,
            None,
            (clock_ms() - started_at) as f64,
            &[],
        );
        self.clear();
        true
    }

    /// End the recording and answer what to put in front of the model.
    ///
    /// `None` when there is nothing in it — a recording so short that no picture was kept and
    /// nothing was said. The caller tells the user rather than asking the model to talk
    /// about an empty one.
    ///
    /// The length is the page's own figure when it is a positive number, since it holds the
    /// clock the pictures are stamped against, and the runtime's otherwise, capped at
    /// `MAX_RECORDING_MS`. Logs
    /// `[VoiceChat] Recording ended after {offset} ({reason}): {frames} pictures, {seconds}s of narration`.
    pub fn stop(&mut self, reason: RecordingEndReason, ms: f64) -> Option<RecordingResult> {
        let started_at = self.started_at?;
        // The page's own figure, since it holds the clock the pictures are stamped against.
        let reported = if ms.is_finite() && ms > 0.0 {
            ms
        } else {
            (clock_ms() - started_at) as f64
        };
        let ran = reported.min(MAX_RECORDING_MS as f64);
        let segments = self.build_segments();
        let frames = self.frames.len();
        let audio_ms = js_round(pcm16_bytes_duration_ms(
            self.audio_bytes,
            REALTIME_SAMPLE_RATE,
        )) as i64;
        self.finish_event(
            if segments.is_empty() {
                RecordingStatus::Empty
            } else {
                RecordingStatus::Delivered
            },
            Some(reason),
            ran,
            &[
                ("frames", frames.to_string()),
                ("audio_ms", audio_ms.to_string()),
                ("segments", segments.len().to_string()),
            ],
        );
        self.clear();
        log_info!(
            "[VoiceChat] Recording ended after {} ({}): {} pictures, {}s of narration",
            format_offset(ran),
            reason.as_str(),
            frames,
            js_round(audio_ms as f64 / 1000.0) as i64
        );
        if segments.is_empty() {
            return None;
        }
        Some(RecordingResult {
            segments,
            ms: ran,
            frames,
            audio_ms,
            reason,
        })
    }

    /// The windows, oldest first, with the empty ones left out.
    fn build_segments(&self) -> Vec<RecordingSegment> {
        let mut by_window: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for (image, at) in &self.frames {
            by_window
                .entry(window_of(*at))
                .or_default()
                .push(image.clone());
        }

        let last_frame_window = by_window.keys().next_back().copied().unwrap_or(0);
        let last = self.audio.len().saturating_sub(1).max(last_frame_window);
        let mut segments = Vec::new();
        for index in 0..=last {
            let images = by_window.get(&index).cloned().unwrap_or_default();
            let mut audio = BytesMut::new();
            for chunk in self.audio.get(index).map(Vec::as_slice).unwrap_or(&[]) {
                audio.extend_from_slice(chunk);
            }
            if images.is_empty() && audio.is_empty() {
                continue;
            }
            segments.push(RecordingSegment {
                label: format_offset((index as i64 * WINDOW_MS) as f64),
                images,
                audio: audio.freeze(),
            });
        }
        segments
    }

    /// Emit `screen recording finished` with the status, the reason when there is one, the
    /// rounded duration in ms and `extra`.
    fn finish_event(
        &self,
        status: RecordingStatus,
        reason: Option<RecordingEndReason>,
        ms: f64,
        extra: &[(&str, String)],
    ) {
        let mut props = IndexMap::new();
        props.insert("status".to_string(), status.as_str().to_string());
        if let Some(reason) = reason {
            props.insert("reason".to_string(), reason.as_str().to_string());
        }
        props.insert("duration_ms".to_string(), (js_round(ms) as i64).to_string());
        for (key, value) in extra {
            props.insert(key.to_string(), value.clone());
        }
        track_event(
            "screen recording finished",
            Some(&self.options.user_id),
            Some(props),
        );
    }

    fn clear(&mut self) {
        self.started_at = None;
        self.audio = Vec::new();
        self.audio_bytes = 0;
        self.frames = Vec::new();
    }
}

/// A recording of the user's screen, from the frames the page sends to the items the model
/// is given.
///
/// What is worth pinning is every cap — a page frame is untrusted input, and each of these
/// bounds something the runtime holds in memory for the length of a call — and the
/// grouping, which is the whole difference between a recording and a pile of pictures.
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use base64::Engine;

    use super::*;
    use crate::services::meeting::resampler::MEETING_SAMPLE_RATE;

    /// A picture the page kept, as it arrives: base64 with no data-URI prefix.
    fn picture() -> String {
        base64::engine::general_purpose::STANDARD.encode("a picture")
    }

    /// `ms` of pcm16 mono at `rate`.
    fn audio_at(ms: f64, rate: u32) -> Vec<u8> {
        vec![0u8; ((ms / 1000.0) * rate as f64).round() as usize * 2]
    }

    fn audio(ms: f64) -> Vec<u8> {
        audio_at(ms, MEETING_SAMPLE_RATE)
    }

    fn recording_at(rate: u32) -> ScreenRecording {
        ScreenRecording::new(ScreenRecordingOptions {
            client_sample_rate: rate,
            user_id: "user-1".into(),
        })
    }

    fn recording() -> ScreenRecording {
        recording_at(MEETING_SAMPLE_RATE)
    }

    #[test]
    fn formats_an_offset_as_a_place_in_the_recording() {
        assert_eq!(format_offset(0.0), "0:00");
        assert_eq!(format_offset(7_400.0), "0:07");
        assert_eq!(format_offset(90_000.0), "1:30");
    }

    #[tokio::test(start_paused = true)]
    async fn takes_the_microphone_only_while_one_runs() {
        let mut rec = recording();
        assert!(!rec.push_audio(&audio(20.0)));
        rec.start();
        assert!(rec.push_audio(&audio(20.0)));
        rec.stop(RecordingEndReason::User, 1_000.0);
        assert!(!rec.push_audio(&audio(20.0)));
    }

    #[tokio::test(start_paused = true)]
    async fn ignores_a_second_start_while_one_runs() {
        let mut rec = recording();
        assert!(rec.start());
        assert!(!rec.start());
    }

    #[tokio::test(start_paused = true)]
    async fn holds_the_audio_at_the_models_rate_rather_than_the_clients() {
        let mut rec = recording_at(MEETING_SAMPLE_RATE);
        rec.start();
        rec.push_audio(&audio(1_000.0));
        rec.add_frame(&picture(), 0.0);
        let result = rec.stop(RecordingEndReason::User, 1_000.0).unwrap();
        assert!(result.audio_ms > 900);
        assert!(result.audio_ms <= 1_000);
        assert!(result.segments[0].audio.len() <= REALTIME_SAMPLE_RATE as usize * 2);
    }

    #[tokio::test(start_paused = true)]
    async fn passes_the_audio_through_when_the_client_already_speaks_the_models_rate() {
        let mut rec = recording_at(REALTIME_SAMPLE_RATE);
        rec.start();
        rec.push_audio(&audio_at(500.0, REALTIME_SAMPLE_RATE));
        let result = rec.stop(RecordingEndReason::User, 500.0).unwrap();
        assert_eq!(
            result.segments[0].audio.len(),
            audio_at(500.0, REALTIME_SAMPLE_RATE).len()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn groups_the_pictures_and_the_narration_into_the_windows_they_happened_in() {
        let mut rec = recording();
        rec.start();
        rec.push_audio(&audio(100.0));
        tokio::time::advance(Duration::from_millis(40_000)).await;
        rec.push_audio(&audio(100.0));
        rec.add_frame(&picture(), 1_000.0);
        rec.add_frame(&picture(), 45_000.0);
        let result = rec.stop(RecordingEndReason::User, 50_000.0).unwrap();
        assert_eq!(
            result
                .segments
                .iter()
                .map(|s| s.label.as_str())
                .collect::<Vec<_>>(),
            vec!["0:00", "0:30"]
        );
        assert_eq!(result.segments[0].images.len(), 1);
        assert_eq!(result.segments[1].images.len(), 1);
        assert!(result.segments.iter().all(|s| !s.audio.is_empty()));
        assert!(result.segments[0].images[0].starts_with("data:image/jpeg;base64,"));
    }

    #[tokio::test(start_paused = true)]
    async fn leaves_out_a_window_with_nothing_in_it() {
        let mut rec = recording();
        rec.start();
        rec.add_frame(&picture(), 0.0);
        rec.add_frame(&picture(), 70_000.0);
        let result = rec.stop(RecordingEndReason::User, 80_000.0).unwrap();
        assert_eq!(
            result
                .segments
                .iter()
                .map(|s| s.label.as_str())
                .collect::<Vec<_>>(),
            vec!["0:00", "1:00"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn answers_nothing_for_a_recording_with_neither_a_picture_nor_a_word_in_it() {
        let mut rec = recording();
        rec.start();
        assert!(rec.stop(RecordingEndReason::User, 400.0).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn takes_no_more_pictures_than_reach_the_model() {
        let mut rec = recording();
        rec.start();
        for i in 0..MAX_RECORDING_FRAMES + 10 {
            rec.add_frame(&picture(), (i * 100) as f64);
        }
        let result = rec.stop(RecordingEndReason::User, 5_000.0).unwrap();
        assert_eq!(result.frames, MAX_RECORDING_FRAMES);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_huge_offset_so_stopping_cannot_walk_to_it() {
        let mut rec = recording();
        rec.start();
        rec.add_frame(&picture(), 0.0);
        rec.add_frame(&picture(), 1e308);
        let result = rec.stop(RecordingEndReason::User, 1_000.0).unwrap();
        assert_eq!(result.frames, 1);
        assert_eq!(result.segments.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_an_offset_that_is_not_a_time_at_all() {
        let mut rec = recording();
        rec.start();
        rec.add_frame(&picture(), 0.0);
        rec.add_frame(&picture(), f64::INFINITY);
        rec.add_frame(&picture(), f64::NAN);
        rec.add_frame(&picture(), -1.0);
        rec.add_frame(&picture(), MAX_RECORDING_MS as f64 + 1.0);
        assert_eq!(
            rec.stop(RecordingEndReason::User, 1_000.0).unwrap().frames,
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_a_frame_at_the_far_end_of_what_a_recording_may_run() {
        let mut rec = recording();
        rec.start();
        rec.add_frame(&picture(), MAX_RECORDING_MS as f64);
        assert_eq!(
            rec.stop(RecordingEndReason::User, MAX_RECORDING_MS as f64)
                .unwrap()
                .frames,
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_picture_too_large_to_be_one() {
        let mut rec = recording();
        rec.start();
        rec.add_frame(&"x".repeat(2 * 1024 * 1024), 0.0);
        rec.add_frame(&picture(), 100.0);
        assert_eq!(
            rec.stop(RecordingEndReason::User, 1_000.0).unwrap().frames,
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_no_more_audio_than_a_recording_is_allowed_to_run() {
        let mut rec = recording_at(REALTIME_SAMPLE_RATE);
        rec.start();
        for _ in 0..7 {
            rec.push_audio(&audio_at(60_000.0, REALTIME_SAMPLE_RATE));
        }
        let result = rec
            .stop(
                RecordingEndReason::Limit,
                MAX_RECORDING_MS as f64 + 60_000.0,
            )
            .unwrap();
        assert!(result.audio_ms <= MAX_RECORDING_MS);
        // The page's own figure is taken, but never past the limit it was told to stop at.
        assert_eq!(result.ms, MAX_RECORDING_MS as f64);
    }

    #[tokio::test(start_paused = true)]
    async fn answers_whether_a_cancel_had_a_recording_to_throw_away() {
        let mut rec = recording();
        assert!(!rec.cancel());
        rec.start();
        assert!(rec.cancel());
        assert!(!rec.cancel());
    }

    #[tokio::test(start_paused = true)]
    async fn throws_away_what_a_cancel_held() {
        let mut rec = recording();
        rec.start();
        rec.add_frame(&picture(), 0.0);
        rec.push_audio(&audio(200.0));
        rec.cancel();
        rec.start();
        assert!(rec.stop(RecordingEndReason::ShareEnded, 1_000.0).is_none());
    }
}
