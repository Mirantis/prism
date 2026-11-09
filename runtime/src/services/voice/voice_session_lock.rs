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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_the_lock_to_the_first_caller_and_refuses_the_second() {
        let lock = VoiceSessionLock::new();
        assert!(lock.try_acquire(VoiceSessionKind::VoiceChat));
        assert!(!lock.try_acquire(VoiceSessionKind::Meeting));
        assert_eq!(lock.holder(), Some(VoiceSessionKind::VoiceChat));
    }

    #[test]
    fn refuses_a_second_session_of_the_same_kind() {
        let lock = VoiceSessionLock::new();
        assert!(lock.try_acquire(VoiceSessionKind::VoiceChat));
        assert!(!lock.try_acquire(VoiceSessionKind::VoiceChat));
    }

    #[test]
    fn frees_the_lock_for_the_other_owner_once_the_holder_lets_go() {
        let lock = VoiceSessionLock::new();
        lock.try_acquire(VoiceSessionKind::Meeting);
        lock.release(VoiceSessionKind::Meeting);
        assert_eq!(lock.holder(), None);
        assert!(lock.try_acquire(VoiceSessionKind::VoiceChat));
    }

    #[test]
    fn ignores_a_release_from_anything_but_the_holder() {
        let lock = VoiceSessionLock::new();
        lock.try_acquire(VoiceSessionKind::VoiceChat);
        lock.release(VoiceSessionKind::Meeting);
        lock.release(VoiceSessionKind::Meeting);
        assert_eq!(lock.holder(), Some(VoiceSessionKind::VoiceChat));
    }

    #[test]
    fn takes_a_repeated_release_from_the_holder_as_one() {
        let lock = VoiceSessionLock::new();
        lock.try_acquire(VoiceSessionKind::Meeting);
        lock.release(VoiceSessionKind::Meeting);
        lock.try_acquire(VoiceSessionKind::VoiceChat);
        lock.release(VoiceSessionKind::Meeting);
        assert_eq!(lock.holder(), Some(VoiceSessionKind::VoiceChat));
    }
}
