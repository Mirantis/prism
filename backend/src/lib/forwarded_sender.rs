//! Who a request names as its sender, from the headers the Lens Agents ingress writes.

use std::sync::LazyLock;

use http::HeaderMap;
use regex::Regex;

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

/// One header value, or `None` when the header is absent. Repeated headers read as
/// Node joins them, with `, `.
pub fn header_of(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
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
            let hex = value.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
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
