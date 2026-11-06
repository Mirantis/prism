//! Desktop availability is independent of voice credentials.

use std::sync::atomic::{AtomicBool, Ordering};

pub const COMPUTER_BINARIES: [&str; 7] = [
    "dbus-launch",
    "startxfce4",
    "xdotool",
    "xrandr",
    "ffmpeg",
    "wmctrl",
    "tesseract",
];

/// The apt packages that install them, for the message a host without them gets.
const COMPUTER_PACKAGES: &str = "xfce4, dbus-x11, ffmpeg, xdotool, wmctrl, x11-xserver-utils, tesseract-ocr, at-spi2-core, python3-pyatspi";

pub fn unsupported_reason(missing: &str) -> String {
    format!(
        "this image lacks the desktop packages ({missing} is not on PATH; the set is {COMPUTER_PACKAGES}); rebuild it with `npm run docker:build`"
    )
}

pub async fn is_computer_supported() -> bool {
    todo!()
}

/// The startup answer, for the Web UI to read on every `/agents/me`.
///
/// False until `init_computer_availability` runs, so a runtime that never probes — a test,
/// an embedder — simply does not offer the page. A session asks `is_computer_supported`
/// again when it opens a computer, since an answer from startup is not a promise about now.
static COMPUTER_AVAILABLE: AtomicBool = AtomicBool::new(false);

pub fn has_computer() -> bool {
    COMPUTER_AVAILABLE.load(Ordering::SeqCst)
}

/// Whether a run may use a remote computer: one a person started in a conversation.
/// Heartbeats, scheduled tasks and webhooks use only the runtime's own computer, and so
/// does a voice call, which is held on that computer's page.
pub fn uses_remote_computers(mode: &str) -> bool {
    mode == "chat" || mode == "goal"
}

/// Meetings use their own browser; subagents return work to the desktop's owning invocation.
pub fn has_computer_for_mode(mode: &str) -> bool {
    todo!()
}

/// Probe once and remember the answer. Never fails: a failed probe means "no computer".
pub async fn init_computer_availability() -> bool {
    todo!()
}
