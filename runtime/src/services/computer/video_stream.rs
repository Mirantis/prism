//! The whole virtual display as video for the page.
//!
//! `ffmpeg` grabs the X display and encodes it as H.264, which sends what changed rather
//! than a whole picture each time: a desktop with a cursor blinking in it costs a few dozen
//! bytes a frame, where a picture of the same desktop costs fifty kilobytes. The encoder is
//! asked to mark where each picture begins, so this forwards whole pictures without reading
//! any further into them (see `h264.rs`).
//!
//! The page is told the stream's name before the first picture, and again whenever the
//! encoder restarts, since a stream that starts over is a new stream to a decoder.

use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use indexmap::IndexMap;
use parking_lot::Mutex;

use super::child_process::{ChildHandle, Pipes, StopSignal, on_chunks, spawn_child};
use super::h264::{codec_from, is_keyframe, split_access_units};
use super::picture_stream::{FrameSink, PictureStream, ScreenFrame, StreamEncoding};
use crate::{log_error, log_warn};

const FRAMES_PER_SECOND: i64 = 30;
/// How hard the encoder works and how much it keeps.
///
/// `veryfast` costs less than encoding a JPEG of every frame did, and 23 keeps text on the
/// desktop sharp enough to read, which is most of what is on it.
const PRESET: &str = "veryfast";
const QUALITY: i64 = 23;
/// How often a picture that stands on its own goes out, in frames.
///
/// One client watches one stream from its start, so these are not needed to join. They are
/// what a client that fell behind comes back on, and each one costs about as much as a
/// whole JPEG, so they are rare.
const KEYFRAME_INTERVAL: i64 = 150;
/// A capture that has shown nothing by now is not going to; say so in the log.
const FIRST_FRAME_TIMEOUT_MS: u64 = 5_000;

struct StreamState {
    /// The geometry being grabbed, e.g. `1280x720`.
    size: String,
    /// The encoder; replaced on a resize.
    proc: Option<ChildHandle>,
    /// The bytes after the last whole picture.
    pending: Bytes,
    /// Pictures the encoder produced.
    frames_seen: u64,
    /// Whether the page has been told this encoder's name yet.
    announced: bool,
    /// The number of the first-frame timer that is armed, if one is.
    first_frame_timer: Option<u64>,
    next_timer: u64,
    stopped: bool,
}

pub struct VideoStream {
    /// This stream, for the tasks that read the encoder's output.
    me: Weak<VideoStream>,
    /// The X display, e.g. `:99`.
    display: String,
    on_frame: FrameSink,
    state: Mutex<StreamState>,
}

impl VideoStream {
    /// `display` is the X display, e.g. `:99`, and `size` its geometry, e.g. `1280x720`.
    pub fn new(display: String, size: String, on_frame: FrameSink) -> Arc<Self> {
        Arc::new_cyclic(|me| VideoStream {
            me: me.clone(),
            display,
            on_frame,
            state: Mutex::new(StreamState {
                size,
                proc: None,
                pending: Bytes::new(),
                frames_seen: 0,
                announced: false,
                first_frame_timer: None,
                next_timer: 1,
                stopped: false,
            }),
        })
    }

