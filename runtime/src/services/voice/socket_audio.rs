//! The audio path for a voice client, over the WebSocket it is already on.
//!
//! There is no negotiation here and nothing to reach: the socket carrying the
//! client's chat carries its voice, so a call works wherever chat works. That is
//! the whole reason this exists in place of a peer connection — a hosted runtime
//! has no inbound path for media, so WebRTC needed a TURN relay per deployment
//! and a voice call that could not be reached was a voice call nobody had.
//!
//! What that costs is real: a socket has no jitter buffer, no packet-loss
//! concealment and no congestion control. Those were WebRTC's, and on a poor
//! cellular link they are missed.
//!
//! The rate is the client's, and every session states it: a client on the model's own
//! `REALTIME_SAMPLE_RATE` resamples nowhere at all, since `VoiceConversation` skips both
//! of its resamplers too. A client that carries the agent's screen as well speaks 48 kHz,
//! where dropping the program audio to the model's rate would dull it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::Bytes;
use serde::Serialize;
use serde_json::json;

use crate::log_warn;
use crate::services::meeting::audio_playback::PlaybackSink;
use crate::services::meeting::resampler::REALTIME_SAMPLE_RATE;

/// The format the protocol carries. Declared to the client in `hello`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAudioFormat {
    pub encoding: &'static str,
    pub sample_rate: u32,
    pub channels: u32,
}

/// The one format the protocol carries. Declared to the client in `hello`.
pub const VOICE_AUDIO_FORMAT: VoiceAudioFormat = VoiceAudioFormat {
    encoding: "pcm16",
    sample_rate: REALTIME_SAMPLE_RATE,
    channels: 1,
};

/// The largest frame of client audio this accepts: one second at the session's rate.
///
/// A client sends 20 to 100 ms a frame, so a second is a wide margin and anything past it
/// is not microphone audio. Bounded here rather than on the WebSocket server, which is
/// shared with chat: an oversize frame there closes the connection with 1009, so a
/// server-wide limit would drop a text client mid-conversation over a large paste.
/// This drops the frame and leaves the call running.
pub fn max_frame_bytes(sample_rate: u32) -> usize {
    sample_rate as usize * 2
}

/// Whether a frame the client sent is microphone audio worth carrying.
///
/// An odd byte count is not: pcm16 is two bytes a sample, and half a sample would shift
/// every sample after it by a byte and turn the rest of the frame into noise. Nor is one
/// past `max_bytes`, since everything downstream is metered by the second of audio.
///
/// Read wherever a frame is first acted on rather than only by the transport. A recording
/// of the user's screen takes the frame before the transport sees it, and resampling one
/// nobody asked for is the work this bounds.
pub fn is_audio_frame_usable(pcm: &[u8], max_bytes: usize) -> bool {
    if pcm.is_empty() {
        return false;
    }
    if pcm.len() % 2 != 0 {
        log_warn!(
            json!({ "bytes": pcm.len() }),
            "[VoiceChat] Dropped an audio frame with a half sample"
        );
        return false;
    }
    if pcm.len() > max_bytes {
        log_warn!(
            json!({ "bytes": pcm.len() }),
            "[VoiceChat] Dropped an audio frame over the size limit"
        );
        return false;
    }
    true
}

/// What the transport needs from whoever owns the socket.
pub trait SocketAudioChannel: Send + Sync {
    /// Send one frame of the agent's speech.
    fn send_audio(&self, pcm: Bytes);
    /// Tell the client to drop what it has not played yet.
    fn send_clear(&self);
}

/// What the transport tells its owner.
pub trait SocketAudioEvents: Send + Sync {
    /// Audio the client captured, pcm16 mono at the format's rate.
    fn on_audio(&self, pcm: Bytes);
}

/// Where the voice core writes the agent's speech.
///
/// One frame per write, whatever size the write is. `AudioPlayback` paces to a
/// 150 ms lead on a 20 ms tick, so this is fed at roughly real time and needs
/// no pacing or backpressure of its own — the thing that would flood a socket
/// is a producer that runs faster than the audio, and that producer is a clock.
struct SocketSink {
    channel: Arc<dyn SocketAudioChannel>,
    closed: Arc<AtomicBool>,
}

impl PlaybackSink for SocketSink {
    fn write(&self, chunk: Bytes) -> anyhow::Result<()> {
        if self.closed.load(Ordering::SeqCst) || chunk.is_empty() {
            return Ok(());
        }
        self.channel.send_audio(chunk);
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        // Everything already written is in the client's buffer. Without this the
        // agent talks over the person who interrupted it, for as long as that
        // buffer plus the network holds.
        self.channel.send_clear();
        Ok(())
    }
}

/// The client's audio in, the agent's speech out.
///
/// There is no connection state of its own: a socket that is open is the media path, so
/// the session is live from the moment it is built, and its owner reports that rather than
/// waiting to be told.
pub struct SocketAudio {
    closed: Arc<AtomicBool>,
    max_frame_bytes: usize,
    events: Arc<dyn SocketAudioEvents>,
    /// Where the voice core writes the agent's speech.
    pub sink: Arc<dyn PlaybackSink>,
}

impl SocketAudio {
    /// `sample_rate` is what the client speaks; `None` is the model's own rate.
    pub fn new(
        channel: Arc<dyn SocketAudioChannel>,
        events: Arc<dyn SocketAudioEvents>,
        sample_rate: Option<u32>,
    ) -> Self {
        let closed = Arc::new(AtomicBool::new(false));
        let sample_rate = sample_rate.unwrap_or(REALTIME_SAMPLE_RATE);
        Self {
            closed: closed.clone(),
            max_frame_bytes: max_frame_bytes(sample_rate),
            events,
            sink: Arc::new(SocketSink { channel, closed }),
        }
    }

    /// A frame the client sent, carried on if `is_audio_frame_usable` says it is audio.
    pub fn push(&self, pcm: Bytes) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if !is_audio_frame_usable(&pcm, self.max_frame_bytes) {
            return;
        }
        self.events.on_audio(pcm);
    }

    /// Stop passing audio in either direction. Idempotent.
    pub async fn close(&self) -> anyhow::Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}
