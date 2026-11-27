//! Keyboard input: raw terminal bytes split into key presses, and each press
//! named the way Ink's `useInput` names it (`input` plus `Key` flags).
//!
//! A chunk of plain text stays one event, as a paste does in Ink; backspace and
//! Ctrl+C bytes are split out of it. A lone Escape waits briefly for the rest of
//! a sequence before it counts as the Escape key.

use std::sync::LazyLock;

use regex::Regex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Key {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
    pub page_up: bool,
    pub page_down: bool,
    pub home: bool,
    pub end: bool,
    pub ret: bool,
    pub escape: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub tab: bool,
    pub backspace: bool,
    pub delete: bool,
    pub meta: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyEvent {
    pub input: String,
    pub key: Key,
}

impl KeyEvent {
    pub fn is_ctrl(&self, c: char) -> bool {
        self.key.ctrl && self.input.len() == 1 && self.input.starts_with(c)
    }
}

const ESC: char = '\x1b';

/// Splits terminal input into events, holding an unfinished escape sequence for the next chunk.
#[derive(Default)]
pub struct InputParser {
    pending: Vec<char>,
}

enum Parsed {
    Pending,
    Invalid,
    Sequence(usize),
}

fn is_param(c: char) -> bool {
    ('\x30'..='\x3f').contains(&c)
}
fn is_intermediate(c: char) -> bool {
    ('\x20'..='\x2f').contains(&c)
}
fn is_final(c: char) -> bool {
    ('\x40'..='\x7e').contains(&c)
}

fn parse_csi(input: &[char], start: usize, prefix: usize) -> Parsed {
    let payload = start + prefix + 1;
    let mut i = payload;
    while i < input.len() {
        let c = input[i];
        if c == '[' && i == payload {
            i += 1;
            continue;
        }
        let rxvt_shift = c == '$' && i == payload + 1 && "235678".contains(input[payload]);
        if rxvt_shift || is_final(c) {
            return Parsed::Sequence(i + 1);
        }
        if is_param(c) || is_intermediate(c) {
            i += 1;
            continue;
        }
        return Parsed::Invalid;
    }
    Parsed::Pending
}

fn parse_ss3(input: &[char], start: usize, prefix: usize) -> Parsed {
    let mut i = start + prefix + 1;
    while i < input.len() {
        let c = input[i];
        if is_final(c) {
            return Parsed::Sequence(i + 1);
        }
        if c != ';' && !c.is_ascii_digit() {
            return Parsed::Invalid;
        }
        i += 1;
    }
    Parsed::Pending
}

fn parse_control(input: &[char], start: usize, prefix: usize) -> Parsed {
    match input.get(start + prefix) {
        None => Parsed::Pending,
        Some('[') => parse_csi(input, start, prefix),
        Some('O') => parse_ss3(input, start, prefix),
        Some(_) => Parsed::Invalid,
    }
}

/// The end of the escape sequence at `at`, or `None` while it is unfinished.
fn parse_escape(input: &[char], at: usize) -> Option<usize> {
    if at == input.len() - 1 {
        return None;
    }
    if input[at + 1] == ESC {
        if at + 2 >= input.len() {
            return None;
        }
        return match parse_control(input, at, 2) {
            Parsed::Pending => None,
            Parsed::Sequence(end) => Some(end),
            Parsed::Invalid => Some(at + 2),
        };
    }
    match parse_control(input, at, 1) {
        Parsed::Pending => None,
        Parsed::Sequence(end) => Some(end),
        Parsed::Invalid => Some(at + 2),
    }
}

fn split_control_bytes(text: &[char], events: &mut Vec<String>) {
    let mut start = 0;
    for (i, c) in text.iter().enumerate() {
        if !matches!(c, '\x7f' | '\x08' | '\x03') {
            continue;
        }
        if i > start {
            events.push(text[start..i].iter().collect());
        }
        events.push(c.to_string());
        start = i + 1;
    }
    if start < text.len() {
        events.push(text[start..].iter().collect());
    }
}

impl InputParser {
    pub fn new() -> InputParser {
        InputParser::default()
    }

    /// The events in `chunk` and whatever was pending before it.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        let mut input = std::mem::take(&mut self.pending);
        input.extend(chunk.chars());
        let mut events = Vec::new();
        let mut i = 0;
        while i < input.len() {
            let Some(esc) = input[i..].iter().position(|c| *c == ESC).map(|p| p + i) else {
                split_control_bytes(&input[i..], &mut events);
                return events;
            };
            if esc > i {
                split_control_bytes(&input[i..esc], &mut events);
            }
            let Some(end) = parse_escape(&input, esc) else {
                self.pending = input[esc..].to_vec();
                return events;
            };
            events.push(input[esc..end].iter().collect());
            i = end;
        }
        events
    }

    /// An escape is waiting for the rest of its sequence.
    pub fn has_pending_escape(&self) -> bool {
        self.pending.first() == Some(&ESC)
    }

    /// Give up waiting: the pending escape is an event of its own.
    pub fn flush_pending_escape(&mut self) -> Option<String> {
        if self.pending.first() != Some(&ESC) {
            return None;
        }
        Some(std::mem::take(&mut self.pending).into_iter().collect())
    }
}

