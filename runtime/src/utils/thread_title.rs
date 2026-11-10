//! Derive a conversation thread title from the user's first message: the first
//! three words, capped at 24 characters with a trailing "..." when truncated
//! (e.g. "migrate the authent...").
//!
//! Returns "" when the message has no usable text (e.g. a file-only message):
//! callers should not set a title in that case.

use crate::support::js::{len16, slice16};

const MAX_TITLE_LENGTH: usize = 24;
const ELLIPSIS: &str = "...";

/// A character JavaScript's `\s` and `trim` treat as whitespace.
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub fn derive_thread_title(content: &str) -> String {
    let text = content
        .trim_matches(is_js_space)
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return String::new();
    }
    if len16(&text) <= MAX_TITLE_LENGTH {
        return text;
    }
    let cut = slice16(&text, 0, MAX_TITLE_LENGTH - ELLIPSIS.len());
    format!("{}{ELLIPSIS}", cut.trim_end_matches(is_js_space))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_three_words_and_caps_the_length() {
        assert_eq!(
            derive_thread_title("  Reply with exactly: pong"),
            "Reply with exactly:"
        );
        assert_eq!(
            derive_thread_title("migrate the authentication service"),
            "migrate the authentic..."
        );
        assert_eq!(derive_thread_title("   "), "");
        assert_eq!(derive_thread_title(""), "");
    }

    #[test]
    fn collapses_whitespace_and_keeps_a_short_message() {
        assert_eq!(derive_thread_title("hello there"), "hello there");
        assert_eq!(
            derive_thread_title("   one   two  three   four "),
            "one two three"
        );
        assert_eq!(derive_thread_title("alpha beta gamma"), "alpha beta gamma");
    }

    #[test]
    fn trims_a_trailing_space_before_the_ellipsis() {
        let title = derive_thread_title("aaaaaaaaaaaaaaaaaaaa bb cccccccc");
        assert!(!title.contains(" ..."));
        assert!(len16(&title) <= 24);
    }
}
