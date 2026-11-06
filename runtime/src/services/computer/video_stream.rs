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

use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use parking_lot::Mutex;
use tokio::process::Child;
use tokio::task::JoinHandle;

use super::picture_stream::{FrameSink, PictureStream};

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
    /// The encoder; replaced on a resize. Its number tells a replaced process's exit from
    /// the capture dying.
    proc: Option<(u64, Child)>,
    /// The bytes after the last whole picture.
    pending: Bytes,
    /// Pictures the encoder produced.
    frames_seen: u64,
    /// Whether the page has been told this encoder's name yet.
    announced: bool,
    first_frame_timer: Option<JoinHandle<()>>,
    stopped: bool,
    /// The number the next encoder process gets.
    next_proc: u64,
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
                stopped: false,
                next_proc: 0,
            }),
        })
    }

    fn spawn(&self) {
        todo!()
    }

    /// Split the byte stream into whole pictures and hand each one on.
    fn consume(&self, chunk: Bytes) {
        todo!()
    }

    /// A capture that died or never showed a frame. Logged, since the page has no other
    /// source.
    fn fail(&self, reason: &str) {
        todo!()
    }

    fn clear_first_frame_timer(&self) {
        todo!()
    }
}

#[async_trait]
impl PictureStream for VideoStream {
    fn start(&self) {
        todo!()
    }

    /// Grab a screen of a different size from here on.
    ///
    /// `x11grab` takes its size when it opens the display and holds it, and an encoder holds
    /// the size of the pictures it is making, so a screen that resized needs both again. The
    /// old process is dropped before it is killed, so its exit reads as this one's doing
    /// rather than as the capture dying.
    fn resize(&self, size: &str) {
        todo!()
    }

    async fn stop(&self) {
        todo!()
    }
}
