//! Text a reader can see.

use regex::Regex;
use std::sync::LazyLock;

use crate::support::js::trim as js_trim;

/// Whitespace and format characters such as a zero-width space, which a reader
/// cannot see. The whitespace class is JavaScript's `\s`.
static INVISIBLE_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}\p{Cf}]*$",
    )
    .expect("invisible-only pattern")
});

/// The text trimmed, or empty when nothing in it is visible. A model told to end
/// with an empty reply can write a lone zero-width space, which `trim()` keeps.
pub fn visible_text(text: &str) -> String {
    if INVISIBLE_ONLY.is_match(text) {
        return String::new();
    }
    js_trim(text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empties_a_text_with_nothing_visible() {
        assert_eq!(visible_text("\u{200B}"), "");
        assert_eq!(visible_text("  \n "), "");
        assert_eq!(visible_text("  hi \n"), "hi");
        assert_eq!(visible_text(" \u{200C}\u{200D}\u{2060}\u{FEFF}\u{AD} "), "");
    }

    #[test]
    fn keeps_format_characters_inside_visible_text() {
        assert_eq!(visible_text("  Deployed.\n"), "Deployed.");
        assert_eq!(visible_text("\u{200B}done\u{200B}"), "\u{200B}done\u{200B}");
        assert_eq!(visible_text("👩\u{200D}💻"), "👩\u{200D}💻");
    }
}
