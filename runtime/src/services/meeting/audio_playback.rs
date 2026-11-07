//! Playback of the model's speech into the meeting.
//!
//! This file has been wrong twice in opposite directions, and both failures are worth
//! recording because the fix is the thing in between.
//!
//! **First attempt: meter one 20 ms frame per interval tick.** Barge-in was
//! instant (nothing was committed ahead of time) but the audio was rough: timers
//! are not a clock, so a GC pause or a tool call landing mid-sentence delivered a
//! frame late, PulseAudio ran dry, and the listener heard a click or a chopped
//! syllable.
//!
//! **Second attempt: push as fast as the pipe accepts and let PulseAudio pace it.**
//! The audio became smooth and the interruption became terrible. Writing eagerly
//! fills the OS pipe (64 kB ≈ 680 ms of speech), the stream buffer (≈170 ms) and
//! the device buffer — so when a human interrupted, up to a second of speech was
//! already committed and unrecallable. The bot talked over them, exactly as reported.
//!
//! **What actually works: stay a fixed, small distance ahead of real time.** We keep
//! our own clock, but instead of writing a fixed amount per tick we compute how much
//! *should* have been handed over by now and write the difference. A late tick simply
//! writes more to catch up, so jitter can't starve the device — that was the flaw in
//! the first attempt — while nothing is ever committed more than `TARGET_LEAD_MS`
//! ahead, which bounds how long the bot can keep talking after being cut off.
//!
//! Having a real clock also makes the played-ms *measured* rather than estimated,
//! which is what `conversation.item.truncate` needs to be honest.

use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use bytes::Bytes;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::json;
use tokio::task::AbortHandle;

use crate::lib::log_redaction::err_json;
use crate::services::meeting::resampler::{
    pcm16_bytes_duration_ms, pcm16_bytes_for_ms, pcm16_duration_ms,
};
use crate::{log_error, log_warn};

/// How far ahead of real time audio may be handed to the device.
///
/// This is the single number that trades smoothness against interruption latency:
/// it is both the cushion that absorbs scheduling jitter and the maximum amount of
/// speech that cannot be recalled when someone interrupts. 150 ms is comfortably
/// above the worst scheduling delay we see and short enough to read as instant.
const TARGET_LEAD_MS: f64 = 150.0;

/// Buffer `pacat` requests from PulseAudio, and therefore the most it will hold.
///
/// Kept slightly above `TARGET_LEAD_MS` so the device always has somewhere to put
/// what we hand it, but no larger: anything buffered here is also unrecallable.
pub const SINK_BUFFER_MS: u64 = 200;

/// How often to reconsider how much should have been written by now.
const TICK_MS: u64 = 20;

/// Audio to accumulate before the first write of a phrase.
///
/// Without it the device starts on the first fragment and can drain before the next
/// one arrives, which is what clipped the opening words.
const PREROLL_MS: f64 = 100.0;

/// Start anyway if the pre-roll never fills — a short reply may be all there is.
const PREROLL_DEADLINE_MS: f64 = 250.0;

/// Where audio is written — `pacat`'s stdin in production.
pub trait PlaybackSink: Send + Sync {
    /// Hand one chunk to the device. An error stops playback of everything queued.
    fn write(&self, chunk: Bytes) -> anyhow::Result<()>;

