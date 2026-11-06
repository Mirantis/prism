//! A source of the agent's screen, for the page.
//!
//! Two implementations, and they differ in what they can produce. Where the runtime owns
//! the display it encodes the whole screen as video, because a desktop that changes in one
//! corner costs almost nothing that way. Where the browser runs on the host's own display
//! the source is Chromium's debugger, which produces one picture at a time.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};

/// How the pictures of a stream are encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamEncoding {
    Jpeg,
    H264,
}

impl StreamEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            StreamEncoding::Jpeg => "jpeg",
            StreamEncoding::H264 => "h264",
        }
    }
}

/// One frame from a source to the page.
///
/// `Start` comes once before any picture and says how the ones after it are encoded, so the
/// page knows what to decode before the first byte of it arrives. It comes again whenever
/// the source restarts, since a video stream that starts over is a new stream.
#[derive(Debug, Clone, PartialEq)]
pub enum ScreenFrame {
    /// `codec` is set for `h264`, and is the name the browser configures its decoder with.
    Start {
        encoding: StreamEncoding,
        codec: Option<String>,
    },
    /// One picture as base64 JPEG.
    Jpeg { data: String },
    /// One H.264 access unit; `keyframe` when it stands on its own.
    H264 { data: Bytes, keyframe: bool },
}

/// Where a source sends its frames.
pub type FrameSink = Arc<dyn Fn(ScreenFrame) + Send + Sync>;

#[async_trait]
pub trait PictureStream: Send + Sync {
    fn start(&self);
    /// Send pictures of this size from here on, where the source has a size of its own.
    ///
    /// The tab source has none: it sends the tab at whatever size the browser draws it.
    fn resize(&self, _size: &str) {}
    async fn stop(&self);
}
