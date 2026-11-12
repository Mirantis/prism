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
use serde_json::json;

use crate::log_warn;
use crate::support::js::{self, slice16};

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
    if REPORTED.load(Ordering::SeqCst) || !is_container_lost(engine_said) {
        return;
    }
    if REPORTED.swap(true, Ordering::SeqCst) {
        return;
    }
    log_warn!(
        json!({ "container": container, "engine": slice16(js::trim(engine_said), 0, 300) }),
        "[Docker] the exec container is gone; commands and file access fail until the runtime restarts"
    );
}

/// Test-only: forget that the warning was given.
pub fn reset_container_lost_for_tests() {
    REPORTED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_what_podman_answers_for_a_missing_and_a_stopped_container() {
        // Captured from a real engine behind the `docker` shim.
        assert!(is_container_lost(
            "Error response from daemon: no container with name or ID \"prism-agent-exec-abc\" found: no such container"
        ));
        assert!(is_container_lost(
            "Error response from daemon: can only create exec sessions on running containers: container state improper"
        ));
    }

    #[test]
    fn recognises_dockers_wording_too() {
        assert!(is_container_lost(
            "Error response from daemon: No such container: prism-agent-exec-abc"
        ));
        assert!(is_container_lost(
            "Error response from daemon: container 1a2b is not running"
        ));
    }

    #[test]
    fn does_not_mistake_a_commands_own_failure_for_it() {
        assert!(!is_container_lost(
            "cat: /prism/workspace/nope: No such file or directory"
        ));
        assert!(!is_container_lost("bash: line 1: foo: command not found"));
    }

    #[test]
    #[serial_test::serial(container_lost)]
    fn warns_once_however_many_calls_then_fail() {
        reset_container_lost_for_tests();
        let said = "Error response from daemon: No such container: prism-agent-exec-abc";
        report_if_container_lost("prism-agent-exec-abc", said);
        assert!(REPORTED.load(Ordering::SeqCst));
        report_if_container_lost("prism-agent-exec-abc", said);
        assert!(REPORTED.load(Ordering::SeqCst));
        reset_container_lost_for_tests();
    }

    #[test]
    #[serial_test::serial(container_lost)]
    fn stays_quiet_for_a_commands_own_error() {
        reset_container_lost_for_tests();
        report_if_container_lost("prism-agent-exec-abc", "grep: no match");
        assert!(!REPORTED.load(Ordering::SeqCst));
    }
}