#[derive(Default)]
struct Keypress {
    name: String,
    ctrl: bool,
    meta: bool,
    shift: bool,
    sequence: String,
}

static FN_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))")
        .unwrap()
});

fn key_name(code: &str) -> &'static str {
    match code {
        "OP" | "[P" | "[11~" | "[[A" => "f1",
        "OQ" | "[Q" | "[12~" | "[[B" => "f2",
        "OR" | "[R" | "[13~" | "[[C" => "f3",
        "OS" | "[S" | "[14~" | "[[D" => "f4",
        "[[E" | "[15~" => "f5",
        "[17~" => "f6",
        "[18~" => "f7",
        "[19~" => "f8",
        "[20~" => "f9",
        "[21~" => "f10",
        "[23~" => "f11",
        "[24~" => "f12",
        "[A" | "OA" | "[a" | "Oa" => "up",
        "[B" | "OB" | "[b" | "Ob" => "down",
        "[C" | "OC" | "[c" | "Oc" => "right",
        "[D" | "OD" | "[d" | "Od" => "left",
        "[E" | "OE" | "[e" | "Oe" => "clear",
        "[F" | "OF" | "[4~" | "[8~" | "[8$" | "[8^" => "end",
        "[H" | "OH" | "[1~" | "[7~" | "[7$" | "[7^" => "home",
        "[2~" | "[2$" | "[2^" => "insert",
        "[3~" | "[3$" | "[3^" => "delete",
        "[5~" | "[[5~" | "[5$" | "[5^" => "pageup",
        "[6~" | "[[6~" | "[6$" | "[6^" => "pagedown",
        "[Z" => "tab",
        _ => "",
    }
}

const NON_ALPHANUMERIC: &[&str] = &[
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "up",
    "down",
    "right",
    "left",
    "clear",
    "end",
    "home",
    "insert",
    "delete",
    "pageup",
    "pagedown",
    "tab",
    "backspace",
];

fn parse_keypress(s: &str) -> Keypress {
    let mut k = Keypress {
        sequence: s.to_string(),
        ..Keypress::default()
    };
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    let ctrl_char = |c: char| c <= '\x1f';
    if s == "\r" || s == "\x1b\r" {
        k.name = "return".into();
        k.meta = len == 2;
    } else if s == "\x1bOM" || s == "\x1b\x1bOM" {
        k.name = "return".into();
        k.sequence = "\r".into();
        k.meta = len == 4;
    } else if s == "\n" {
        k.name = "enter".into();
    } else if s == "\t" || s == "\x1b\t" {
        k.name = "tab".into();
        k.meta = len == 2;
    } else if s == "\x08" || s == "\x1b\x08" || s == "\x7f" || s == "\x1b\x7f" {
        k.name = "backspace".into();
        k.meta = chars[0] == ESC;
    } else if s == "\x1b" || s == "\x1b\x1b" {
        k.name = "escape".into();
        k.meta = len == 2;
    } else if (len == 1 && (chars[0] == ' ' || chars[0] == '\0'))
        || (len == 2 && chars[0] == ESC && (chars[1] == ' ' || chars[1] == '\0'))
    {
        k.name = "space".into();
        k.ctrl = s.ends_with('\0');
        k.meta = len == 2;
    } else if (len == 1 && ctrl_char(chars[0]))
        || (len == 2 && chars[0] == ESC && ctrl_char(chars[1]))
    {
        let code = *chars.last().unwrap() as u32;
        let letter = code + if code <= 26 { 96 } else { 64 };
        k.name = char::from_u32(letter).map(String::from).unwrap_or_default();
        k.ctrl = true;
        k.meta = len == 2;
    } else if len == 1 && chars[0].is_ascii_digit() {
        k.name = "number".into();
    } else if len == 1 && chars[0].is_ascii_lowercase() {
        k.name = s.into();
    } else if len == 1 && chars[0].is_ascii_uppercase() {
        k.name = s.to_lowercase();
        k.shift = true;
    } else if len == 2 && chars[0] == ESC && !chars[1].is_control() && chars[1] != '[' {
        k.name = chars[1].to_lowercase().collect();
        k.meta = true;
        k.shift = chars[1].is_ascii_uppercase();
    } else if let Some(caps) = FN_KEY.captures(s) {
        if len >= 2 && chars[0] == ESC && chars[1] == ESC {
            k.meta = true;
        }
        let code: String = [caps.get(1), caps.get(2), caps.get(4), caps.get(6)]
            .iter()
            .flatten()
            .map(|m| m.as_str())
            .collect();
        let modifier = caps
            .get(3)
            .or(caps.get(5))
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(1)
            .saturating_sub(1);
        k.ctrl = modifier & 4 != 0;
        k.meta = k.meta || modifier & 10 != 0;
        k.shift = modifier & 1 != 0;
        k.name = key_name(&code).into();
        let shift_codes = [
            "[a", "[b", "[c", "[d", "[e", "[2$", "[3$", "[5$", "[6$", "[7$", "[8$", "[Z",
        ];
        let ctrl_codes = [
            "Oa", "Ob", "Oc", "Od", "Oe", "[2^", "[3^", "[5^", "[6^", "[7^", "[8^",
        ];
        k.shift = shift_codes.contains(&code.as_str()) || k.shift;
        k.ctrl = ctrl_codes.contains(&code.as_str()) || k.ctrl;
    }
    k
}

