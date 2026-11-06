//! The user's hand on the desktop: pointer, buttons, wheel and keys sent by the page while
//! it holds the pointer lock, turned into X input on the virtual display.
//!
//! One long-lived `xdotool -` reads commands from stdin, one per line, so a stream of mouse
//! movement costs a line each rather than a process each. Movement arrives as deltas: the
//! page has no cursor of its own while locked, so the position lives here, clamped to the
//! screen it is given, and is flushed a few dozen times a second. Buttons and keys go
//! straight through on the same stream, behind any movement already queued, so a click
//! lands where the pointer was last put.
//!
//! Keys arrive as the browser names them (`KeyboardEvent.key` and `code`, plus modifier
//! flags) and leave as X keysyms: a printable character is its own keysym, or a Unicode
//! one, so the layout of the page's keyboard does not matter; a named key is mapped; a
//! modifier alone is ignored, since it reaches the display as part of the chord it
//! modifies. A text pasted on the page is typed out, character by character, into whatever
//! has focus on the desktop.

use std::collections::HashMap;

use indexmap::IndexMap;
use std::sync::LazyLock;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::{Child, ChildStdin};
use tokio::task::JoinHandle;

use super::desktop_control::{DesktopControl, MouseButton};

/// One input frame from the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputFrame {
    Pointer { x: f64, y: f64 },
    PointerMove { dx: f64, dy: f64 },
    PointerButton { button: MouseButton, down: bool },
    Wheel { dy: f64 },
    Key(KeyFrame),
    Text { text: String },
}

/// A key event from the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyFrame {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// What a Mac's Command key becomes: `ctrl` on the runtime's own desktop, `super` on a
/// remote computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MetaAs {
    Ctrl,
    Super,
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn button_of(value: Option<&Value>) -> Option<MouseButton> {
    match value.and_then(Value::as_str) {
        Some("left") => Some(MouseButton::Left),
        Some("middle") => Some(MouseButton::Middle),
        Some("right") => Some(MouseButton::Right),
        _ => None,
    }
}

/// A frame the page sent, read as input for the display, or `None` for anything else.
///
/// The page's JSON arrives over a socket, so a frame's `type` says what it claims to be
/// and nothing more: each field the display needs is checked here. `handle` is the only
/// way in and it starts with this, so a frame missing a key or a coordinate is dropped at
/// the door rather than reaching code that reads it as a string or a number.
pub fn input_frame(value: &Value) -> Option<InputFrame> {
    let frame = value.as_object()?;
    match frame.get("type").and_then(Value::as_str)? {
        "pointer" => Some(InputFrame::Pointer {
            x: finite(frame.get("x"))?,
            y: finite(frame.get("y"))?,
        }),
        "pointer_move" => Some(InputFrame::PointerMove {
            dx: finite(frame.get("dx"))?,
            dy: finite(frame.get("dy"))?,
        }),
        "pointer_button" => Some(InputFrame::PointerButton {
            button: button_of(frame.get("button"))?,
            down: frame.get("down").and_then(Value::as_bool)?,
        }),
        "wheel" => Some(InputFrame::Wheel {
            dy: finite(frame.get("dy"))?,
        }),
        "key" => Some(InputFrame::Key(KeyFrame {
            key: frame.get("key").and_then(Value::as_str)?.to_string(),
            code: frame
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string),
            ctrl: frame.get("ctrl") == Some(&Value::Bool(true)),
            alt: frame.get("alt") == Some(&Value::Bool(true)),
            shift: frame.get("shift") == Some(&Value::Bool(true)),
            meta: frame.get("meta") == Some(&Value::Bool(true)),
        })),
        "text" => Some(InputFrame::Text {
            text: frame.get("text").and_then(Value::as_str)?.to_string(),
        }),
        _ => None,
    }
}

/// The most a paste types. xdotool types about eighty characters a second, so this is two
/// minutes of typing; a longer paste is cut, not refused, since the start is usually what
/// was wanted.
pub const MAX_PASTE_CHARS: usize = 10_000;

