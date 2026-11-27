//! Loads the `.env` file into the process environment, before anything reads it.
//!
//! In the packaged binary the source tree is gone, so the sidecar `.env` lives
//! next to the executable (e.g. `~/.prism/.env`). Otherwise `.env` sits at the
//! repository root.
//!
//! The file is parsed as the `dotenv` package parses it: a variable already in
//! the environment keeps its value, and values are taken literally (no `$VAR`
//! expansion). Nothing is written to stdout; `index` logs the load summary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;

/// The result of loading `.env`, for the startup log line.
#[derive(Debug)]
pub struct DotenvLoadInfo {
    pub path: String,
    /// How many variables the file defines, whether or not the environment
    /// already held them.
    pub loaded_count: usize,
    /// Why the file could not be read; a missing file is the common case.
    pub error: Option<anyhow::Error>,
}

/// Name the process's TLS provider. The dependency tree compiles in two rustls
/// backends, and with no provider named a TLS connection that uses the process
/// default (every `wss://` socket: Slack Socket Mode, the Realtime API) panics.
/// The first call wins; later calls change nothing.
pub fn install_tls_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// The variable a terminal sets so that a program can ask it to resume the program
/// after a restart (OSC 7577).
const TERMINAL_RESUME_TOKEN: &str = "OSC7577_TOKEN";

/// Remove the terminal's resume token from this process's environment, so that no
/// process the runtime starts can register a command that the terminal runs later.
///
/// # Safety
///
/// No other thread may run, since another thread can read the environment while
/// it changes.
pub unsafe fn remove_terminal_resume_token() {
    // SAFETY: the caller guarantees that this is the only thread.
    unsafe { std::env::remove_var(TERMINAL_RESUME_TOKEN) };
}

/// Whether this is the packaged binary, which carries its release version baked
/// in at build time (`PRISM_VERSION`).
pub fn is_sea() -> bool {
    option_env!("PRISM_VERSION").is_some_and(|version| !version.is_empty())
}

/// Where `.env` is read from: next to the executable in the packaged binary,
/// else the repository root. A build whose repository is not on this machine
/// reads it next to the executable too.
pub fn dotenv_path() -> PathBuf {
    let beside_executable = || {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_default()
            .join(".env")
    };
    if is_sea() {
        return beside_executable();
    }
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    if repo_root.is_dir() {
        return normalize(&repo_root.join(".env"));
    }
    beside_executable()
}

/// `path.resolve` for a path that is already absolute: drops `.` and `..`.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The load, done once. Force it first thing in `main`, before any thread starts,
/// because it writes the process environment.
pub static DOTENV_LOAD_INFO: LazyLock<DotenvLoadInfo> = LazyLock::new(load);

/// The `.env` load summary; loads the file on first use.
pub fn dotenv_load_info() -> &'static DotenvLoadInfo {
    &DOTENV_LOAD_INFO
}

fn load() -> DotenvLoadInfo {
    load_dotenv_from(&dotenv_path())
}

/// Loads the `.env` file at `path` into the process environment, keeping every
/// variable the environment already holds. Call it before any thread starts.
pub fn load_dotenv_from(path: &Path) -> DotenvLoadInfo {
    let path_text = path.to_string_lossy().into_owned();
    let text = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) => {
            let error = if err.kind() == std::io::ErrorKind::NotFound {
                anyhow::anyhow!("ENOENT: no such file or directory, open '{path_text}'")
            } else {
                anyhow::Error::new(err)
            };
            return DotenvLoadInfo {
                path: path_text,
                loaded_count: 0,
                error: Some(error),
            };
        }
    };
    let parsed = parse(&text);
    for (key, value) in &parsed {
        if std::env::var_os(key).is_none() {
            // SAFETY: the load runs from `main` before the async runtime or any
            // other thread starts, so nothing reads the environment concurrently.
            unsafe { std::env::set_var(key, value) };
        }
    }
    DotenvLoadInfo {
        path: path_text,
        loaded_count: parsed.len(),
        error: None,
    }
}

static LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?m)(?:^|^)\s*(?:export\s+)?([A-Za-z0-9_.-]+)(?:\s*=\s*?|:\s+?)",
        r#"(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?"#,
        r"\s*(?:#[^\n\r\u{2028}\u{2029}]*)?(?:$|$)",
    ))
    .expect("valid regex")
});