    /// Drop audio queued beyond this process, if the far end holds any.
    ///
    /// A local device does not: `pacat` plays what it is given as fast as it is
    /// written, so the only unrecallable audio is the `TARGET_LEAD_MS` already
    /// committed, and this stays a no-op there. A sink that writes to a client
    /// across a network is the case it exists for — everything written is sitting
    /// in that client's buffer, and without being told to drop it the agent keeps
    /// talking after being interrupted.
    fn clear(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct QueuedChunk {
    item_id: String,
    chunk: Bytes,
}

/// What became of one response item's audio when playback was cut short.
///
/// Both numbers are needed: `played_ms` is what the room heard, `sent_ms` is what
/// reached the device at all, and the truncation point OpenAI recommends is derived
/// from the pair rather than from either alone.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackSnapshot {
    pub item_id: String,
    pub played_ms: f64,
    pub sent_ms: f64,
}

/// Milliseconds since the epoch in whole milliseconds, as `Date.now()` reads them, for
/// the voice code's durations and deadlines.
///
/// Read off tokio's clock and anchored to the wall clock once, so the figures move
/// monotonically and a paused test runtime moves them with `tokio::time::advance`.
pub(crate) fn clock_ms() -> i64 {
    static BASE: LazyLock<(i64, std::time::Instant)> =
        LazyLock::new(|| (crate::support::now_ms(), std::time::Instant::now()));
    let (wall, base) = *BASE;
    let now = tokio::time::Instant::now().into_std();
    let delta_ms = if now >= base {
        now.duration_since(base).as_secs_f64() * 1000.0
    } else {
        -(base.duration_since(now).as_secs_f64() * 1000.0)
    };
    wall + delta_ms.floor() as i64
}

/// `Date.now()` as a float, since the playback clock is rebased by fractional amounts.
fn now() -> f64 {
    clock_ms() as f64
}

struct PlaybackState {
    /// FIFO across items — see `enqueue` for why items are not discarded.
    queue: VecDeque<QueuedChunk>,
    queued_bytes: usize,
    paused: bool,
    disposed: bool,
    timer: Option<AbortHandle>,
    /// Playback clock: real time at which the current run of audio began.
    started_at: Option<f64>,
    first_enqueue_at: Option<f64>,
    /// Total audio handed to the sink since the clock started.
    written_ms: f64,
    /// Per-item totals, so truncation can be reported against the right item.
    written_ms_by_item: IndexMap<String, f64>,
    /// Item of the most recently written chunk — the one currently audible.
    writing_item: Option<String>,
}

impl PlaybackState {
    /// Audio handed over but not yet heard.
    fn outstanding_ms(&self) -> f64 {
        match self.started_at {
            None => 0.0,
            Some(started) => (self.written_ms - (now() - started)).max(0.0),
        }
    }

