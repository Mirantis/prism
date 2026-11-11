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

use std::sync::LazyLock;
use std::sync::{Arc, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use super::child_process::{ChildHandle, Pipes, StopSignal, on_chunks, process_env, spawn_child};
use super::desktop_control::{DesktopControl, MouseButton};
use super::screen_size::math_round;
use crate::lib::log_redaction::err_json;
use crate::{log_debug, log_warn};

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
    /// The long-lived `xdotool -`, while it runs.
    proc: Option<ChildHandle>,
    /// Lines for the task that writes that process's stdin. A spawn that failed leaves a
    /// writer nobody reads, as Node leaves a process object that never started.
    lines: Option<mpsc::UnboundedSender<String>>,
    x: i64,
    y: i64,
    /// The movement waiting to go out, by the number of the timer that sends it.
    move_timer: Option<u64>,
    next_timer: u64,
    stopped: bool,
    /// The paste being typed right now, so that stopping the session stops it.
    typer: Option<ChildHandle>,
    /// Pastes for the task that types them, one at a time, in arrival order.
    pastes: Option<mpsc::UnboundedSender<String>>,
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
}

impl DesktopInput {
    pub fn new(env: IndexMap<String, String>, screen: Arc<DesktopControl>) -> Arc<Self> {
        let x = screen.width().div_euclid(2);
        let y = screen.height().div_euclid(2);
        Arc::new_cyclic(|me| DesktopInput {
            me: me.clone(),
            env,
            screen,
            state: Mutex::new(InputState {
                proc: None,
                lines: None,
                x,
                y,
                move_timer: None,
                next_timer: 1,
                stopped: false,
                typer: None,
                pastes: None,
            }),
        })
    }

    /// Where the user's pointer is on the screen, in its pixels.
    pub fn pointer(&self) -> (i64, i64) {
        let state = self.state.lock();
        (state.x, state.y)
    }

    /// Act on a frame from the page. Takes it unread, since `input_frame` is what reads it.
    pub fn handle(&self, value: &Value) {
        if self.state.lock().stopped {
            return;
        }
        let Some(frame) = input_frame(value) else {
            return;
        };
        match frame {
            InputFrame::Pointer { x, y } => {
                self.place(x, y);
                // Written now rather than flushed: a flush only sends movement that is
                // already pending, and this frame is the pointer being put somewhere — the
                // page sends it when the user takes control, and a click can follow with
                // nothing in between.
                self.move_now();
            }
            InputFrame::PointerMove { dx, dy } => {
                let (x, y) = self.pointer();
                self.place(x as f64 + dx, y as f64 + dy);
                self.schedule_move();
            }
            InputFrame::PointerButton { button, down } => {
                self.flush_move();
                let verb = if down { "mousedown" } else { "mouseup" };
                self.write(format!("{verb} {}", button.x11()));
            }
            InputFrame::Wheel { dy } => {
                let clicks = math_round(dy.abs() / WHEEL_PIXELS_PER_CLICK)
                    .max(1.0)
                    .min(MAX_WHEEL_CLICKS as f64) as i64;
                self.flush_move();
                let wheel = if dy > 0.0 { "5" } else { "4" };
                self.write(format!("click --repeat {clicks} --delay 20 {wheel}"));
            }
            InputFrame::Key(frame) => {
                if let Some(chord) = chord_for(&frame, MetaAs::Ctrl) {
                    self.write(format!("key {chord}"));
                }
            }
            InputFrame::Text { text } => self.type_text(paste_text(&text)),
        }
    }

