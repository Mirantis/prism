//! JSON as JavaScript writes and reads it: `JSON.stringify` (numbers, key order,
//! indentation), `JSON.parse` (every number is a double), base64 as `btoa`/`atob`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serializer;
use serde_json::{Map, Value};

use super::errors::{JsonParseError, SyntaxError};

/// A number as `Number.prototype.toString` and `JSON.stringify` write it.
pub fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Rust's `{:e}` prints the shortest digits that round-trip, as JavaScript does.
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let k = digits.len() as i64;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let exp = n - 1;
        let exp_text = if exp >= 0 {
            format!("+{exp}")
        } else {
            format!("{exp}")
        };
        if k == 1 {
            format!("{digits}e{exp_text}")
        } else {
            format!("{}.{}e{}", &digits[..1], &digits[1..], exp_text)
        }
    };
    format!("{sign}{body}")
}

fn number_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    match n.as_f64() {
        Some(f) if f.is_finite() => js_number_text(f),
        _ => "null".into(),
    }
}

fn string_text(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// Whether a key is an array index, which JavaScript enumerates first.
fn is_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 {
        return None;
    }
    if key != "0" && key.starts_with('0') {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < u32::MAX as u64 {
        Some(n as u32)
    } else {
        None
    }
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The keys of an object in the order JavaScript enumerates them after
/// `Object.fromEntries(entries.sort(byCodeUnit))`: array indices ascending, then
/// the rest by UTF-16 code unit.
fn sorted_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut indices: Vec<(&String, u32)> = Vec::new();
    let mut rest: Vec<&String> = Vec::new();
    for key in map.keys() {
        match is_array_index(key) {
            Some(n) => indices.push((key, n)),
            None => rest.push(key),
        }
    }
    indices.sort_by_key(|(_, n)| *n);
    rest.sort_by(|a, b| utf16_cmp(a, b));
    indices.into_iter().map(|(k, _)| k).chain(rest).collect()
}

fn write_value(out: &mut String, value: &Value, sort: bool, indent: Option<&str>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_text(n)),
        Value::String(s) => out.push_str(&string_text(s)),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_value(out, item, sort, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            let keys: Vec<&String> = if sort {
                sorted_keys(map)
            } else {
                map.keys().collect()
            };
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                out.push_str(&string_text(key));
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, &map[key.as_str()], sort, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<&str>, depth: usize) {
    if let Some(unit) = indent {
        out.push('\n');
        for _ in 0..depth {
            out.push_str(unit);
        }
    }
}

/// `JSON.stringify(value)`.
pub fn js_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, false, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn js_stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, false, Some("  "), 0);
    out
}

/// `JSON.stringify` with every object's keys sorted by code unit.
pub fn js_stringify_sorted(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, true, None, 0);
    out
}

/// A serializable value as JavaScript would print it.
pub fn to_js_json<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(v) => js_stringify(&v),
        Err(_) => String::new(),
    }
}

/// `JSON.parse` gives doubles: an integral double within the safe range is the
/// integer, so `1.0` reads back as `1`.
pub fn normalize_numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => {
            if n.is_f64() {
                if let Some(f) = n.as_f64()
                    && f.fract() == 0.0
                    && f.abs() <= 9_007_199_254_740_991.0
                {
                    return Value::from(f as i64);
                }
            } else if let Some(u) = n.as_u64() {
                if u > 9_007_199_254_740_991 {
                    return serde_json::Number::from_f64(u as f64)
                        .map(Value::Number)
                        .unwrap_or(Value::Null);
                }
            } else if let Some(i) = n.as_i64()
                && i < -9_007_199_254_740_991
            {
                return serde_json::Number::from_f64(i as f64)
                    .map(Value::Number)
                    .unwrap_or(Value::Null);
            }
            Value::Number(n)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, normalize_numbers(v)))
                .collect(),
        ),
        other => other,
    }
}

fn v8_syntax_message(text: &str, err: &serde_json::Error) -> String {
    if err.is_eof() {
        return "Unexpected end of JSON input".to_string();
    }
    let offset = byte_offset(text, err.line(), err.column());
    let ch = text[offset.min(text.len())..].chars().next();
    match ch {
        Some(c) => {
            let shown: String = if text.chars().count() <= 10 {
                text.to_string()
            } else {
                text.chars().take(10).collect::<String>() + "..."
            };
            format!("Unexpected token '{c}', \"{shown}\" is not valid JSON")
        }
        None => "Unexpected end of JSON input".to_string(),
    }
}

fn byte_offset(text: &str, line: usize, column: usize) -> usize {
    let mut offset = 0usize;
    for (i, l) in text.split('\n').enumerate() {
        if i + 1 == line {
            let col = column.saturating_sub(1);
            return offset + l.char_indices().nth(col).map(|(b, _)| b).unwrap_or(l.len());
        }
        offset += l.len() + 1;
    }
    text.len()
}

