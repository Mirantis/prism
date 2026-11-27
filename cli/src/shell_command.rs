//! `! <command>` in the composer: the user runs a shell command in this terminal,
//! and the agent receives the command and its output as the user's message.
//!
//! The command gets the real terminal, so a login that prompts or opens a browser
//! works. `script(1)` records what it prints. On Windows, which has no `script`,
//! the output is piped and copied to the terminal.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use regex::Regex;

use crate::term::text::{js_len, js_slice_from, js_slice_to};

pub const SHELL_PREFIX: &str = "!";

/// Output beyond this is cut from the middle; the start and the end stay.
pub const MAX_SHELL_OUTPUT_CHARS: usize = 30_000;

#[derive(Clone, Debug, PartialEq)]
pub struct ShellRun {
    pub command: String,
    pub exit_code: i64,
    pub output: String,
}

/// The command after `!`, or `None` when the input is not a shell command.
pub fn shell_command_of(input: &str) -> Option<String> {
    input
        .strip_prefix(SHELL_PREFIX)
        .map(|rest| rest.trim().to_string())
}

/// Run `command` in the user's shell in the working directory, with the terminal.
/// The caller hands the terminal over first.
pub fn run_shell_command(command: &str) -> std::io::Result<ShellRun> {
    let dir = tempfile_dir("prism-shell-")?;
    let log = dir.join("typescript");
    let result = if cfg!(windows) {
        run_piped(command).map(|(exit_code, output)| ShellRun {
            command: command.into(),
            exit_code,
            output: output.finish(|t, _| t.to_string()),
        })
    } else {
        run_recorded(command, &log).map(|exit_code| ShellRun {
            command: command.into(),
            exit_code,
            output: read_recording(&log).finish(strip_script_banner),
        })
    };
    let _ = std::fs::remove_dir_all(&dir);
    result
}

pub fn tempfile_dir(prefix: &str) -> std::io::Result<std::path::PathBuf> {
    let base = std::env::temp_dir();
    for _ in 0..16 {
        let name: String = format!(
            "{prefix}{}",
            &uuid::Uuid::new_v4().simple().to_string()[..6]
        );
        let dir = base.join(name);
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other(
        "could not create a temporary directory",
    ))
}

fn exit_code_of(status: std::process::ExitStatus) -> i64 {
    if let Some(code) = status.code() {
        return code as i64;
    }
    128
}

fn run_recorded(command: &str, log: &std::path::Path) -> std::io::Result<i64> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let log = log.display().to_string();
    // util-linux `script` runs `-c` through $SHELL and returns the command's status with `-e`;
    // the BSD `script` on macOS takes the command as arguments and always returns its status.
    let args: Vec<String> = if cfg!(target_os = "linux") {
        vec!["-q".into(), "-e".into(), "-c".into(), command.into(), log]
    } else {
        vec!["-q".into(), log, shell, "-c".into(), command.into()]
    };
    let status = Command::new("script").args(&args).status()?;
    Ok(exit_code_of(status))
}

fn run_piped(command: &str) -> std::io::Result<(i64, OutputCapture)> {
    let mut child = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", command])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?
    } else {
        Command::new("sh")
            .args(["-c", command])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let _ = std::io::stderr().write_all(&chunk[..n]);
            buf.extend_from_slice(&chunk[..n]);
        }
        buf
    });
    let mut output = OutputCapture::default();
    let mut pending = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(n) = stdout.read(&mut chunk) {
        if n == 0 {
            break;
        }
        let _ = std::io::stdout().write_all(&chunk[..n]);
        pending.extend_from_slice(&chunk[..n]);
        let valid = utf8_prefix_len(&pending);
        output.push(&String::from_utf8_lossy(&pending[..valid]));
        pending.drain(..valid);
    }
    output.push(&String::from_utf8_lossy(&pending));
    let err = err_thread.join().unwrap_or_default();
    output.push(&String::from_utf8_lossy(&err));
    let status = child.wait()?;
    Ok((exit_code_of(status), output))
}

/// The length of the longest prefix that does not end inside a UTF-8 character.
fn utf8_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

/// Read the `script` log a chunk at a time, so a huge recording is never held whole.
fn read_recording(log: &std::path::Path) -> OutputCapture {
    let mut output = OutputCapture::default();
    let Ok(mut file) = std::fs::File::open(log) else {
        return output;
    };
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending = Vec::new();
    while let Ok(n) = file.read(&mut buf) {
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        let valid = utf8_prefix_len(&pending);
        output.push(&String::from_utf8_lossy(&pending[..valid]));
        pending.drain(..valid);
    }
    output.push(&String::from_utf8_lossy(&pending));
    output
}

/// Each kept end of the raw output.
const CAPTURE_END_CHARS: usize = (MAX_SHELL_OUTPUT_CHARS - 100) / 2;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Whole,
    Head,
    Tail,
}

/// The output as it arrives, kept to its first and last `CAPTURE_END_CHARS` characters.
#[derive(Default)]
pub struct OutputCapture {
    head: String,
    tail: String,
    cut: usize,
}

