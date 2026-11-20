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
    let Some(elapsed) = elapsed_ms(mark.pid).await else {
        return false;
    };
    if (crate::support::now_ms() - elapsed - mark.started_at).abs() > START_TOLERANCE_MS {
        return false;
    }
    kill_group(mark.pid)
}

#[cfg(unix)]
fn kill_group(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: `kill` only sends a signal; a group that is gone fails with ESRCH.
    unsafe { libc::kill(-pid, libc::SIGKILL) == 0 }
}

/// Windows has no process groups, and Node's `process.kill` of a negative pid
/// fails there.
#[cfg(not(unix))]
fn kill_group(_pid: i64) -> bool {
    false
}

/// How long the process has run (`ps -o etime= -p <pid>`), or `None` when no
/// process has that pid.
async fn elapsed_ms(pid: i64) -> Option<i64> {
    let output = tokio::process::Command::new("ps")
        .args(["-o", "etime=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_elapsed(crate::support::js::trim(&String::from_utf8_lossy(
        &output.stdout,
    )))
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

#[cfg(test)]
mod tests {
    //! The boot stops a process group a crashed runtime left running, and only
    //! the one its mark names: a later process given the same pid is left alone.

    use super::*;

    /// A process group of its own, as every agent process is.
    #[cfg(unix)]
    fn start_group() -> std::process::Child {
        use std::os::unix::process::CommandExt;
        std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap()
    }

    #[cfg(unix)]
    fn signal_of(status: std::process::ExitStatus) -> Option<i32> {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kills_the_process_group_the_mark_names() {
        let mut child = start_group();
        let mark = ProcessMark {
            pid: i64::from(child.id()),
            started_at: crate::support::now_ms(),
        };
        assert!(stop_leftover_process(mark).await);
        assert_eq!(signal_of(child.wait().unwrap()), Some(libc::SIGKILL));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaves_a_process_alone_that_started_at_another_time() {
        let mut child = start_group();
        let mark = ProcessMark {
            pid: i64::from(child.id()),
            started_at: crate::support::now_ms() - 60 * 60 * 1000,
        };
        assert!(!stop_leftover_process(mark).await);
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn does_nothing_when_no_process_has_the_pid() {
        let mut child = start_group();
        let pid = i64::from(child.id());
        child.kill().unwrap();
        child.wait().unwrap();
        let mark = ProcessMark {
            pid,
            started_at: crate::support::now_ms(),
        };
        assert!(!stop_leftover_process(mark).await);
    }

    #[test]
    fn reads_each_elapsed_form() {
        assert_eq!(parse_elapsed("00:05"), Some(5_000));
        assert_eq!(parse_elapsed("12:34"), Some((12 * 60 + 34) * 1000));
        assert_eq!(parse_elapsed("01:02:03"), Some((3600 + 2 * 60 + 3) * 1000));
        assert_eq!(
            parse_elapsed("2-01:02:03"),
            Some(((2 * 24 + 1) * 3600 + 2 * 60 + 3) * 1000)
        );
    }

    #[test]
    fn reads_nothing_from_an_empty_answer() {
        assert_eq!(parse_elapsed(""), None);
    }
}
