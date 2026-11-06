/// Wraps text from somebody other than the user in a tag, so a prompt can tell
/// the model which part of a message is data. `<` and `>` in the text are
/// escaped, so no tag can form inside it: the text can neither end its fence
/// nor open another.
pub fn fence(text: &str, tag: &str) -> String {
    format!("<{tag}>{}</{tag}>", escape_angles(text))
}

/// `text` with `<` and `>` written as `&lt;` and `&gt;`.
pub fn escape_angles(text: &str) -> String {
    text.replace('<', "&lt;").replace('>', "&gt;")
}
