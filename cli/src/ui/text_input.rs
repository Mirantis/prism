//! A one-line text field with a block cursor, the composer and every form field.
//!
//! A key carrying Ctrl, a lone Escape, the arrows that move between rows and Tab
//! are never typed into the value: those keys belong to the screen around the
//! field. Enter submits. A multi-character input (a paste) is inserted whole.

use crate::images::graphics::is_late_probe_reply;
use crate::term::input::KeyEvent;
use crate::term::style::Style;
use crate::term::text::{Line, Span};

#[derive(Clone, Debug, Default)]
pub struct TextInput {
    pub value: String,
    /// The cursor's position, in characters.
    cursor: usize,
}

/// What a key did to the field.
#[derive(Debug, PartialEq, Eq)]
pub enum Edit {
    None,
    Changed,
    Submit,
}

impl TextInput {
    pub fn new(value: &str) -> TextInput {
        TextInput {
            value: value.to_string(),
            cursor: value.chars().count(),
        }
    }

    /// Replace the value and put the cursor at its end.
    pub fn reset(&mut self, value: &str) {
        self.value = value.to_string();
        self.cursor = value.chars().count();
    }

    /// Replace the value, keeping the cursor inside it.
    pub fn set_value(&mut self, value: &str) {
        let len = value.chars().count();
        self.value = value.to_string();
        if self.cursor + 1 > len {
            self.cursor = len;
        }
    }

    pub fn handle(&mut self, ev: &KeyEvent, show_cursor: bool) -> Edit {
        let k = &ev.key;
        if k.up || k.down || k.tab || k.escape || k.ctrl || is_late_probe_reply(&ev.input) {
            return Edit::None;
        }
        if k.ret {
            return Edit::Submit;
        }
        let chars: Vec<char> = self.value.chars().collect();
        let mut cursor = self.cursor.min(chars.len()) as isize;
        let mut next: Option<String> = None;
        if k.left {
            if show_cursor {
                cursor -= 1;
            }
        } else if k.right {
            if show_cursor {
                cursor += 1;
            }
        } else if k.backspace || k.delete {
            if cursor > 0 {
                let at = cursor as usize;
                let mut v: String = chars[..at - 1].iter().collect();
                v.extend(&chars[at..]);
                next = Some(v);
                cursor -= 1;
            }
        } else {
            let at = cursor as usize;
            let mut v: String = chars[..at].iter().collect();
            v.push_str(&ev.input);
            v.extend(&chars[at..]);
            cursor += ev.input.chars().count() as isize;
            next = Some(v);
        }
        let len = next
            .as_ref()
            .map(|v| v.chars().count())
            .unwrap_or(chars.len());
        self.cursor = cursor.clamp(0, len as isize) as usize;
        match next {
            Some(v) if v != self.value => {
                self.value = v;
                Edit::Changed
            }
            _ => Edit::None,
        }
    }

    /// The field as drawn: with a block cursor when it has focus.
    pub fn line(&self, focused: bool, show_cursor: bool, mask: Option<char>) -> Line {
        let shown: String = match mask {
            Some(m) => std::iter::repeat_n(m, self.value.chars().count()).collect(),
            None => self.value.clone(),
        };
        if !(show_cursor && focused) {
            return Line::plain(shown);
        }
        let inverse = Style::new().inverse();
        let mut line = Line::new();
        if shown.is_empty() {
            line.push(Span::new(" ", inverse));
            return line;
        }
        let len = shown.chars().count();
        for (i, c) in shown.chars().enumerate() {
            let style = if i == self.cursor {
                inverse
            } else {
                Style::default()
            };
            line.push(Span::new(c.to_string(), style));
        }
        if self.cursor == len {
            line.push(Span::new(" ", inverse));
        }
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term::input::key_event;

    fn press(input: &mut TextInput, s: &str) -> Edit {
        input.handle(&key_event(s).unwrap(), true)
    }

    #[test]
    fn types_and_deletes() {
        let mut t = TextInput::default();
        press(&mut t, "abc");
        press(&mut t, "\x1b[D");
        press(&mut t, "\x7f");
        assert_eq!(t.value, "ac");
        press(&mut t, "X");
        assert_eq!(t.value, "aXc");
    }

    #[test]
    fn ignores_ctrl_chords_and_escape() {
        let mut t = TextInput::default();
        assert_eq!(press(&mut t, "\x0f"), Edit::None);
        assert_eq!(press(&mut t, "\x1b"), Edit::None);
        assert_eq!(t.value, "");
    }

    #[test]
    fn enter_submits() {
        let mut t = TextInput::new("hi");
        assert_eq!(press(&mut t, "\r"), Edit::Submit);
    }

    #[test]
    fn draws_the_cursor_at_the_end() {
        let t = TextInput::new("ab");
        let line = t.line(true, true, None);
        assert_eq!(line.text(), "ab ");
        assert!(line.spans.last().unwrap().style.inverse);
        assert_eq!(
            TextInput::new("pw").line(true, true, Some('•')).text(),
            "•• "
        );
    }
}
