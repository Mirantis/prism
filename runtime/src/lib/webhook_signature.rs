//! Webhook Sender Authentication
//!
//! Single owner of "did this inbound webhook really come from its sender?".
//!
//! ```text
//!   'none'  — explicit opt-out (the subscription list marks it Unverified)
//!   'token' — `authHeader` must carry `secret` verbatim, after an optional
//!             literal `authPrefix` ('Bearer', …)
//!   'hmac'  — `authHeader` must carry HMAC(secret, raw body) in `authAlgorithm`
//!             + `authEncoding`, after an optional literal `authPrefix`
//!             ('sha256=', 'v1=', …). With `authSignedUrl` set, the digest
//!             covers the raw body followed by that URL.
//! ```
//!
//! In 'hmac' mode the header value is split on ',' and any matching candidate
//! passes, which is what makes senders that emit several signatures during a
//! secret rotation work without the code knowing whose convention that is.
//! 'token' mode compares the whole value, so a secret containing a comma is
//! safe.

use crate::lib::visible_text::is_js_whitespace;
use base64::Engine;
use hmac::{Hmac, Mac};
use http::HeaderMap;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

pub const WEBHOOK_AUTH_TYPES: [&str; 3] = ["none", "token", "hmac"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebhookAuthType {
    None,
    Token,
    Hmac,
}

impl WebhookAuthType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Token => "token",
            Self::Hmac => "hmac",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "token" => Some(Self::Token),
            "hmac" => Some(Self::Hmac),
            _ => None,
        }
    }
}

pub const WEBHOOK_AUTH_ALGORITHMS: [&str; 3] = ["sha256", "sha1", "sha512"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebhookAuthAlgorithm {
    Sha256,
    Sha1,
    Sha512,
}

impl WebhookAuthAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sha256 => "sha256",
            Self::Sha1 => "sha1",
            Self::Sha512 => "sha512",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "sha256" => Some(Self::Sha256),
            "sha1" => Some(Self::Sha1),
            "sha512" => Some(Self::Sha512),
            _ => None,
        }
    }
}

pub const WEBHOOK_AUTH_ENCODINGS: [&str; 2] = ["hex", "base64"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebhookAuthEncoding {
    Hex,
    Base64,
}

impl WebhookAuthEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hex => "hex",
            Self::Base64 => "base64",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "hex" => Some(Self::Hex),
            "base64" => Some(Self::Base64),
            _ => None,
        }
    }
}

pub fn is_valid_auth_type(value: &str) -> bool {
    WebhookAuthType::parse(value).is_some()
}

pub fn is_valid_auth_algorithm(value: &str) -> bool {
    WebhookAuthAlgorithm::parse(value).is_some()
}

pub fn is_valid_auth_encoding(value: &str) -> bool {
    WebhookAuthEncoding::parse(value).is_some()
}

/// Verification outcome. `Invalid` is the sender's fault (bad/absent
/// credential), `Misconfigured` is ours (a subscription demands verification but
/// lacks the secret or header to do it). Both reject — the distinction only
/// shapes the log line, never the HTTP response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebhookAuthOutcome {
    Ok,
    Invalid,
    Misconfigured,
}

impl WebhookAuthOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Invalid => "invalid",
            Self::Misconfigured => "misconfigured",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookAuthConfig {
    pub auth_type: String,
    pub secret: Option<String>,
    pub auth_header: Option<String>,
    pub auth_prefix: Option<String>,
    pub auth_algorithm: String,
    pub auth_encoding: String,
    pub auth_signed_url: Option<String>,
}

/// One inbound delivery and the subscription's auth configuration.
#[derive(Debug, Clone, Copy)]
pub struct WebhookAuthInput<'a> {
    pub config: &'a WebhookAuthConfig,
    pub headers: &'a HeaderMap,
    /// Exact received bytes (lib/raw_body.rs); required for 'hmac'.
    pub raw_body: Option<&'a [u8]>,
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// Headers whose duplicates Node drops, keeping the first.
const SINGLE_VALUE_HEADERS: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