impl OutputCapture {
    pub fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut text = text;
        let head_len = js_len(&self.head);
        if head_len < CAPTURE_END_CHARS {
            let room = CAPTURE_END_CHARS - head_len;
            self.head.push_str(js_slice_to(text, room));
            text = js_slice_from(text, room);
            if text.is_empty() {
                return;
            }
        }
        self.tail.push_str(text);
        let tail_len = js_len(&self.tail);
        if tail_len > 2 * CAPTURE_END_CHARS {
            self.cut += tail_len - CAPTURE_END_CHARS;
            self.tail = js_slice_from(&self.tail, tail_len - CAPTURE_END_CHARS).to_string();
        }
    }

    /// The text a reader saw. `prepare` edits the raw text first.
    pub fn finish(mut self, prepare: impl Fn(&str, Part) -> String) -> String {
        let tail_len = js_len(&self.tail);
        if tail_len > CAPTURE_END_CHARS {
            self.cut += tail_len - CAPTURE_END_CHARS;
            self.tail = js_slice_from(&self.tail, tail_len - CAPTURE_END_CHARS).to_string();
        }
        if self.cut == 0 {
            return clean_terminal_output(&prepare(
                &format!("{}{}", self.head, self.tail),
                Part::Whole,
            ));
        }
        [
            clean_terminal_output(&prepare(&self.head, Part::Head)),
            format!("[… {} characters cut …]", self.cut),
            clean_terminal_output(&prepare(&self.tail, Part::Tail)),
        ]
        .join("\n")
    }
}

/// util-linux `script` writes a start and an end line into the log, even with `-q`.
fn strip_script_banner(text: &str, part: Part) -> String {
    static START: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^Script started on [^\n]*\n").unwrap());
    static END: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\n?Script done on [^\n]*\n?$").unwrap());
    let mut text = text.to_string();
    if part != Part::Tail {
        text = START.replace(&text, "").into_owned();
    }
    if part != Part::Head {
        text = END.replace(&text, "").into_owned();
    }
    text
}

/// Node's `stripVTControlCharacters`.
fn strip_vt(raw: &str) -> String {
    static VT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"[\x1b\x{9b}][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\x07|\x1b\\))|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))").unwrap()
    });
    VT.replace_all(raw, "").into_owned()
}

/// Reduce a terminal recording to the text a reader saw: no escape sequences, and
/// on each line `\r` and backspace move the cursor back, so later text overwrites.
pub fn clean_terminal_output(raw: &str) -> String {
    static CRLF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r+\n").unwrap());
    let stripped = strip_vt(raw);
    let text = CRLF.replace_all(&stripped, "\n");
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let mut screen: Vec<char> = Vec::new();
            let mut cursor = 0usize;
            for ch in line.chars() {
                match ch {
                    '\r' => cursor = 0,
                    '\x08' => cursor = cursor.saturating_sub(1),
                    _ => {
                        if cursor < screen.len() {
                            screen[cursor] = ch;
                        } else {
                            while screen.len() < cursor {
                                screen.push(' ');
                            }
                            screen.push(ch);
                        }
                        cursor += 1;
                    }
                }
            }
            screen
                .into_iter()
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect();
    lines.join("\n").trim().to_string()
}

const OPEN: &str = "<user-shell-command>";
const CLOSE: &str = "</user-shell-command>";

/// The message the agent receives: the command, its exit code and its output.
pub fn format_shell_record(run: &ShellRun) -> String {
    [
        OPEN.to_string(),
        format!("<command>{}</command>", run.command),
        format!("<exit-code>{}</exit-code>", run.exit_code),
        "<output>".into(),
        truncate_middle(&run.output, MAX_SHELL_OUTPUT_CHARS),
        "</output>".into(),
        CLOSE.into(),
    ]
    .join("\n")
}

/// The run in a message written by `format_shell_record`, or `None` for any other message.
pub fn parse_shell_record(content: &str) -> Option<ShellRun> {
    static RECORD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^<user-shell-command>\n<command>([\s\S]*?)</command>\n<exit-code>(-?\d+)</exit-code>\n<output>\n([\s\S]*)\n</output>\n</user-shell-command>$").unwrap()
    });
    if !content.starts_with(OPEN) || !content.ends_with(CLOSE) {
        return None;
    }
    let caps = RECORD.captures(content)?;
    Some(ShellRun {
        command: caps[1].to_string(),
        exit_code: caps[2].parse().ok()?,
        output: caps[3].to_string(),
    })
}

fn truncate_middle(text: &str, max: usize) -> String {
    let len = js_len(text);
    if len <= max {
        return text.to_string();
    }
    let half = max / 2;
    let cut = len - 2 * half;
    format!(
        "{}\n[… {cut} characters cut …]\n{}",
        js_slice_to(text, half),
        js_slice_from(text, len - half)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_prefix() {
        assert_eq!(
            shell_command_of("! aws sso login").as_deref(),
            Some("aws sso login")
        );
        assert_eq!(shell_command_of("!").as_deref(), Some(""));
        assert_eq!(shell_command_of("hello"), None);
    }

    #[test]
    fn a_record_round_trips() {
        let run = ShellRun {
            command: "ls".into(),
            exit_code: 3,
            output: "a\nb".into(),
        };
        assert_eq!(parse_shell_record(&format_shell_record(&run)), Some(run));
    }

    #[test]
    fn cleans_carriage_returns_and_escapes() {
        assert_eq!(
            clean_terminal_output("progress 10%\rprogress 100%\r\n\x1b[32mok\x1b[0m"),
            "progress 100%\nok"
        );
        assert_eq!(clean_terminal_output("abc\x08\x08X"), "aXc");
    }

    #[test]
    fn keeps_both_ends_of_long_output() {
        let mut capture = OutputCapture::default();
        capture.push(&"a".repeat(20_000));
        capture.push(&"b".repeat(20_000));
        let text = capture.finish(|t, _| t.to_string());
        assert!(text.starts_with('a') && text.ends_with('b'));
        assert!(text.contains("characters cut"));
    }

    #[test]
    fn strips_the_util_linux_banner() {
        let text = "Script started on 2026\nhello\nScript done on 2026\n";
        assert_eq!(strip_script_banner(text, Part::Whole), "hello");
    }
}