fn has_forbidden_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if map.contains_key("__proto__") {
                return true;
            }
            if let Some(Value::Object(ctor)) = map.get("constructor")
                && ctor.contains_key("prototype")
            {
                return true;
            }
            map.values().any(has_forbidden_key)
        }
        Value::Array(items) => items.iter().any(has_forbidden_key),
        _ => false,
    }
}

/// `secureJsonParse(text)`: `JSON.parse` that refuses `__proto__` and
/// `constructor.prototype` keys. The error is a `SyntaxError`.
pub fn secure_json_parse(text: &str) -> Result<Value, SyntaxError> {
    let value: Value = serde_json::from_str(text).map_err(|e| SyntaxError {
        message: v8_syntax_message(text, &e),
    })?;
    if has_forbidden_key(&value) {
        return Err(SyntaxError {
            message: "Object contains forbidden prototype property".to_string(),
        });
    }
    Ok(normalize_numbers(value))
}

/// `parseJSON({ text })` without a schema: a `JsonParseError` on failure.
pub fn parse_json(text: &str) -> Result<Value, JsonParseError> {
    secure_json_parse(text).map_err(|e| JsonParseError::new(text, anyhow::Error::new(e)))
}

/// `convertUint8ArrayToBase64`.
pub fn bytes_to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// `convertBase64ToUint8Array`: base64url is accepted, padding is optional and
/// ASCII whitespace is skipped, as `atob` does.
pub fn base64_to_bytes(text: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r'))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim_end_matches('=');
    if trimmed.len() % 4 == 1 || cleaned.len() - trimmed.len() > 2 {
        return Err("The string to be decoded is not correctly encoded.".to_string());
    }
    let mut padded = trimmed.to_string();
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    STANDARD
        .decode(padded.as_bytes())
        .map_err(|_| "The string to be decoded is not correctly encoded.".to_string())
}

/// Serializes `Option<f64>` as `JSON.stringify` writes a number.
pub fn serialize_js_number_opt<S: Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        None => serializer.serialize_none(),
        Some(v) => serialize_js_number(v, serializer),
    }
}

/// Serializes an `f64` as `JSON.stringify` writes a number.
pub fn serialize_js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        serializer.serialize_i64(*value as i64)
    } else if value.is_finite() {
        serializer.serialize_f64(*value)
    } else {
        serializer.serialize_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_numbers_as_javascript_does() {
        assert_eq!(js_number_text(0.7), "0.7");
        assert_eq!(js_number_text(1.0), "1");
        assert_eq!(js_number_text(0.000001), "0.000001");
        assert_eq!(js_number_text(1e-7), "1e-7");
        assert_eq!(js_number_text(1.5e21), "1.5e+21");
        assert_eq!(js_number_text(123456.789), "123456.789");
        assert_eq!(js_number_text(-2.5), "-2.5");
        assert_eq!(js_number_text(1e21), "1e+21");
        assert_eq!(js_number_text(1e20), "100000000000000000000");
    }

    #[test]
    fn sorts_keys_with_array_indices_first() {
        let value = json!({ "b": 1, "a": { "z": [1, 2.5], "10": 0, "9": 0 }, "A": null });
        assert_eq!(
            js_stringify_sorted(&value),
            r#"{"A":null,"a":{"9":0,"10":0,"z":[1,2.5]},"b":1}"#
        );
    }

    #[test]
    fn pretty_prints_with_two_spaces() {
        let value = json!({ "a": [1, {}], "b": [] });
        assert_eq!(
            js_stringify_pretty(&value),
            "{\n  \"a\": [\n    1,\n    {}\n  ],\n  \"b\": []\n}"
        );
    }

    #[test]
    fn parses_numbers_as_doubles() {
        assert_eq!(
            secure_json_parse("{\"a\":1.0,\"b\":1e2,\"c\":0.5}").unwrap(),
            json!({"a":1,"b":100,"c":0.5})
        );
    }

    #[test]
    fn refuses_prototype_keys() {
        let err = secure_json_parse("{\"__proto__\":{}}").unwrap_err();
        assert_eq!(err.message, "Object contains forbidden prototype property");
    }

    #[test]
    fn words_an_unfinished_text_as_v8() {
        assert_eq!(
            secure_json_parse("{\"city\":").unwrap_err().message,
            "Unexpected end of JSON input"
        );
    }

    #[test]
    fn decodes_unpadded_base64() {
        assert_eq!(base64_to_bytes("aGk").unwrap(), b"hi");
        assert_eq!(base64_to_bytes("aGk=").unwrap(), b"hi");
        assert!(base64_to_bytes("a").is_err());
    }
}