/// Removes one pair of matching quotes around each line that holds a quoted
/// value: `/^(['"`])([\s\S]*)\1$/mg` replaced by `$2`.
fn strip_quotes(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut pos = 0;
    while pos <= value.len() {
        let line_end = value[pos..]
            .find('\n')
            .map(|i| pos + i)
            .unwrap_or(value.len());
        let quote = bytes
            .get(pos)
            .copied()
            .filter(|b| matches!(b, b'\'' | b'"' | b'`'));
        let close = quote.and_then(|q| {
            (pos + 1..value.len())
                .rev()
                .find(|&j| bytes[j] == q && (j + 1 == value.len() || bytes[j + 1] == b'\n'))
        });
        match close {
            Some(j) => {
                out.push_str(&value[pos + 1..j]);
                pos = j + 1;
                // The next match can start only at a line start.
                if pos < value.len() {
                    out.push('\n');
                }
                pos += 1;
            }
            None => {
                out.push_str(&value[pos..line_end]);
                if line_end < value.len() {
                    out.push('\n');
                }
                pos = line_end + 1;
            }
        }
    }
    out
}

/// Parses `.env` text as the `dotenv` package does. A later definition of a
/// key replaces an earlier one, in the earlier one's place.
pub fn parse(src: &str) -> IndexMap<String, String> {
    let lines = src.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = IndexMap::new();
    for caps in LINE.captures_iter(&lines) {
        let key = caps[1].to_string();
        let raw = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let trimmed = raw.trim();
        let maybe_quote = trimmed.chars().next();
        let mut value = strip_quotes(trimmed);
        if maybe_quote == Some('"') {
            value = value.replace("\\n", "\n").replace("\\r", "\r");
        }
        out.insert(key, value);
    }
    out
}

/// The process environment as a map, read once per call. A value that is not
/// UTF-8 is decoded lossily.
pub fn process_env() -> HashMap<String, String> {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[cfg(unix)]
    #[test]
    #[serial]
    fn keeps_the_terminal_resume_token_from_child_processes() {
        // SAFETY: serial test; the variable is removed again below.
        unsafe { std::env::set_var(TERMINAL_RESUME_TOKEN, "dummy-token-replace-me") };
        // SAFETY: serial test, as above.
        unsafe { remove_terminal_resume_token() };

        let output = std::process::Command::new("sh")
            .args(["-c", "printf %s \"${OSC7577_TOKEN-unset}\""])
            .output()
            .expect("sh runs");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "unset");
    }

    #[test]
    fn names_a_tls_provider_so_a_default_client_config_builds() {
        install_tls_provider();
        install_tls_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        // What `tokio-tungstenite` does for a `wss://` address; it panics with no provider.
        let _ = rustls::ClientConfig::builder();
    }

    #[test]
    fn parses_plain_quoted_and_commented_values() {
        let parsed = parse(
            "# comment\nA=1\nexport B = two words # note\nC='single'\nD=\"line\\nbreak\"\nE=\nF=pa$$word\n",
        );
        assert_eq!(parsed.get("A").map(String::as_str), Some("1"));
        assert_eq!(parsed.get("B").map(String::as_str), Some("two words"));
        assert_eq!(parsed.get("C").map(String::as_str), Some("single"));
        assert_eq!(parsed.get("D").map(String::as_str), Some("line\nbreak"));
        assert_eq!(parsed.get("E").map(String::as_str), Some(""));
        assert_eq!(parsed.get("F").map(String::as_str), Some("pa$$word"));
        assert_eq!(parsed.len(), 6);
    }

    #[test]
    fn keeps_a_hash_inside_quotes_and_reads_crlf_lines() {
        let parsed = parse("A=\"x # y\"\r\nB=2\r\n");
        assert_eq!(parsed.get("A").map(String::as_str), Some("x # y"));
        assert_eq!(parsed.get("B").map(String::as_str), Some("2"));
    }

    #[test]
    fn reads_a_multiline_quoted_value() {
        let parsed = parse("KEY=\"first\nsecond\"\nNEXT=1\n");
        assert_eq!(parsed.get("KEY").map(String::as_str), Some("first\nsecond"));
        assert_eq!(parsed.get("NEXT").map(String::as_str), Some("1"));
    }
}