    /// Type a text into whatever has focus on the desktop, as a paste from the page does.
    ///
    /// A text is typed by its own `xdotool type`, fed through stdin: the command stream
    /// takes a line per command, and a text has newlines of its own. Pastes queue behind
    /// each other, since two typing at once interleave their characters, and the one
    /// running is held so that ending the session ends it.
    fn type_text(&self, text: String) {
        if text.is_empty() {
            return;
        }
        self.flush_move();
        let mut state = self.state.lock();
        let pastes = state.pastes.get_or_insert_with(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let me = self.me.clone();
            tokio::spawn(async move {
                while let Some(text) = rx.recv().await {
                    let Some(input) = me.upgrade() else {
                        return;
                    };
                    input.run_type(text).await;
                }
            });
            tx
        });
        let _ = pastes.send(text);
    }

    async fn run_type(&self, text: String) {
        if self.state.lock().stopped {
            return;
        }
        // xdotool decodes the text through the locale, and the container has none set,
        // under which anything beyond ASCII is an invalid sequence to it.
        let mut env = process_env(&self.env);
        env.insert("LC_ALL".to_string(), "C.UTF-8".to_string());
        let spawned = spawn_child(
            "xdotool",
            &["type".to_string(), "--file".to_string(), "-".to_string()],
            &env,
            Pipes {
                stdin: true,
                stdout: false,
                stderr: true,
            },
        );
        let (proc, pipes) = match spawned {
            Ok(spawned) => spawned,
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Desktop typing process failed"
                );
                return;
            }
        };
        self.state.lock().typer = Some(proc.clone());
        on_chunks(pipes.stderr, log_input_stderr);
        if let Some(mut stdin) = pipes.stdin {
            let _ = stdin.write_all(text.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        proc.wait().await;
        let mut state = self.state.lock();
        if state.typer.as_ref().is_some_and(|typer| typer.same(&proc)) {
            state.typer = None;
        }
    }

    fn place(&self, x: f64, y: f64) {
        let width = self.screen.width();
        let height = self.screen.height();
        let mut state = self.state.lock();
        state.x = ((width - 1) as f64).min(math_round(x).max(0.0)) as i64;
        state.y = ((height - 1) as f64).min(math_round(y).max(0.0)) as i64;
    }

    fn schedule_move(&self) {
        let timer = {
            let mut state = self.state.lock();
            if state.move_timer.is_some() {
                return;
            }
            let timer = state.next_timer;
            state.next_timer += 1;
            state.move_timer = Some(timer);
            timer
        };
        let me = self.me.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(MOVE_FLUSH_MS)).await;
            let Some(input) = me.upgrade() else {
                return;
            };
            let line = {
                let mut state = input.state.lock();
                if state.move_timer != Some(timer) {
                    return;
                }
                state.move_timer = None;
                format!("mousemove {} {}", state.x, state.y)
            };
            input.write(line);
        });
    }

    /// Send the movement waiting to go out, if any, so what follows lands where it should.
    fn flush_move(&self) {
        if self.state.lock().move_timer.is_none() {
            return;
        }
        self.move_now();
    }

    /// Put the pointer where it is now, dropping any movement still waiting on the timer.
    fn move_now(&self) {
        let line = {
            let mut state = self.state.lock();
            state.move_timer = None;
            format!("mousemove {} {}", state.x, state.y)
        };
        self.write(line);
    }

    fn write(&self, line: String) {
        if let Some(lines) = self.ensure_process() {
            let _ = lines.send(format!("{line}\n"));
        }
    }

    fn ensure_process(&self) -> Option<mpsc::UnboundedSender<String>> {
        let mut state = self.state.lock();
        if let Some(lines) = &state.lines {
            return Some(lines.clone());
        }
        let env = process_env(&self.env);
        let spawned = spawn_child(
            "xdotool",
            &["-".to_string()],
            &env,
            Pipes {
                stdin: true,
                stdout: false,
                stderr: true,
            },
        );
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let (proc, pipes) = match spawned {
            Ok(spawned) => spawned,
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Desktop input process failed"
                );
                state.lines = Some(tx.clone());
                return Some(tx);
            }
        };
        if let Some(mut stdin) = pipes.stdin {
            tokio::spawn(async move {
                while let Some(line) = rx.recv().await {
                    if stdin.write_all(line.as_bytes()).await.is_err() {
                        return;
                    }
                }
                let _ = stdin.shutdown().await;
            });
        }
        on_chunks(pipes.stderr, log_input_stderr);
        let me = self.me.clone();
        let watched = proc.clone();
        tokio::spawn(async move {
            let exit = watched.wait().await;
            let Some(input) = me.upgrade() else {
                return;
            };
            let mut state = input.state.lock();
            if state.proc.as_ref().is_some_and(|proc| proc.same(&watched)) {
                if !state.stopped {
                    log_warn!(
                        "[VoiceChat] Desktop input process exited ({})",
                        exit.describe()
                    );
                }
                state.proc = None;
                state.lines = None;
            }
        });
        state.proc = Some(proc);
        state.lines = Some(tx.clone());
        Some(tx)
    }

    /// Release the pointer and the processes. Safe to call more than once.
    pub fn stop(&self) {
        let mut state = self.state.lock();
        state.stopped = true;
        state.move_timer = None;
        // A long paste types for as long as its text lasts, and the desktop it types into
        // is about to go.
        if let Some(typer) = state.typer.take() {
            typer.kill(StopSignal::Term);
        }
        let proc = state.proc.take();
        // Dropping the writer ends the process's stdin.
        state.lines = None;
        if let Some(proc) = proc {
            proc.kill(StopSignal::Term);
        }
    }
}

