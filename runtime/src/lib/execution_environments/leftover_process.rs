//! Stop a process the agent started that a crash of the runtime left running.
//! Each agent process leads its own group, so a `SIGKILL` of the runtime does not
//! reach it. The mark names the process; the group is killed only while the
//! process with that pid is still the one that started at the marked time.

use std::sync::LazyLock;

use regex::Regex;

use super::execution_environment::ProcessMark;

/// How far the start time `ps` gives may stray from the mark's: `ps` counts whole seconds.
pub const START_TOLERANCE_MS: i64 = 3_000;

/// Kill the marked process group. True when it was still running and was killed.
pub async fn stop_leftover_process(mark: ProcessMark) -> bool {
    todo!()
}

/// How long the process has run (`ps -o etime= -p <pid>`), or `None` when no
/// process has that pid.
async fn elapsed_ms(pid: i64) -> Option<i64> {
    todo!()
}

static ELAPSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$").unwrap());

/// The elapsed time `ps` prints, `[[dd-]hh:]mm:ss`, in milliseconds.
pub fn parse_elapsed(text: &str) -> Option<i64> {
    let caps = ELAPSED.captures(text)?;
    let part = |i: usize| -> i64 {
        caps.get(i)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(0)
    };
    let (days, hours, minutes, seconds) = (part(1), part(2), part(3), part(4));
    Some((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000)
}
