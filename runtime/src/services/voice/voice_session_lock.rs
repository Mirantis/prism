//! The one live voice session in the runtime.
//!
//! The agent has one voice, so a Google Meet call and a browser voice chat exclude each
//! other. Both owners take this lock rather than keeping a guard each, which is what makes
//! the refusal correct in both directions.

use std::sync::LazyLock;

use parking_lot::Mutex;

/// Which owner holds a voice session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceSessionKind {
    Meeting,
    VoiceChat,
}

impl VoiceSessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceSessionKind::Meeting => "meeting",
            VoiceSessionKind::VoiceChat => "voice-chat",
        }
    }
}

pub struct VoiceSessionLock {
    held: Mutex<Option<VoiceSessionKind>>,
}

impl Default for VoiceSessionLock {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceSessionLock {
    pub fn new() -> Self {
        Self {
            held: Mutex::new(None),
        }
    }

    /// What holds the lock, or `None` when the runtime has no voice session.
    pub fn holder(&self) -> Option<VoiceSessionKind> {
        *self.held.lock()
    }

    /// Take the lock, or answer `false` because something already holds it.
    pub fn try_acquire(&self, kind: VoiceSessionKind) -> bool {
        let mut held = self.held.lock();
        if held.is_some() {
            return false;
        }
        *held = Some(kind);
        true
    }

    /// Let go of the lock, if `kind` is what holds it.
    ///
    /// Idempotent, and ignores a release from the other owner: each owner calls this from
    /// every one of its exit paths, and several of those paths run for a session that has
    /// already ended.
    pub fn release(&self, kind: VoiceSessionKind) {
        let mut held = self.held.lock();
        if *held == Some(kind) {
            *held = None;
        }
    }
}

pub static VOICE_SESSION_LOCK: LazyLock<VoiceSessionLock> = LazyLock::new(VoiceSessionLock::new);
