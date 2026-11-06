//! Naming the cause when the exec container is gone.
//!
//! The container is created once, at boot. When it disappears while the runtime
//! runs — the engine restarts, Docker Desktop is relaunched, somebody removes it,
//! or the OOM killer stops it — every command and every file call answers with
//! the engine's error until the runtime restarts. The agent's shell then fails
//! and its skills and plugins read as empty, so one warning names the cause.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use regex::Regex;

/// The engine's answer for a container that is missing or stopped. Podman says
/// `no container with name or ID "<name>" found: no such container` and
/// `can only create exec sessions on running containers`; Docker says
/// `No such container: <name>` and `container <id> is not running`.
static CONTAINER_LOST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)no such container|is not running|can only create exec sessions on running containers",
    )
    .unwrap()
});

static REPORTED: AtomicBool = AtomicBool::new(false);

pub fn is_container_lost(engine_said: &str) -> bool {
    CONTAINER_LOST.is_match(engine_said)
}

/// Warn once per process when the engine says the container is gone. Once is
/// enough: nothing brings the container back before the runtime restarts.
///
/// Logs `{ container, engine: <the engine's words trimmed, first 300 UTF-16 units> }`
/// with `[Docker] the exec container is gone; commands and file access fail until
/// the runtime restarts`.
pub fn report_if_container_lost(container: &str, engine_said: &str) {
    todo!()
}

/// Test-only: forget that the warning was given.
pub fn reset_container_lost_for_tests() {
    REPORTED.store(false, Ordering::SeqCst);
}
