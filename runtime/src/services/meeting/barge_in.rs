//! Interruption policy: when a human starts talking over the bot, what happens.
//!
//! The naive version — cancel the response the instant voice activity is detected
//! — is the classic meeting-bot failure. A cough, a chair scrape, or an "mm-hm"
//! of agreement kills the bot mid-sentence, and it never finishes a thought.
//! The other naive version — waiting to be sure before reacting — leaves the bot
//! talking over someone for half a second, which reads as rude and makes people
//! talk louder.
//!
//! So the two decisions are separated:
//!
//! - **Go quiet immediately.** On the first hint of speech, playback pauses. This
//!   is instant and free: nothing is discarded and nothing is told to the model,
//!   so it can be undone.
//! - **Commit to the interruption only if the speech persists.** After a short
//!   grace period, the pause becomes a real interruption: unplayed audio is
//!   dropped and the model is told how much of its turn was actually heard. If the
//!   speech stops inside the grace period, playback simply resumes — from the
//!   listener's side, the bot paused for a beat mid-sentence.
//!
//! In a meeting the bot always yields to humans; the grace period tunes *what
//! counts as a human wanting the floor*, never whether they get it.

use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::task::AbortHandle;

/// How long speech must continue before the bot gives up its turn.
///
/// 500 ms is long enough to rule out a cough or a one-syllable backchannel and
/// short enough that a real interjection only overlaps by a pause.
pub const BACKCHANNEL_GRACE_MS: u64 = 500;

/// What the policy does to playback and to the model.
#[derive(Clone)]
pub struct BargeInHandlers {
    /// Go quiet, keeping unplayed audio for a possible resume.
    pub pause_playback: Arc<dyn Fn() + Send + Sync>,
    /// Undo the pause — the speech turned out to be a backchannel.
    pub resume_playback: Arc<dyn Fn() + Send + Sync>,
    /// Give up the turn: drop unplayed audio and tell the model what was heard.
    /// Returns nothing; the caller wires it to `flush()` + `interrupt(played_ms)`.
    pub commit_interrupt: Arc<dyn Fn() + Send + Sync>,
    /// Whether the bot currently has audio to play (i.e. is mid-utterance).
    pub is_speaking: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Default)]
struct BargeInState {
    grace_timer: Option<AbortHandle>,
    /// Bumped whenever the timer is cleared, so a timer that already fired cannot act.
    timer_generation: u64,
    /// True from the pause until either resume or commit.
    pending: bool,
    /// True once the current utterance has been given up on.
    committed: bool,
}

impl BargeInState {
    fn clear_timer(&mut self) {
        if let Some(timer) = self.grace_timer.take() {
            timer.abort();
        }
        self.timer_generation += 1;
    }
}

struct BargeInInner {
    handlers: BargeInHandlers,
    grace_ms: u64,
    state: Mutex<BargeInState>,
}

/// Tracks one speaker's overlap with the bot and decides when to yield.
///
/// Deliberately not aware of *who* is speaking: the meeting audio is one mixed
/// mono bus, so any human voice is simply "a human wants the floor".
#[derive(Clone)]
pub struct BargeInPolicy {
    inner: Arc<BargeInInner>,
}

impl BargeInPolicy {
    pub fn new(handlers: BargeInHandlers) -> Self {
        Self::with_grace(handlers, BACKCHANNEL_GRACE_MS)
    }

    pub fn with_grace(handlers: BargeInHandlers, grace_ms: u64) -> Self {
        Self {
            inner: Arc::new(BargeInInner {
                handlers,
                grace_ms,
                state: Mutex::new(BargeInState::default()),
            }),
        }
    }

    /// Voice activity detected. Goes quiet at once; commits only if it lasts.
    pub fn on_speech_started(&self) {
        // Not talking over anyone — nothing to yield.
        if !(self.inner.handlers.is_speaking)() {
            return;
        }
        {
            let mut state = self.inner.state.lock();
            if state.pending || state.committed {
                return;
            }
            state.pending = true;
        }
        (self.inner.handlers.pause_playback)();

        let mut state = self.inner.state.lock();
        state.clear_timer();
        let generation = state.timer_generation;
        let weak: Weak<BargeInInner> = Arc::downgrade(&self.inner);
        let grace = Duration::from_millis(self.inner.grace_ms);
        let task = tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let Some(inner) = weak.upgrade() else { return };
            let policy = BargeInPolicy { inner };
            {
                let mut state = policy.inner.state.lock();
                if state.timer_generation != generation {
                    return;
                }
                state.grace_timer = None;
                // Still overlapping after the grace period: this is a real interruption.
                if !state.pending {
                    return;
                }
            }
            policy.commit();
        });
        state.grace_timer = Some(task.abort_handle());
    }

    /// Voice activity ended. Inside the grace period this undoes the pause.
    pub fn on_speech_stopped(&self) {
        {
            let mut state = self.inner.state.lock();
            if !state.pending {
                return;
            }
            state.clear_timer();
            state.pending = false;
        }
        (self.inner.handlers.resume_playback)();
    }

    /// A new utterance has begun (fresh response item), so the previous decision no
    /// longer applies. Called by the session runner when the model starts speaking
    /// again — including the response it generates *because* it was interrupted.
    pub fn on_utterance_started(&self) {
        let mut state = self.inner.state.lock();
        state.clear_timer();
        state.pending = false;
        state.committed = false;
    }

    /// Commit now, without waiting out the grace period.
    ///
    /// Used when the model starts a new response while a pause is pending: the old
    /// audio is stale and must be dropped before the new utterance plays, or the two
    /// would be spliced together.
    pub fn commit_if_pending(&self) {
        let pending = self.inner.state.lock().pending;
        if pending {
            self.commit();
        }
    }

    fn commit(&self) {
        {
            let mut state = self.inner.state.lock();
            state.clear_timer();
            state.pending = false;
            state.committed = true;
        }
        (self.inner.handlers.commit_interrupt)();
    }

    /// Release the pending timer. Safe to call more than once.
    pub fn dispose(&self) {
        let mut state = self.inner.state.lock();
        state.clear_timer();
        state.pending = false;
    }
}
