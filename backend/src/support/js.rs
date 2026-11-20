//! JavaScript semantics the runtime's limits and texts are written in.
//!
//! A length or cut position in the TypeScript code counts UTF-16 code units
//! (`string.length`, `slice`). These helpers count the same way, so a limit cuts a
//! text at the same character.

use serde_json::Value;

/// `string.length`: the number of UTF-16 code units.
pub fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `string.slice(start, end)` with non-negative indices in UTF-16 code units,
/// clamped to the text. A cut inside a surrogate pair keeps the whole character.
pub fn slice16(text: &str, start: usize, end: usize) -> String {
    let byte_start = byte_index16(text, start);
    let byte_end = byte_index16(text, end.max(start));
    text[byte_start..byte_end].to_string()
}

/// The byte offset of UTF-16 position `pos`, clamped to the text.
pub fn byte_index16(text: &str, pos: usize) -> usize {
    let mut units = 0usize;
    for (byte, ch) in text.char_indices() {
        if units >= pos {
            return byte;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// Whether `ch` is whitespace to `String.prototype.trim`: ECMAScript WhiteSpace and
/// LineTerminator, which include U+FEFF and exclude U+0085, unlike `char::is_whitespace`.
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `string.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `string.trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `string.trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// A number as `JSON.stringify` writes it: an integral value has no fraction.
pub fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        Value::from(value as i64)
    } else if value.is_finite() {
        Value::from(value)
    } else {
        Value::Null
    }
}

/// `String(number)`: an integral value has no fraction.
pub fn number_text(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        format!("{value}")
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `parseInt(text, 10)`: leading whitespace, an optional sign, then digits; `None`
/// where JavaScript gives `NaN`.
pub fn parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    let (sign, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1, &trimmed[1..]),
        Some(b'+') => (1, &trimmed[1..]),
        _ => (1, trimmed),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|n| n * sign)
}

/// `Number(text)`: the whole text, trimmed, as a number; an empty text is 0.
pub fn number_from(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return i64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if trimmed
        .chars()
        .any(|c| c.is_alphabetic() && c != 'e' && c != 'E')
    {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// `JSON.parse` of a UTF-8 frame. `JSON.parse` accepts a lone surrogate escape such as
/// `\ud83d`, which `JSON.stringify` writes for a text holding half of an emoji pair;
/// `serde_json` refuses it, and a Rust string cannot hold it. A text that fails to parse
/// is parsed again with each lone surrogate escape read as U+FFFD, the character a
/// UTF-8 encoder writes for it.
pub fn json_parse(bytes: &[u8]) -> serde_json::Result<Value> {
    match serde_json::from_slice(bytes) {
        Ok(value) => Ok(value),
        Err(err) => match replace_lone_surrogate_escapes(bytes) {
            Some(fixed) => serde_json::from_slice(&fixed),
            None => Err(err),
        },
    }
}

/// `bytes` with each `\uXXXX` escape of an unpaired surrogate inside a string replaced
/// by `\ufffd`, or `None` when it has none.
fn replace_lone_surrogate_escapes(bytes: &[u8]) -> Option<Vec<u8>> {
    fn unit_at(bytes: &[u8], at: usize) -> Option<u16> {
        if bytes.get(at) != Some(&b'\\') || bytes.get(at + 1) != Some(&b'u') {
            return None;
        }
        let hex = std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?;
        u16::from_str_radix(hex, 16).ok()
    }
    let is_high = |unit: u16| (0xD800..0xDC00).contains(&unit);
    let is_low = |unit: u16| (0xDC00..0xE000).contains(&unit);
    let mut out = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if !in_string {
            in_string = byte == b'"';
            out.push(byte);
            i += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = false;
                out.push(byte);
                i += 1;
            }
            b'\\' => match unit_at(bytes, i) {
                Some(unit) if is_high(unit) && unit_at(bytes, i + 6).is_some_and(is_low) => {
                    out.extend_from_slice(&bytes[i..i + 12]);
                    i += 12;
                }
                Some(unit) if is_high(unit) || is_low(unit) => {
                    out.extend_from_slice(b"\\ufffd");
                    changed = true;
                    i += 6;
                }
                _ => {
                    // Any other escape: copy it whole, so an escaped `\\` or `"` is not misread.
                    out.extend_from_slice(&bytes[i..(i + 2).min(bytes.len())]);
                    i += 2;
                }
            },
            _ => {
                out.push(byte);
                i += 1;
            }
        }
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lone_surrogate_escapes_as_json_parse_does() {
        let value = json_parse(br#"{"text":"hi \ud83d","ok":"\ud83d\ude00","k\udc00":1}"#).unwrap();
        assert_eq!(value["text"], "hi \u{fffd}");
        assert_eq!(value["ok"], "😀");
        assert_eq!(value["k\u{fffd}"], 1);
        // An escaped backslash before `ud83d` is text, not an escape.
        let value = json_parse(br#"{"text":"\\ud83d"}"#).unwrap();
        assert_eq!(value["text"], "\\ud83d");
        assert!(json_parse(b"{not json").is_err());
    }

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(len16("a😀b"), 4);
        assert_eq!(slice16("a😀b", 0, 1), "a");
        assert_eq!(slice16("a😀b", 1, 3), "😀");
        assert_eq!(slice16("abc", 1, 99), "bc");
    }

    #[test]
    fn writes_numbers_as_javascript_does() {
        assert_eq!(number(3.0).to_string(), "3");
        assert_eq!(number(0.5).to_string(), "0.5");
        assert_eq!(number_text(10.0), "10");
    }

    #[test]
    fn parses_integers_as_parse_int() {
        assert_eq!(parse_int(" 42px"), Some(42));
        assert_eq!(parse_int("-7"), Some(-7));
        assert_eq!(parse_int("x"), None);
        assert_eq!(number_from(""), Some(0.0));
        assert_eq!(number_from("12abc"), None);
    }
}