/// Whether `event` is exactly one complete CSI or SS3 sequence.
fn is_complete_control_sequence(event: &str) -> bool {
    let chars: Vec<char> = event.chars().collect();
    if chars.first() != Some(&ESC) {
        return false;
    }
    let prefix = if chars.get(1) == Some(&ESC) { 2 } else { 1 };
    matches!(parse_control(&chars, 0, prefix), Parsed::Sequence(end) if end == chars.len())
}

/// The key an input event stands for, or `None` for a terminal reply that maps to no key.
pub fn key_event(event: &str) -> Option<KeyEvent> {
    let press = parse_keypress(event);
    if is_complete_control_sequence(event) && press.name.is_empty() {
        return None;
    }
    let mut key = Key {
        up: press.name == "up",
        down: press.name == "down",
        left: press.name == "left",
        right: press.name == "right",
        page_down: press.name == "pagedown",
        page_up: press.name == "pageup",
        home: press.name == "home",
        end: press.name == "end",
        ret: press.name == "return",
        escape: press.name == "escape",
        ctrl: press.ctrl,
        shift: press.shift,
        tab: press.name == "tab",
        backspace: press.name == "backspace",
        delete: press.name == "delete",
        meta: press.meta,
    };
    let mut input = if press.ctrl {
        if press.name == "space" {
            " ".to_string()
        } else {
            press.name.clone()
        }
    } else {
        press.sequence.clone()
    };
    if NON_ALPHANUMERIC.contains(&press.name.as_str()) {
        input.clear();
    }
    if let Some(rest) = input.strip_prefix(ESC) {
        input = rest.to_string();
    }
    if input.chars().count() == 1 && input.chars().all(|c| c.is_ascii_uppercase()) {
        key.shift = true;
    }
    Some(KeyEvent { input, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&str]) -> Vec<String> {
        let mut p = InputParser::new();
        chunks.iter().flat_map(|c| p.push(c)).collect()
    }

    #[test]
    fn keeps_typed_text_as_one_event() {
        assert_eq!(events(&["/exit "]), vec!["/exit "]);
    }

    #[test]
    fn splits_out_backspace_and_ctrl_c() {
        assert_eq!(events(&["ab\x7fc\x03"]), vec!["ab", "\x7f", "c", "\x03"]);
    }

    #[test]
    fn joins_a_sequence_split_across_chunks() {
        assert_eq!(events(&["\x1b[", "A"]), vec!["\x1b[A"]);
    }

    #[test]
    fn names_keys_like_ink() {
        let up = key_event("\x1b[A").unwrap();
        assert!(up.key.up);
        assert_eq!(up.input, "");
        let ret = key_event("\r").unwrap();
        assert!(ret.key.ret);
        let ctrl_o = key_event("\x0f").unwrap();
        assert!(ctrl_o.key.ctrl);
        assert_eq!(ctrl_o.input, "o");
        let esc = key_event("\x1b").unwrap();
        assert!(esc.key.escape);
        assert_eq!(esc.input, "");
        let bs = key_event("\x08").unwrap();
        assert!(bs.key.backspace);
        let shift_tab = key_event("\x1b[Z").unwrap();
        assert!(shift_tab.key.tab && shift_tab.key.shift);
        assert_eq!(key_event("x").unwrap().input, "x");
    }

    #[test]
    fn drops_terminal_replies() {
        assert_eq!(key_event("\x1b[?62;22c"), None);
    }

    #[test]
    fn holds_a_lone_escape() {
        let mut p = InputParser::new();
        assert!(p.push("\x1b").is_empty());
        assert!(p.has_pending_escape());
        assert_eq!(p.flush_pending_escape().as_deref(), Some("\x1b"));
    }
}