/// The part of a pasted text that gets typed: its first `MAX_PASTE_CHARS` code points.
pub fn paste_text(text: &str) -> String {
    text.chars().take(MAX_PASTE_CHARS).collect()
}

/// How long movement is gathered before one `mousemove` goes out.
const MOVE_FLUSH_MS: u64 = 16;
/// Wheel pixels per wheel click, so a flick is a few clicks and not fifty.
const WHEEL_PIXELS_PER_CLICK: f64 = 60.0;
const MAX_WHEEL_CLICKS: i64 = 10;

/// Browser key names with a different X keysym.
fn named_key(key: &str) -> Option<&'static str> {
    Some(match key {
        "Enter" => "Return",
        "Backspace" => "BackSpace",
        "Tab" => "Tab",
        "Delete" => "Delete",
        "Insert" => "Insert",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "Prior",
        "PageDown" => "Next",
        "CapsLock" => "Caps_Lock",
        "ContextMenu" => "Menu",
        " " => "space",
        _ => return None,
    })
}

/// ASCII punctuation by keysym name; anything else printable goes as a Unicode keysym.
fn punctuation(key: &str) -> Option<&'static str> {
    Some(match key {
        "!" => "exclam",
        "\"" => "quotedbl",
        "#" => "numbersign",
        "$" => "dollar",
        "%" => "percent",
        "&" => "ampersand",
        "'" => "apostrophe",
        "(" => "parenleft",
        ")" => "parenright",
        "*" => "asterisk",
        "+" => "plus",
        "," => "comma",
        "-" => "minus",
        "." => "period",
        "/" => "slash",
        ":" => "colon",
        ";" => "semicolon",
        "<" => "less",
        "=" => "equal",
        ">" => "greater",
        "?" => "question",
        "@" => "at",
        "[" => "bracketleft",
        "\\" => "backslash",
        "]" => "bracketright",
        "^" => "asciicircum",
        "_" => "underscore",
        "`" => "grave",
        "{" => "braceleft",
        "|" => "bar",
        "}" => "braceright",
        "~" => "asciitilde",
        _ => return None,
    })
}

/// Keys that are modifiers on their own; the page's other keys hold them as flags.
const MODIFIER_KEYS: [&str; 5] = ["Control", "Shift", "Alt", "Meta", "AltGraph"];

static FUNCTION_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^F([1-9]|1[0-2])$").expect("valid regex"));
static ALPHANUMERIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9]$").expect("valid regex"));

/// The X keysym for a browser key name, or `None` for one that has no place on the display.
pub fn keysym_for(key: &str) -> Option<String> {
    if let Some(named) = named_key(key) {
        return Some(named.to_string());
    }
    if FUNCTION_KEY.is_match(key) {
        return Some(key.to_string());
    }
    let mut chars = key.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if ALPHANUMERIC.is_match(key) {
        return Some(key.to_string());
    }
    if let Some(name) = punctuation(key) {
        return Some(name.to_string());
    }
    Some(format!("U{:04X}", first as u32))
}