/// A line the input process wrote to stderr, at debug level.
fn log_input_stderr(chunk: &[u8]) {
    let text = String::from_utf8_lossy(chunk);
    let line = crate::support::js::trim(&text);
    if !line.is_empty() {
        log_debug!("[VoiceChat:Input] {}", line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::computer::screen_size::ScreenSize;

    fn key(k: &str) -> KeyFrame {
        KeyFrame {
            key: k.to_string(),
            code: None,
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        }
    }

    fn with(mut frame: KeyFrame, edit: impl FnOnce(&mut KeyFrame)) -> KeyFrame {
        edit(&mut frame);
        frame
    }

    fn chord(frame: KeyFrame) -> Option<String> {
        chord_for(&frame, MetaAs::Ctrl)
    }

    #[test]
    fn passes_letters_and_digits_through_case_intact() {
        assert_eq!(keysym_for("a").as_deref(), Some("a"));
        assert_eq!(keysym_for("A").as_deref(), Some("A"));
        assert_eq!(keysym_for("7").as_deref(), Some("7"));
    }

    #[test]
    fn names_ascii_punctuation_and_the_space() {
        assert_eq!(keysym_for("!").as_deref(), Some("exclam"));
        assert_eq!(keysym_for("/").as_deref(), Some("slash"));
        assert_eq!(keysym_for(" ").as_deref(), Some("space"));
    }

    #[test]
    fn spells_any_other_printable_character_as_a_unicode_keysym() {
        assert_eq!(keysym_for("ä").as_deref(), Some("U00E4"));
        assert_eq!(keysym_for("€").as_deref(), Some("U20AC"));
    }

    #[test]
    fn maps_the_browser_names_of_the_editing_and_arrow_keys() {
        assert_eq!(keysym_for("Enter").as_deref(), Some("Return"));
        assert_eq!(keysym_for("Backspace").as_deref(), Some("BackSpace"));
        assert_eq!(keysym_for("ArrowLeft").as_deref(), Some("Left"));
        assert_eq!(keysym_for("PageDown").as_deref(), Some("Next"));
        assert_eq!(keysym_for("F5").as_deref(), Some("F5"));
    }

    #[test]
    fn has_nothing_for_a_key_the_display_cannot_take() {
        assert_eq!(keysym_for("Unidentified"), None);
        assert_eq!(keysym_for("Dead"), None);
    }

    #[test]
    fn sends_a_plain_character_on_its_own() {
        assert_eq!(chord(key("x")).as_deref(), Some("x"));
    }

    #[test]
    fn prefixes_the_modifiers_the_browser_reported() {
        assert_eq!(
            chord(with(key("c"), |k| k.ctrl = true)).as_deref(),
            Some("ctrl+c")
        );
        assert_eq!(
            chord(with(key("F4"), |k| k.alt = true)).as_deref(),
            Some("alt+F4")
        );
        let digit = with(key("2"), |k| {
            k.alt = true;
            k.code = Some("Digit2".into());
        });
        assert_eq!(chord(digit).as_deref(), Some("alt+2"));
        let letter = with(key("f"), |k| {
            k.alt = true;
            k.code = Some("KeyF".into());
        });
        assert_eq!(chord(letter).as_deref(), Some("alt+f"));
    }

    #[test]
    fn sends_cmd_as_ctrl_the_key_the_desktop_binds_copy_and_paste_to() {
        let copy = with(key("c"), |k| {
            k.meta = true;
            k.code = Some("KeyC".into());
        });
        assert_eq!(chord(copy).as_deref(), Some("ctrl+c"));
        let both = with(key("l"), |k| {
            k.ctrl = true;
            k.meta = true;
        });
        assert_eq!(chord(both).as_deref(), Some("ctrl+l"));
    }

    #[test]
    fn drops_the_alt_that_typed_a_character_as_option_does_on_a_mac() {
        // Option+2 is @ on a Finnish keyboard; the browser reports @ with Alt held.
        let at = with(key("@"), |k| {
            k.alt = true;
            k.code = Some("Digit2".into());
        });
        assert_eq!(chord(at).as_deref(), Some("at"));
        let florin = with(key("ƒ"), |k| {
            k.alt = true;
            k.code = Some("KeyF".into());
        });
        assert_eq!(chord(florin).as_deref(), Some("U0192"));
        assert_eq!(
            chord(with(key("@"), |k| k.alt = true)).as_deref(),
            Some("at")
        );
        assert_eq!(
            chord(with(key("f"), |k| k.alt = true)).as_deref(),
            Some("alt+f")
        );
    }

    #[test]
    fn spells_shift_out_for_a_named_key_only_since_a_character_has_its_own() {
        assert_eq!(
            chord(with(key("Tab"), |k| k.shift = true)).as_deref(),
            Some("shift+Tab")
        );
        assert_eq!(
            chord(with(key("A"), |k| k.shift = true)).as_deref(),
            Some("A")
        );
        assert_eq!(
            chord(with(key("!"), |k| k.shift = true)).as_deref(),
            Some("exclam")
        );
    }

    #[test]
    fn ignores_a_modifier_pressed_on_its_own_and_escape() {
        assert_eq!(chord(with(key("Shift"), |k| k.shift = true)), None);
        assert_eq!(chord(with(key("Control"), |k| k.ctrl = true)), None);
        assert_eq!(chord(key("Escape")), None);
    }

    #[test]
    fn sends_cmd_as_super_to_a_remote_computer() {
        let copy = with(key("c"), |k| k.meta = true);
        assert_eq!(chord_for(&copy, MetaAs::Super).as_deref(), Some("super+c"));
    }

    #[test]
    fn types_a_text_as_it_is_newlines_included() {
        assert_eq!(
            paste_text("kubectl get pods\n-n kube-system"),
            "kubectl get pods\n-n kube-system"
        );
    }

    #[test]
    fn cuts_a_paste_at_the_limit_on_a_character_boundary() {
        let long = "€".repeat(MAX_PASTE_CHARS + 5);
        assert_eq!(paste_text(&long).chars().count(), MAX_PASTE_CHARS);
    }

    #[test]
    fn reads_each_frame_the_page_sends() {
        assert_eq!(
            input_frame(&json!({ "type": "pointer", "x": 4, "y": 9 })),
            Some(InputFrame::Pointer { x: 4.0, y: 9.0 })
        );
        assert_eq!(
            input_frame(&json!({ "type": "pointer_move", "dx": -2, "dy": 3 })),
            Some(InputFrame::PointerMove { dx: -2.0, dy: 3.0 })
        );
        assert_eq!(
            input_frame(&json!({ "type": "pointer_button", "button": "right", "down": true })),
            Some(InputFrame::PointerButton {
                button: MouseButton::Right,
                down: true
            })
        );
        assert_eq!(
            input_frame(&json!({ "type": "wheel", "dy": 120 })),
            Some(InputFrame::Wheel { dy: 120.0 })
        );
        assert_eq!(
            input_frame(&json!({ "type": "text", "text": "hello" })),
            Some(InputFrame::Text {
                text: "hello".into()
            })
        );
    }

    #[test]
    fn takes_a_key_with_its_modifiers_and_reads_a_missing_modifier_as_up() {
        assert_eq!(
            input_frame(&json!({ "type": "key", "key": "c", "code": "KeyC", "ctrl": true })),
            Some(InputFrame::Key(KeyFrame {
                key: "c".into(),
                code: Some("KeyC".into()),
                ctrl: true,
                alt: false,
                shift: false,
                meta: false,
            }))
        );
    }

    #[test]
    fn drops_a_frame_whose_fields_are_not_what_its_type_needs() {
        for frame in [
            json!({ "type": "key", "ctrl": false }),
            json!({ "type": "key", "key": 5 }),
            json!({ "type": "pointer", "x": 4 }),
            json!({ "type": "pointer", "x": "4", "y": "9" }),
            json!({ "type": "pointer_button", "button": "fourth", "down": true }),
            json!({ "type": "pointer_button", "button": "left" }),
            json!({ "type": "wheel", "dy": null }),
            json!({ "type": "text" }),
        ] {
            assert_eq!(input_frame(&frame), None, "{frame}");
        }
    }

    #[test]
    fn drops_anything_that_is_not_a_frame_at_all() {
        for frame in [
            json!({ "type": "orbit", "x": 1, "y": 1 }),
            json!({}),
            Value::Null,
            json!("key"),
            json!(7),
        ] {
            assert_eq!(input_frame(&frame), None, "{frame}");
        }
    }

    fn screen(width: i64, height: i64) -> Arc<DesktopControl> {
        Arc::new(DesktopControl::new(
            IndexMap::new(),
            ScreenSize { width, height },
        ))
    }

    /// A desktop whose `xdotool` is a script that appends what it reads to a file, and
    /// that file.
    fn recording_desktop() -> (
        IndexMap<String, String>,
        std::path::PathBuf,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("written.txt");
        let script = dir.path().join("xdotool");
        std::fs::write(&script, "#!/bin/sh\ncat >> \"$WRITTEN\"\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = IndexMap::from([
            (
                "PATH".to_string(),
                format!("{}:/usr/bin:/bin", dir.path().display()),
            ),
            ("WRITTEN".to_string(), out.display().to_string()),
        ]);
        (env, out, dir)
    }

    /// The lines written so far, once there are `count` of them.
    async fn written(out: &std::path::Path, count: usize) -> Vec<String> {
        // Up to 10 s: the recording script is a real process, slow to start on a loaded host.
        for _ in 0..1000 {
            let text = std::fs::read_to_string(out).unwrap_or_default();
            let lines: Vec<String> = text.lines().map(str::to_string).collect();
            if lines.len() >= count {
                return lines;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        std::fs::read_to_string(out)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn puts_the_pointer_where_the_user_clicked_before_the_click_goes_out() {
        let (env, out, _dir) = recording_desktop();
        let input = DesktopInput::new(env, screen(1280, 720));

        // What the page sends when the user clicks the screen to take control: an absolute
        // position, then the button. Nothing moved in between, so there is no movement
        // waiting on the timer to carry the position out.
        input.handle(&json!({ "type": "pointer", "x": 400, "y": 300 }));
        input.handle(&json!({ "type": "pointer_button", "button": "left", "down": true }));
        input.handle(&json!({ "type": "pointer_button", "button": "left", "down": false }));

        assert_eq!(
            written(&out, 3).await,
            vec!["mousemove 400 300", "mousedown 1", "mouseup 1"]
        );
        input.stop();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn clamps_an_absolute_position_to_the_screen_it_is_on() {
        let (env, out, _dir) = recording_desktop();
        let input = DesktopInput::new(env, screen(1280, 720));

        input.handle(&json!({ "type": "pointer", "x": 9999, "y": -5 }));

        assert_eq!(written(&out, 1).await, vec!["mousemove 1279 0"]);
        input.stop();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drops_movement_still_waiting_when_the_pointer_is_placed_somewhere() {
        let (env, out, _dir) = recording_desktop();
        let input = DesktopInput::new(env, screen(1280, 720));

        // A delta schedules a move for a few milliseconds' time; an absolute position that
        // lands first replaces it rather than being followed by it.
        input.handle(&json!({ "type": "pointer_move", "dx": 10, "dy": 10 }));
        input.handle(&json!({ "type": "pointer", "x": 700, "y": 500 }));
        input.handle(&json!({ "type": "pointer_button", "button": "left", "down": true }));

        tokio::time::sleep(Duration::from_millis(MOVE_FLUSH_MS * 4)).await;
        assert_eq!(
            written(&out, 2).await,
            vec!["mousemove 700 500", "mousedown 1"]
        );
        assert_eq!(input.pointer(), (700, 500));
        input.stop();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn carries_the_movement_gathered_so_far_out_in_front_of_a_click() {
        let (env, out, _dir) = recording_desktop();
        let input = DesktopInput::new(env, screen(1280, 720));

        input.handle(&json!({ "type": "pointer_move", "dx": 100, "dy": 50 }));
        // Still on the timer at this point, and the click flushes it.
        input.handle(&json!({ "type": "pointer_button", "button": "left", "down": true }));

        assert_eq!(
            written(&out, 2).await,
            vec!["mousemove 740 410", "mousedown 1"]
        );
        input.stop();
    }

    #[tokio::test]
    async fn keeps_the_pointer_inside_a_screen_that_changes_size() {
        // The screen is the `DesktopControl` the computer keeps, and the client resizes it.
        let control = screen(1280, 720);
        let input = DesktopInput::new(IndexMap::new(), control.clone());

        input.handle(&json!({ "type": "pointer_move", "dx": 9999, "dy": 9999 }));
        assert_eq!(input.pointer(), (1279, 719));

        control.resize(ScreenSize {
            width: 1920,
            height: 1080,
        });
        input.handle(&json!({ "type": "pointer_move", "dx": 9999, "dy": 9999 }));
        assert_eq!(input.pointer(), (1919, 1079));
        input.stop();
    }

    #[tokio::test]
    async fn drops_a_malformed_frame_at_the_door() {
        let input = DesktopInput::new(IndexMap::new(), screen(1280, 720));
        let before = input.pointer();
        input.handle(&json!({ "type": "key", "ctrl": false, "alt": false }));
        input.handle(&json!({ "type": "pointer", "x": "far", "y": "down" }));
        assert_eq!(input.pointer(), before);
        input.stop();
    }
}