    fn spawn(&self) {
        let size = self.state.lock().size.clone();
        let args: Vec<String> = [
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-framerate",
            &FRAMES_PER_SECOND.to_string(),
            "-video_size",
            &size,
            "-i",
            &self.display,
            "-c:v",
            "libx264",
            "-preset",
            PRESET,
            // No frame waits for a later one, which is what a stream watched as it is made
            // needs; it also turns off the lookahead that would hold pictures back.
            "-tune",
            "zerolatency",
            "-crf",
            &QUALITY.to_string(),
            "-pix_fmt",
            "yuv420p",
            "-g",
            &KEYFRAME_INTERVAL.to_string(),
            // The delimiter in front of each picture, which is how they are told apart here.
            "-x264-params",
            "aud=1",
            "-f",
            "h264",
            "-",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        let env: IndexMap<String, String> = std::env::vars().collect();
        let spawned = spawn_child(
            "ffmpeg",
            &args,
            &env,
            Pipes {
                stdin: false,
                stdout: true,
                stderr: true,
            },
        );
        let (proc, pipes) = match spawned {
            Ok(spawned) => spawned,
            Err(err) => {
                self.fail(&format!("could not start ffmpeg: {err}"));
                return;
            }
        };
        let me = self.me.clone();
        on_chunks(pipes.stdout, move |chunk| {
            if let Some(stream) = me.upgrade() {
                stream.consume(Bytes::copy_from_slice(chunk));
            }
        });
        on_chunks(pipes.stderr, |chunk| {
            let text = String::from_utf8_lossy(chunk);
            let line = crate::support::js::trim(&text);
            if !line.is_empty() {
                log_warn!("[VoiceChat:Display] {}", line);
            }
        });
        let me = self.me.clone();
        let watched = proc.clone();
        tokio::spawn(async move {
            let exit = watched.wait().await;
            let Some(stream) = me.upgrade() else {
                return;
            };
            {
                let mut state = stream.state.lock();
                if !state.proc.as_ref().is_some_and(|proc| proc.same(&watched)) {
                    return;
                }
                state.proc = None;
            }
            stream.fail(&format!("ffmpeg exited ({})", exit.describe()));
        });
        self.state.lock().proc = Some(proc);
    }

    /// Split the byte stream into whole pictures and hand each one on.
    fn consume(&self, chunk: Bytes) {
        let mut frames = Vec::new();
        {
            let mut state = self.state.lock();
            state.pending = if state.pending.is_empty() {
                chunk
            } else {
                let mut joined = BytesMut::with_capacity(state.pending.len() + chunk.len());
                joined.extend_from_slice(&state.pending);
                joined.extend_from_slice(&chunk);
                joined.freeze()
            };
            let split = split_access_units(&state.pending);
            state.pending = split.rest;
            for unit in split.units {
                if state.frames_seen == 0 {
                    state.first_frame_timer = None;
                }
                state.frames_seen += 1;
                if !state.announced {
                    // The first picture carries the parameter sets, so this is where the
                    // name is.
                    let Some(codec) = codec_from(&unit) else {
                        continue;
                    };
                    state.announced = true;
                    frames.push(ScreenFrame::Start {
                        encoding: StreamEncoding::H264,
                        codec: Some(codec),
                    });
                }
                let keyframe = is_keyframe(&unit);
                frames.push(ScreenFrame::H264 {
                    data: unit,
                    keyframe,
                });
            }
        }
        for frame in frames {
            (self.on_frame)(frame);
        }
    }

    /// A capture that died or never showed a frame. Logged, since the page has no other
    /// source.
    fn fail(&self, reason: &str) {
        let frames_seen = {
            let mut state = self.state.lock();
            if state.stopped {
                return;
            }
            state.stopped = true;
            state.first_frame_timer = None;
            state.frames_seen
        };
        log_error!(
            "[VoiceChat] Display capture {}: {}",
            if frames_seen > 0 {
                "stopped"
            } else {
                "never produced a frame"
            },
            reason
        );
    }

}

#[async_trait]
impl PictureStream for VideoStream {
    fn start(&self) {
        let timer = {
            let mut state = self.state.lock();
            let timer = state.next_timer;
            state.next_timer += 1;
            state.first_frame_timer = Some(timer);
            timer
        };
        let me = self.me.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(FIRST_FRAME_TIMEOUT_MS)).await;
            let Some(stream) = me.upgrade() else {
                return;
            };
            if stream.state.lock().first_frame_timer != Some(timer) {
                return;
            }
            stream.fail(&format!("no frame within {FIRST_FRAME_TIMEOUT_MS}ms"));
        });
        self.spawn();
    }

    /// Grab a screen of a different size from here on.
    ///
    /// `x11grab` takes its size when it opens the display and holds it, and an encoder holds
    /// the size of the pictures it is making, so a screen that resized needs both again. The
    /// old process is dropped before it is killed, so its exit reads as this one's doing
    /// rather than as the capture dying.
    fn resize(&self, size: &str) {
        let old = {
            let mut state = self.state.lock();
            if state.size == size || state.stopped {
                return;
            }
            state.size = size.to_string();
            // Half a picture of the old size belongs to the encoder being replaced, and the
            // page has to be told the new one's name before it can decode anything from it.
            state.pending = Bytes::new();
            state.announced = false;
            state.proc.take()
        };
        if let Some(old) = old {
            old.kill(StopSignal::Term);
        }
        self.spawn();
    }

    async fn stop(&self) {
        let proc = {
            let mut state = self.state.lock();
            state.stopped = true;
            state.first_frame_timer = None;
            state.pending = Bytes::new();
            state.proc.take()
        };
        if let Some(proc) = proc {
            proc.kill(StopSignal::Term);
        }
    }
}