/// A header's bytes read as Latin-1, as Node reads them.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// First value of a header, normalized the way `resolve_event_type()` does. A
/// repeated header reads as Node's request headers give it: the first value for
/// the headers Node keeps once, `set-cookie`'s first entry, and every other
/// header's values joined with `", "`.
fn header_value(headers: &HeaderMap, name: &str) -> String {
    let key = js_trim(name).to_lowercase();
    let Ok(header) = http::HeaderName::from_bytes(key.as_bytes()) else {
        return String::new();
    };
    let values: Vec<String> = headers
        .get_all(&header)
        .iter()
        .map(|value| latin1(value.as_bytes()))
        .collect();
    let Some(first) = values.first() else {
        return String::new();
    };
    if values.len() == 1 || key == "set-cookie" || SINGLE_VALUE_HEADERS.contains(&key.as_str()) {
        return js_trim(first).to_string();
    }
    js_trim(&values.join(", ")).to_string()
}

/// Constant-time string equality that tolerates differing lengths.
fn timing_safe_equal_str(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    // Compare against a same-length copy so the answer is still "false" without
    // returning early on the length.
    if a.len() != b.len() {
        let _ = a.ct_eq(a);
        return false;
    }
    a.ct_eq(b).into()
}

/// Strip `prefix` if present; the credential may also arrive bare.
fn strip_prefix<'a>(value: &'a str, prefix: Option<&str>) -> &'a str {
    match prefix {
        Some(prefix) if !prefix.is_empty() => match value.strip_prefix(prefix) {
            Some(rest) => js_trim(rest),
            None => value,
        },
        _ => value,
    }
}

