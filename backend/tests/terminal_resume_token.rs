//! `prism-server` keeps the terminal's resume token (OSC 7577) out of the
//! processes it starts. The binary runs as its own process and gets the token
//! through `Command::env`, so the test process keeps its own environment.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// A fake `claude` that records the token it sees, for the login check and for the
/// command alike.
const FAKE_CLAUDE: &str =
    "#!/bin/sh\nprintf '%s' \"${OSC7577_TOKEN-unset}\" > \"$FAKE_OUT\"\nexit 0\n";

fn write_executable(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn a_process_the_runtime_starts_has_no_terminal_resume_token() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, wrappers, out) = (
        dir.path().join("bin"),
        dir.path().join("wrappers"),
        dir.path().join("out"),
    );
    std::fs::create_dir(&bin).unwrap();
    std::fs::create_dir(&wrappers).unwrap();
    write_executable(&bin.join("claude"), FAKE_CLAUDE);

    // The desktop terminal's wrapper reads the whole environment it gets and
    // passes it to the coding agent it starts.
    let status = Command::new(env!("CARGO_BIN_EXE_prism-server"))
        .arg("coding-agent-exec")
        .arg("--wrappers")
        .arg(&wrappers)
        .args(["claude", "-p", "hi"])
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("HOME", dir.path())
        .env(
            "DATABASE_URL",
            format!("file:{}", dir.path().join("gone.db").display()),
        )
        .env("FAKE_OUT", &out)
        .env("OSC7577_TOKEN", "dummy-token-replace-me")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();

    let seen = std::fs::read_to_string(&out).unwrap_or_else(|_| {
        panic!("the fake claude never ran; coding-agent-exec exited with {status}")
    });
    assert_eq!(seen, "unset");
}
