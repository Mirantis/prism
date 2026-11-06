//! Program status reports, OSC 7501
//! (https://www.superlogical.com/rex/docs/build/program-status). A terminal, or a
//! supervisor that reads the runtime's output, shows the reported state, and every
//! other terminal ignores the sequence.

use base64::Engine;
use serde::{Deserialize, Serialize};

/// The state a report names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ProgramStatus {
    Idle,
    Working { msg: String },
    Done { msg: String },
    Error { msg: String },
    Blocked { kind: BlockedKind, msg: String },
}

/// What a blocked program waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockedKind {
    Auth,
    Question,
}

impl BlockedKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockedKind::Auth => "auth",
            BlockedKind::Question => "question",
        }
    }
}

impl ProgramStatus {
    /// The `state` value of the report.
    pub fn state(&self) -> &'static str {
        match self {
            ProgramStatus::Idle => "idle",
            ProgramStatus::Working { .. } => "working",
            ProgramStatus::Done { .. } => "done",
            ProgramStatus::Error { .. } => "error",
            ProgramStatus::Blocked { .. } => "blocked",
        }
    }

    fn msg(&self) -> Option<&str> {
        match self {
            ProgramStatus::Idle => None,
            ProgramStatus::Working { msg }
            | ProgramStatus::Done { msg }
            | ProgramStatus::Error { msg }
            | ProgramStatus::Blocked { msg, .. } => Some(msg),
        }
    }
}

/// The stable identifier a terminal groups this program's records by.
const APP: &str = "prism";

/// The longest decoded `msg` and `title` the specification allows. A terminal discards a longer report whole.
const MAX_MSG_BYTES: usize = 2048;
const MAX_TITLE_BYTES: usize = 192;

/// The report that removes every record this program wrote.
pub const CLEAR_SEQUENCE: &str = "\x1b]7501;state=clear\x1b\\";

/// The report for the terminal's root record, terminated with ST. A report replaces
/// its record whole, so each one names the program and has the title.
pub fn program_status_sequence(status: &ProgramStatus, title: &str) -> String {
    let mut pairs = vec![format!("state={}", status.state())];
    if let ProgramStatus::Blocked { kind, .. } = status {
        pairs.push(format!("kind={}", kind.as_str()));
    }
    pairs.push(format!("app={APP}"));
    pairs.push(format!("title={}", encode_line(title, MAX_TITLE_BYTES)));
    if let Some(msg) = status.msg() {
        pairs.push(format!("msg={}", encode_line(msg, MAX_MSG_BYTES)));
    }
    format!("\x1b]7501;{}\x1b\\", pairs.join(":"))
}

/// Base64 of one UTF-8 line. A terminal refuses a control character in the text, so
/// each one becomes a space, and the text is cut on a whole character at the limit.
fn encode_line(text: &str, max_bytes: usize) -> String {
    let mut bytes = Vec::with_capacity(max_bytes.min(text.len()));
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        let encoded = ch.encode_utf8(&mut buf).as_bytes();
        if bytes.len() + encoded.len() > max_bytes {
            break;
        }
        bytes.extend_from_slice(encoded);
    }
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}