/// The character a physical key types on its own, for the `KeyboardEvent.code` values that
/// name one.
fn base_character_for(code: Option<&str>) -> Option<String> {
    let code = code.filter(|c| !c.is_empty())?;
    if let Some(letter) = code.strip_prefix("Key") {
        if letter.len() == 1 && letter.as_bytes()[0].is_ascii_uppercase() {
            return Some(letter.to_ascii_lowercase());
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() {
            return Some(digit.to_string());
        }
    }
    let base = match code {
        "Minus" => "-",
        "Equal" => "=",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Backslash" => "\\",
        "Semicolon" => ";",
        "Quote" => "'",
        "Backquote" => "`",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "IntlBackslash" => "<",
        "Space" => " ",
        _ => return None,
    };
    Some(base.to_string())
}

/// Whether Alt was part of typing this character rather than a modifier on it. On a Mac the
/// Option key is how a layout reaches its second set of characters — `@` is Option+2 on a
/// Finnish keyboard — and the browser then reports the character with the Alt flag set. The
/// physical key tells the two apart: when the key's own character is not the one reported,
/// the Alt produced it. Without the physical key, a letter or digit keeps its Alt and any
/// other character drops it.
fn alt_typed_character(frame: &KeyFrame) -> bool {
    if !frame.alt || frame.key.chars().count() != 1 {
        return false;
    }
    match base_character_for(frame.code.as_deref()) {
        None => !ALPHANUMERIC.is_match(&frame.key),
        Some(base) => frame.key.to_lowercase() != base,
    }
}

/// The `xdotool key` argument for a key event, or `None` for a modifier alone or a key with
/// no keysym. A printable character already has its own shift (an `A`, an `!`), so shift
/// is spelled out only for a named key, where "shift+Tab" and "Tab" are different keys. Cmd
/// on a Mac goes out as Ctrl: it is the key a Mac user presses for copy, paste and
/// select-all, which the desktop's applications bind to Ctrl, while Super, its literal
/// counterpart, is bound to nothing here and Chromium types the letter under it. A remote
/// computer takes `MetaAs::Super`, since its own system binds Command or the Windows key
/// itself.
pub fn chord_for(frame: &KeyFrame, meta_as: MetaAs) -> Option<String> {
    if MODIFIER_KEYS.contains(&frame.key.as_str()) || frame.key == "Escape" {
        return None;
    }
    let keysym = keysym_for(&frame.key)?;
    let named = frame.key.chars().count() != 1;
    let parts = [
        (frame.ctrl || (frame.meta && meta_as == MetaAs::Ctrl)).then_some("ctrl"),
        (frame.meta && meta_as == MetaAs::Super).then_some("super"),
        (frame.alt && !alt_typed_character(frame)).then_some("alt"),
        (frame.shift && named).then_some("shift"),
    ];
    let mut chord: Vec<&str> = parts.into_iter().flatten().collect();
    chord.push(&keysym);
    Some(chord.join("+"))
}

struct InputState {
    proc: Option<Child>,
    stdin: Option<ChildStdin>,
    x: i64,
    y: i64,
    move_timer: Option<JoinHandle<()>>,
    stopped: bool,
    /// The paste being typed right now, so that stopping the session stops it.
    typer: Option<Child>,
}

pub struct DesktopInput {
    /// This input, for the timer that flushes movement and the paste queue.
    me: Weak<DesktopInput>,
    /// The display's environment.
    env: IndexMap<String, String>,
    /// Read on every movement rather than copied, so the pointer's bounds are the screen's
    /// own and follow it when the client resizes it.
    screen: Arc<DesktopControl>,
    state: Mutex<InputState>,
    /// Pastes run one at a time, in arrival order.
    typing: tokio::sync::Mutex<()>,
}

impl DesktopInput {
    pub fn new(env: IndexMap<String, String>, screen: Arc<DesktopControl>) -> Arc<Self> {
        let x = screen.width() / 2;
        let y = screen.height() / 2;
        Arc::new_cyclic(|me| DesktopInput {
            me: me.clone(),
            env,
            screen,
            state: Mutex::new(InputState {
                proc: None,
                stdin: None,
                x,
                y,
                move_timer: None,
                stopped: false,
                typer: None,
            }),
            typing: tokio::sync::Mutex::new(()),
        })
    }

    /// Where the user's pointer is on the screen, in its pixels.
    pub fn pointer(&self) -> (i64, i64) {
        let state = self.state.lock();
        (state.x, state.y)
    }

    /// Act on a frame from the page. Takes it unread, since `input_frame` is what reads it.
    pub fn handle(&self, value: &Value) {
        todo!()
    }

    /// Release the pointer and the processes. Safe to call more than once.
    pub fn stop(&self) {
        todo!()
    }
}
