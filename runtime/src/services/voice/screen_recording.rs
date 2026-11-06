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
use serde::{Deserialize, Serialize};

pub use crate::services::meeting::realtime_session::RecordingSegment;
use crate::services::meeting::resampler::{Downsampler, REALTIME_SAMPLE_RATE};

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
        todo!()
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
        let index = window_of((crate::support::now_ms() - started_at) as f64);
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
        todo!()
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
        todo!()
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
        todo!()
    }

    fn clear(&mut self) {
        self.started_at = None;
        self.audio = Vec::new();
        self.audio_bytes = 0;
        self.frames = Vec::new();
    }
}