    fn stop_timer(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

struct PlaybackInner {
    sink: Arc<dyn PlaybackSink>,
    sample_rate: u32,
    state: Mutex<PlaybackState>,
}

#[derive(Clone)]
pub struct AudioPlayback {
    inner: Arc<PlaybackInner>,
}

impl AudioPlayback {
    /// `sample_rate` is required rather than defaulted.
    ///
    /// Every millisecond this type computes — the pre-roll, the lead it chases, the
    /// `played_ms` it reports for truncation — comes from it. A default would be
    /// invisible in review and audible in production: 24 kHz audio paced as 48 kHz
    /// writes at half the rate the device drains, and reports twice the audio as
    /// heard.
    pub fn new(sink: Arc<dyn PlaybackSink>, sample_rate: u32) -> Self {
        Self {
            inner: Arc::new(PlaybackInner {
                sink,
                sample_rate,
                state: Mutex::new(PlaybackState {
                    queue: VecDeque::new(),
                    queued_bytes: 0,
                    paused: false,
                    disposed: false,
                    timer: None,
                    started_at: None,
                    first_enqueue_at: None,
                    written_ms: 0.0,
                    written_ms_by_item: IndexMap::new(),
                    writing_item: None,
                }),
            }),
        }
    }

    /// Enqueue model speech for a response item.
    ///
    /// Items are appended, never allowed to displace one another. An earlier version
    /// cleared the queue whenever a new item id appeared, which produced a subtle and
    /// very audible bug: the model says "let me check that", calls a tool, and the
    /// follow-up response arrives as a *new* item — dropping the unplayed part of the
    /// filler and cutting the bot off mid-word. It sounded like the bot interrupting
    /// itself, because it was. Stale audio after a real interruption is handled where
    /// it belongs, by `RealtimeSession` refusing to forward deltas for an abandoned
    /// item.
    pub fn enqueue(&self, pcm48k: Bytes, item_id: &str) {
        {
            let mut state = self.inner.state.lock();
            if state.disposed || pcm48k.is_empty() {
                return;
            }
            state.queued_bytes += pcm48k.len();
            state.queue.push_back(QueuedChunk {
                item_id: item_id.to_string(),
                chunk: pcm48k,
            });
            if state.first_enqueue_at.is_none() {
                state.first_enqueue_at = Some(now());
            }
        }
        self.ensure_timer();
    }

    /// Stop handing over audio, keeping the queue for a possible resume.
    pub fn pause(&self) {
        self.inner.state.lock().paused = true;
    }

    /// Resume after a pause that turned out not to be a real interruption.
    pub fn resume(&self) {
        {
            let mut state = self.inner.state.lock();
            if !state.paused {
                return;
            }
            state.paused = false;
        }
        self.ensure_timer();
    }

    /// Drop everything unplayed and report what was heard, per response item.
    ///
    /// A list rather than a single item, because `gpt-realtime-2.x` speaks a native
    /// preamble ("let me check that") as its own `commentary` item and then the answer
    /// as a `final_answer` item — one turn, two or more audio items. Truncating only
    /// the newest leaves the preamble's unheard tail in the model's context, so every
    /// item that received audio is reported: earlier ones were heard in full, the
    /// audible one partially, and anything still queued was never heard at all.
    ///
    /// The tail already inside the device (at most `TARGET_LEAD_MS`) still plays; it
    /// cannot be recalled, which is exactly why that number is kept small.
    pub fn flush(&self) -> Vec<PlaybackSnapshot> {
        let items = {
            let mut state = self.inner.state.lock();
            let outstanding = state.outstanding_ms();
            let mut items: Vec<PlaybackSnapshot> = Vec::new();
            for (item_id, sent_ms) in &state.written_ms_by_item {
                // Only the item still being written can have audio outstanding; everything
                // before it has already gone out and been heard.
                let played_ms = if state.writing_item.as_deref() == Some(item_id.as_str()) {
                    (sent_ms - outstanding).max(0.0)
                } else {
                    *sent_ms
                };
                items.push(PlaybackSnapshot {
                    item_id: item_id.clone(),
                    played_ms,
                    sent_ms: *sent_ms,
                });
            }
            // Items whose audio arrived but never reached the device were heard for 0ms;
            // they still need truncating or their transcript stays in context.
            for queued in &state.queue {
                if !state.written_ms_by_item.contains_key(&queued.item_id)
                    && !items.iter().any(|i| i.item_id == queued.item_id)
                {
                    items.push(PlaybackSnapshot {
                        item_id: queued.item_id.clone(),
                        played_ms: 0.0,
                        sent_ms: 0.0,
                    });
                }
            }

            state.queue.clear();
            state.queued_bytes = 0;
            state.paused = false;
            state.first_enqueue_at = None;
            state.written_ms_by_item.clear();
            state.writing_item = None;
            state.stop_timer();
            items
        };
        // Told after the snapshots are taken, not before: the numbers above describe
        // what the far end heard, and a sink that drops its own queue changes what it
        // is about to play rather than what it already did.
        self.clear_sink();
        items
    }

    /// Whether the bot still has speech to deliver.
    ///
    /// Counts audio already handed to the device as well as what is queued: during
    /// that window the room can still hear it, so an interruption is meaningful.
    pub fn is_speaking(&self) -> bool {
        let state = self.inner.state.lock();
        state.queued_bytes > 0 || state.outstanding_ms() > TICK_MS as f64
    }

    /// Milliseconds of the audible item the room has actually heard.
    ///
    /// Measured from the clock rather than inferred from a fixed buffer depth, so it
    /// is what `conversation.item.truncate` should be told.
    pub fn current_played_ms(&self) -> f64 {
        let state = self.inner.state.lock();
        let Some(item) = state.writing_item.as_ref() else {
            return 0.0;
        };
        let written = state.written_ms_by_item.get(item).copied().unwrap_or(0.0);
        (written - state.outstanding_ms()).max(0.0)
    }

    fn ensure_timer(&self) {
        {
            let mut state = self.inner.state.lock();
            if state.timer.is_some() || state.paused || state.disposed {
                return;
            }
            let weak: Weak<PlaybackInner> = Arc::downgrade(&self.inner);
            let task = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(TICK_MS));
                // The first tick of an interval completes at once; the caller ticks now itself.
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let Some(inner) = weak.upgrade() else { return };
                    AudioPlayback { inner }.tick();
                }
            });
            state.timer = Some(task.abort_handle());
        }
        self.tick();
    }

    fn tick(&self) {
        let mut state = self.inner.state.lock();
        if state.paused || state.disposed {
            return;
        }
        if state.queue.is_empty() {
            // Nothing left to hand over. Keep the clock so `outstanding_ms` stays honest
            // while the device drains, but stop spinning the timer.
            state.stop_timer();
            return;
        }

        if !self.ready_to_start(&state) {
            return;
        }

        let now = now();
        if state.started_at.is_none() {
            state.started_at = Some(now);
        }
        // If the device has drained (a gap between phrases), rebase the clock. Without
        // this the elapsed time would race ahead of what we have written and the next
        // phrase would be dumped in one burst, undoing the whole point of pacing.
        let elapsed = now - state.started_at.unwrap_or(now);
        if elapsed > state.written_ms {
            state.started_at = Some(now - state.written_ms);
        }

        let target = state.started_at.map(|started| now - started).unwrap_or(0.0) + TARGET_LEAD_MS;
        while state.written_ms < target && !state.queue.is_empty() {
            if !self.write_one_chunk(&mut state, target) {
                return;
            }
        }
    }

    /// Hold the first write until there is enough audio to survive a hiccup.
    fn ready_to_start(&self, state: &PlaybackState) -> bool {
        if state.started_at.is_some() {
            return true;
        }
        if pcm16_bytes_duration_ms(state.queued_bytes, self.inner.sample_rate) >= PREROLL_MS {
            return true;
        }
        state
            .first_enqueue_at
            .map(|at| now() - at >= PREROLL_DEADLINE_MS)
            .unwrap_or(false)
    }

    /// Write at most enough to reach `target`, splitting a chunk when it overshoots.
    ///
    /// Splitting matters: a single delta can be hundreds of milliseconds long, and
    /// handing it over whole would blow past the lead we are trying to hold.
    fn write_one_chunk(&self, state: &mut PlaybackState, target: f64) -> bool {
        let remaining_ms = target - state.written_ms;
        let want_bytes = pcm16_bytes_for_ms(remaining_ms, self.inner.sample_rate).max(2) as usize;

        let Some(head) = state.queue.front_mut() else {
            return false;
        };
        let item_id = head.item_id.clone();
        let piece = if head.chunk.len() <= want_bytes {
            let piece = head.chunk.clone();
            state.queue.pop_front();
            piece
        } else {
            head.chunk.split_to(want_bytes)
        };
        state.queued_bytes -= piece.len();

        let ms = pcm16_duration_ms(&piece, self.inner.sample_rate);
        if let Err(err) = self.inner.sink.write(piece) {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Meeting] Playback sink write failed"
            );
            state.queue.clear();
            state.queued_bytes = 0;
            state.stop_timer();
            return false;
        }

        state.written_ms += ms;
        state.writing_item = Some(item_id.clone());
        *state.written_ms_by_item.entry(item_id).or_insert(0.0) += ms;
        true
    }

    /// Release resources. Safe to call more than once.
    pub fn dispose(&self) {
        {
            let mut state = self.inner.state.lock();
            state.disposed = true;
            state.queue.clear();
            state.queued_bytes = 0;
            state.stop_timer();
        }
        self.clear_sink();
    }

    /// Ask the sink to drop what it holds, when it holds anything.
    ///
    /// Never fails upward: this runs while a call is being interrupted or torn
    /// down, and a sink that will not clear must not stop either from finishing.
    fn clear_sink(&self) {
        if let Err(err) = self.inner.sink.clear() {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[Meeting] Playback sink would not clear"
            );
        }
    }
}