/// HMAC of the raw body, followed by the signed URL when set, in `encoding`.
fn hmac_digest(
    algorithm: WebhookAuthAlgorithm,
    encoding: WebhookAuthEncoding,
    secret: &str,
    raw_body: &[u8],
    signed_url: Option<&str>,
) -> String {
    fn run<M: Mac + hmac::digest::KeyInit>(
        secret: &str,
        raw_body: &[u8],
        signed_url: Option<&str>,
    ) -> Vec<u8> {
        let mut mac = <M as hmac::digest::KeyInit>::new_from_slice(secret.as_bytes())
            .expect("HMAC takes a key of any length");
        mac.update(raw_body);
        if let Some(url) = signed_url {
            mac.update(url.as_bytes());
        }
        mac.finalize().into_bytes().to_vec()
    }
    let bytes = match algorithm {
        WebhookAuthAlgorithm::Sha256 => run::<Hmac<sha2::Sha256>>(secret, raw_body, signed_url),
        WebhookAuthAlgorithm::Sha1 => run::<Hmac<sha1::Sha1>>(secret, raw_body, signed_url),
        WebhookAuthAlgorithm::Sha512 => run::<Hmac<sha2::Sha512>>(secret, raw_body, signed_url),
    };
    match encoding {
        WebhookAuthEncoding::Hex => hex::encode(bytes),
        WebhookAuthEncoding::Base64 => base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

/// Verify one inbound delivery against a subscription's auth configuration.
/// Never fails: an unexpected shape is a rejection.
pub fn verify_webhook_auth(input: WebhookAuthInput<'_>) -> WebhookAuthOutcome {
    let WebhookAuthConfig {
        auth_type,
        secret,
        auth_header,
        auth_prefix,
        auth_algorithm,
        auth_encoding,
        auth_signed_url,
    } = input.config;

    // Configuration first, so a broken subscription reads as 'misconfigured'
    // whatever the request happens to carry.
    if auth_type == "none" {
        return WebhookAuthOutcome::Ok;
    }
    let Some(kind) = WebhookAuthType::parse(auth_type) else {
        return WebhookAuthOutcome::Misconfigured;
    };
    let Some(secret) = secret
        .as_deref()
        .filter(|secret| !js_trim(secret).is_empty())
    else {
        return WebhookAuthOutcome::Misconfigured;
    };
    let Some(auth_header) = auth_header
        .as_deref()
        .filter(|header| !js_trim(header).is_empty())
    else {
        return WebhookAuthOutcome::Misconfigured;
    };

    let mut algorithm = WebhookAuthAlgorithm::Sha256;
    let mut encoding = WebhookAuthEncoding::Hex;
    if kind == WebhookAuthType::Hmac {
        let (Some(parsed_algorithm), Some(parsed_encoding)) = (
            WebhookAuthAlgorithm::parse(auth_algorithm),
            WebhookAuthEncoding::parse(auth_encoding),
        ) else {
            return WebhookAuthOutcome::Misconfigured;
        };
        algorithm = parsed_algorithm;
        encoding = parsed_encoding;
    }

    let received = header_value(input.headers, auth_header);
    if received.is_empty() {
        return WebhookAuthOutcome::Invalid;
    }

    let prefix = auth_prefix.as_deref();
    if kind == WebhookAuthType::Token {
        return if timing_safe_equal_str(strip_prefix(&received, prefix), secret) {
            WebhookAuthOutcome::Ok
        } else {
            WebhookAuthOutcome::Invalid
        };
    }

    // 'hmac' — the digest must be computed over the exact received bytes.
    let Some(raw_body) = input.raw_body else {
        return WebhookAuthOutcome::Invalid;
    };

    let signed_url = auth_signed_url.as_deref().filter(|url| !url.is_empty());
    let digest = hmac_digest(algorithm, encoding, secret, raw_body, signed_url);
    // Hex is case-insensitive and senders disagree on case; base64 is not.
    let normalize = |value: &str| {
        if encoding == WebhookAuthEncoding::Hex {
            value.to_lowercase()
        } else {
            value.to_string()
        }
    };
    let expected = normalize(&digest);

    // Any candidate may match: senders rotating a secret send several signatures
    // in one comma-separated header.
    let matched = received
        .split(',')
        .map(|candidate| normalize(strip_prefix(js_trim(candidate), prefix)))
        .any(|candidate| !candidate.is_empty() && timing_safe_equal_str(&candidate, &expected));
    if matched {
        WebhookAuthOutcome::Ok
    } else {
        WebhookAuthOutcome::Invalid
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(auth_type: &str) -> WebhookAuthConfig {
        WebhookAuthConfig {
            auth_type: auth_type.into(),
            secret: Some("s3cret".into()),
            auth_header: Some("X-Signature".into()),
            auth_prefix: Some("sha256=".into()),
            auth_algorithm: "sha256".into(),
            auth_encoding: "hex".into(),
            auth_signed_url: None,
        }
    }

    #[test]
    fn accepts_any_matching_hmac_candidate() {
        let cfg = config("hmac");
        let digest = hmac_digest(
            WebhookAuthAlgorithm::Sha256,
            WebhookAuthEncoding::Hex,
            "s3cret",
            b"{}",
            None,
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-signature",
            format!("sha256=bad, sha256={}", digest.to_uppercase())
                .parse()
                .unwrap(),
        );
        let input = WebhookAuthInput {
            config: &cfg,
            headers: &headers,
            raw_body: Some(b"{}"),
        };
        assert_eq!(verify_webhook_auth(input), WebhookAuthOutcome::Ok);
    }

    #[test]
    fn compares_a_token_after_its_prefix() {
        let mut cfg = config("token");
        cfg.auth_prefix = Some("Bearer".into());
        let mut headers = HeaderMap::new();
        headers.insert("x-signature", "Bearer s3cret".parse().unwrap());
        let input = WebhookAuthInput {
            config: &cfg,
            headers: &headers,
            raw_body: None,
        };
        assert_eq!(verify_webhook_auth(input), WebhookAuthOutcome::Ok);
    }

    #[test]
    fn reads_a_missing_secret_as_misconfigured() {
        let mut cfg = config("hmac");
        cfg.secret = Some("  ".into());
        let headers = HeaderMap::new();
        let input = WebhookAuthInput {
            config: &cfg,
            headers: &headers,
            raw_body: Some(b""),
        };
        assert_eq!(
            verify_webhook_auth(input),
            WebhookAuthOutcome::Misconfigured
        );
    }
}
