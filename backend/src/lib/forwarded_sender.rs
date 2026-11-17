//! Who a request names as its sender, from the headers the Lens Agents ingress writes.

use std::sync::LazyLock;

use http::HeaderMap;
use regex::Regex;

use crate::lib::origin_guard::header_text;
use crate::support::js;

/// The most code points kept from each ingress header value.
const MAX_SENDER_CHARS: usize = 128;

/// The headers the Lens Agents ingress names the signed-in caller in. It strips any
/// copy a client sent, and omits the id and the display name when it has none.
const FORWARDED_USER_HEADER: &str = "x-forwarded-user";
const FORWARDED_USER_ID_HEADER: &str = "x-forwarded-user-id";
const FORWARDED_USER_DISPLAY_NAME_HEADER: &str = "x-forwarded-user-display-name";

static SENDER_UNSAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[<>:\x00-\x1f\x7f]").expect("valid regex"));

/// Who the ingress says sent a request. Display and attribution only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardedSender {
    pub id: String,
    pub name: String,
}

/// One header value, or `None` when the header is absent: each byte read as Latin-1
/// and repeated headers joined with `, `, as Node gives it.
pub fn header_of(headers: &HeaderMap, name: &str) -> Option<String> {
    header_text(headers, name)
}

/// A header value made safe to show: no angle brackets, colons or control characters, and capped.
fn clean_sender(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let cleaned = SENDER_UNSAFE.replace_all(value, "");
    let capped: String = js::trim(&cleaned).chars().take(MAX_SENDER_CHARS).collect();
    (!capped.is_empty()).then_some(capped)
}

/// `decodeURIComponent`: `None` for a malformed escape or bytes that are not UTF-8.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // Exactly two hex digits, as `decodeURIComponent` reads them: no sign.
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The display name header, which the ingress always percent-encodes.
fn decoded_display_name(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    clean_sender(Some(&decode_uri_component(value)?))
}

/// Who is on this connection, from the ingress's headers. The id is the signed-in
/// person's user id. The name is their display name. Each falls back to
/// `x-forwarded-user`, the person's email or user id, when the ingress omits it.
///
/// **Attribution and display only.** The ingress writes the headers for a private
/// port after it signed the caller in, and strips any copy a client sent. A
/// runtime reached some other way — local development, or bound wider on purpose
/// — would read whatever a client wrote, so nothing is ever decided on them.
pub fn sender_of(headers: &HeaderMap) -> Option<ForwardedSender> {
    let legacy = clean_sender(header_of(headers, FORWARDED_USER_HEADER).as_deref());
    let id = clean_sender(header_of(headers, FORWARDED_USER_ID_HEADER).as_deref())
        .or_else(|| legacy.clone())?;
    let name =
        decoded_display_name(header_of(headers, FORWARDED_USER_DISPLAY_NAME_HEADER).as_deref())
            .or(legacy)
            .unwrap_or_else(|| id.clone());
    Some(ForwardedSender { id, name })
}

#[cfg(test)]
mod tests {
    use http::HeaderValue;

    use super::*;

    fn headers(pairs: &[(&'static str, &[u8])]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_bytes(value).unwrap());
        }
        map
    }

    #[test]
    fn reads_header_bytes_as_latin_1_like_node() {
        let map = headers(&[("x-forwarded-user", b"j\xe4ri\xc3\xa4")]);
        assert_eq!(
            header_of(&map, "x-forwarded-user").as_deref(),
            Some("j\u{e4}ri\u{c3}\u{a4}")
        );
        let sender = sender_of(&map).unwrap();
        assert_eq!(sender.id, "j\u{e4}ri\u{c3}\u{a4}");
    }

    #[test]
    fn refuses_a_signed_escape_and_falls_back_like_decode_uri_component() {
        assert_eq!(decode_uri_component("%+5"), None);
        assert_eq!(decode_uri_component("%-1"), None);
        assert_eq!(decode_uri_component("%4"), None);
        assert_eq!(
            decode_uri_component("J%C3%A4ri").as_deref(),
            Some("J\u{e4}ri")
        );
        let map = headers(&[
            ("x-forwarded-user", b"jari@example.com"),
            ("x-forwarded-user-display-name", b"%+5"),
        ]);
        assert_eq!(sender_of(&map).unwrap().name, "jari@example.com");
    }
}
