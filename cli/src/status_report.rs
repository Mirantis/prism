//! Program status reports for the terminal, OSC 7501
//! (https://www.superlogical.com/rex/docs/build/program-status). A terminal that
//! supports the sequence shows the reported state in its tab or window, and every
//! other terminal ignores it.

use base64::Engine;

#[derive(Clone, Debug, PartialEq)]
pub enum ProgramStatus {
    Idle,
    Clear,
    Working(String),
    Done(String),
    Error(String),
    BlockedAuth(String),
}

const APP: &str = "prism";

/// The longest decoded `msg` the specification allows.
const MAX_MSG_BYTES: usize = 2048;

/// The report for the terminal's root record, terminated with ST.
pub fn program_status_sequence(status: &ProgramStatus) -> String {
    let (state, kind, msg) = match status {
        ProgramStatus::Idle => ("idle", None, None),
        ProgramStatus::Clear => ("clear", None, None),
        ProgramStatus::Working(m) => ("working", None, Some(m)),
        ProgramStatus::Done(m) => ("done", None, Some(m)),
        ProgramStatus::Error(m) => ("error", None, Some(m)),
        ProgramStatus::BlockedAuth(m) => ("blocked", Some("auth"), Some(m)),
    };
    let mut pairs = vec![format!("state={state}")];
    if let Some(kind) = kind {
        pairs.push(format!("kind={kind}"));
    }
    if state != "clear" {
        pairs.push(format!("app={APP}"));
    }
    if let Some(msg) = msg {
        pairs.push(format!("msg={}", encode_line(msg)));
    }
    format!("\x1b]7501;{}\x1b\\", pairs.join(":"))
}

/// Base64 of one UTF-8 line: each control character becomes a space, and the
/// text is cut on a whole character at the limit.
fn encode_line(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        let c = if c.is_control() { ' ' } else { c };
        if out.len() + c.len_utf8() > MAX_MSG_BYTES {
            break;
        }
        out.push(c);
    }
    base64::engine::general_purpose::STANDARD.encode(out.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_report() {
        assert_eq!(
            program_status_sequence(&ProgramStatus::Idle),
            "\x1b]7501;state=idle:app=prism\x1b\\"
        );
        assert_eq!(
            program_status_sequence(&ProgramStatus::Clear),
            "\x1b]7501;state=clear\x1b\\"
        );
        assert_eq!(
            program_status_sequence(&ProgramStatus::BlockedAuth("x".into())),
            "\x1b]7501;state=blocked:kind=auth:app=prism:msg=eA==\x1b\\"
        );
    }

    #[test]
    fn replaces_control_characters() {
        assert_eq!(
            encode_line("a\nb"),
            base64::engine::general_purpose::STANDARD.encode("a b")
        );
    }
}
