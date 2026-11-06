/// The final written response can precede an empty step after a tool result.
///
/// `texts` are the steps' texts in order. The last one that is not blank after
/// trimming is returned, trimmed; with none, an empty string.
pub fn last_response_text<'a>(texts: impl DoubleEndedIterator<Item = &'a str>) -> String {
    for text in texts.rev() {
        let text = js_trim(text);
        if !text.is_empty() {
            return text.to_string();
        }
    }
    String::new()
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
