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

    use WebhookAuthOutcome::{Invalid, Misconfigured, Ok as Passed};

    const SECRET: &str = "s3cret";
    const BODY: &str = r#"{"action":"opened","number":7}"#;

    /// One delivery: the subscription's configuration, the headers and the raw body.
    struct Case {
        config: WebhookAuthConfig,
        headers: Vec<(&'static str, String)>,
        raw_body: Option<Vec<u8>>,
    }

    /// Minimal config; each test overrides what it exercises.
    fn case() -> Case {
        Case {
            config: WebhookAuthConfig {
                auth_type: "none".into(),
                secret: None,
                auth_header: None,
                auth_prefix: None,
                auth_algorithm: "sha256".into(),
                auth_encoding: "hex".into(),
                auth_signed_url: None,
            },
            headers: Vec::new(),
            raw_body: Some(BODY.as_bytes().to_vec()),
        }
    }

    impl Case {
        fn auth(mut self, auth_type: &str, secret: Option<&str>, header: Option<&str>) -> Self {
            self.config.auth_type = auth_type.into();
            self.config.secret = secret.map(str::to_string);
            self.config.auth_header = header.map(str::to_string);
            self
        }

        fn prefix(mut self, prefix: &str) -> Self {
            self.config.auth_prefix = Some(prefix.into());
            self
        }

        fn algorithm(mut self, algorithm: &str) -> Self {
            self.config.auth_algorithm = algorithm.into();
            self
        }

        fn encoding(mut self, encoding: &str) -> Self {
            self.config.auth_encoding = encoding.into();
            self
        }

        fn signed_url(mut self, url: &str) -> Self {
            self.config.auth_signed_url = Some(url.into());
            self
        }

        fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
            self.headers.push((name, value.into()));
            self
        }

        fn body(mut self, body: Option<&str>) -> Self {
            self.raw_body = body.map(|body| body.as_bytes().to_vec());
            self
        }

        fn verify(&self) -> WebhookAuthOutcome {
            let mut headers = HeaderMap::new();
            for (name, value) in &self.headers {
                headers.append(*name, value.parse().unwrap());
            }
            verify_webhook_auth(WebhookAuthInput {
                config: &self.config,
                headers: &headers,
                raw_body: self.raw_body.as_deref(),
            })
        }
    }

    /// A digest computed apart from the implementation.
    fn hmac(body: &str, secret: &str, algorithm: &str, encoding: &str) -> String {
        fn mac<M: Mac + hmac::digest::KeyInit>(secret: &str, body: &str) -> Vec<u8> {
            let mut mac = <M as hmac::digest::KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
            mac.update(body.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        let bytes = match algorithm {
            "sha1" => mac::<Hmac<sha1::Sha1>>(secret, body),
            "sha512" => mac::<Hmac<sha2::Sha512>>(secret, body),
            _ => mac::<Hmac<sha2::Sha256>>(secret, body),
        };
        match encoding {
            "base64" => base64::engine::general_purpose::STANDARD.encode(bytes),
            _ => hex::encode(bytes),
        }
    }

    fn hex_sha256(body: &str) -> String {
        hmac(body, SECRET, "sha256", "hex")
    }

    #[test]
    fn accepts_only_the_generic_auth_types() {
        assert_eq!(WEBHOOK_AUTH_TYPES, ["none", "token", "hmac"]);
        assert!(is_valid_auth_type("hmac"));
        // No provider names: those are configuration, not types.
        assert!(!is_valid_auth_type("github"));
    }

    #[test]
    fn accepts_the_supported_digests_and_encodings() {
        assert!(is_valid_auth_algorithm("sha512"));
        assert!(!is_valid_auth_algorithm("md5"));
        assert!(is_valid_auth_encoding("base64"));
        assert!(!is_valid_auth_encoding("base64url"));
    }

    #[test]
    fn stays_in_step_with_the_schema_enums() {
        use crate::db::models as db;
        let mut types = WEBHOOK_AUTH_TYPES.to_vec();
        types.sort();
        let mut stored: Vec<&str> = [
            db::WebhookAuthType::None,
            db::WebhookAuthType::Token,
            db::WebhookAuthType::Hmac,
        ]
        .iter()
        .map(|value| value.as_str())
        .collect();
        stored.sort();
        assert_eq!(types, stored);
        for algorithm in WEBHOOK_AUTH_ALGORITHMS {
            assert!(algorithm.parse::<db::WebhookAuthAlgorithm>().is_ok());
        }
        for encoding in WEBHOOK_AUTH_ENCODINGS {
            assert!(encoding.parse::<db::WebhookAuthEncoding>().is_ok());
        }
    }

    #[test]
    fn none_passes_without_looking_at_anything() {
        assert_eq!(case().verify(), Passed);
        assert_eq!(case().body(None).verify(), Passed);
    }

    #[test]
    fn rejects_a_scheme_with_no_secret() {
        assert_eq!(
            case().auth("token", None, Some("X-Token")).verify(),
            Misconfigured
        );
        assert_eq!(
            case().auth("token", Some("   "), Some("X-Token")).verify(),
            Misconfigured
        );
    }

    #[test]
    fn rejects_a_scheme_with_no_header_configured() {
        assert_eq!(
            case().auth("hmac", Some(SECRET), None).verify(),
            Misconfigured
        );
    }

    #[test]
    fn rejects_an_unknown_scheme_digest_or_encoding() {
        assert_eq!(
            case().auth("magic", Some(SECRET), Some("X-Token")).verify(),
            Misconfigured
        );
        assert_eq!(
            case()
                .auth("hmac", Some(SECRET), Some("X-Sig"))
                .algorithm("md5")
                .verify(),
            Misconfigured
        );
        assert_eq!(
            case()
                .auth("hmac", Some(SECRET), Some("X-Sig"))
                .encoding("rot13")
                .verify(),
            Misconfigured
        );
    }

    fn token() -> Case {
        case().auth("token", Some(SECRET), Some("X-Token"))
    }

    #[test]
    fn token_accepts_the_secret_verbatim_with_a_case_insensitive_header_lookup() {
        assert_eq!(token().header("x-token", SECRET).verify(), Passed);
        assert_eq!(
            case()
                .auth("token", Some(SECRET), Some("X-TOKEN"))
                .header("x-token", SECRET)
                .verify(),
            Passed
        );
    }

    #[test]
    fn token_accepts_a_repeated_header_node_keeps_once_by_its_first_value() {
        assert_eq!(
            case()
                .auth("token", Some(SECRET), Some("Authorization"))
                .header("authorization", SECRET)
                .header("authorization", "other")
                .verify(),
            Passed
        );
    }

    #[test]
    fn token_rejects_a_wrong_empty_or_absent_token() {
        assert_eq!(token().header("x-token", "nope").verify(), Invalid);
        assert_eq!(token().header("x-token", "").verify(), Invalid);
        assert_eq!(token().verify(), Invalid);
    }

    #[test]
    fn token_rejects_a_token_that_merely_starts_with_the_secret() {
        assert_eq!(
            token().header("x-token", format!("{SECRET}extra")).verify(),
            Invalid
        );
    }

    #[test]
    fn token_strips_a_configured_prefix_and_tolerates_its_absence() {
        let with_prefix = || {
            case()
                .auth("token", Some(SECRET), Some("Authorization"))
                .prefix("Bearer ")
        };
        assert_eq!(
            with_prefix()
                .header("authorization", format!("Bearer {SECRET}"))
                .verify(),
            Passed
        );
        // A bare credential still matches — the prefix is optional on the wire.
        assert_eq!(
            with_prefix().header("authorization", SECRET).verify(),
            Passed
        );
        assert_eq!(
            with_prefix()
                .header("authorization", format!("Basic {SECRET}"))
                .verify(),
            Invalid
        );
    }

    #[test]
    fn token_matches_whether_or_not_the_configured_prefix_ends_in_a_space() {
        for prefix in ["Bearer", "Bearer "] {
            assert_eq!(
                case()
                    .auth("token", Some(SECRET), Some("Authorization"))
                    .prefix(prefix)
                    .header("authorization", format!("Bearer {SECRET}"))
                    .verify(),
                Passed
            );
        }
    }

    #[test]
    fn token_does_not_split_on_commas_so_a_secret_may_contain_one() {
        let comma = "part-a,part-b";
        let with_comma = || case().auth("token", Some(comma), Some("X-Token"));
        assert_eq!(with_comma().header("x-token", comma).verify(), Passed);
        assert_eq!(with_comma().header("x-token", "part-a").verify(), Invalid);
    }

    fn signed() -> Case {
        case().auth("hmac", Some(SECRET), Some("X-Signature"))
    }

    #[test]
    fn hmac_accepts_a_digest_over_the_exact_received_bytes() {
        assert_eq!(
            signed().header("x-signature", hex_sha256(BODY)).verify(),
            Passed
        );
    }

    #[test]
    fn hmac_with_a_signed_url_accepts_a_digest_over_the_body_followed_by_the_url() {
        let url = "https://prism.example.com/agents/webhooks/boards";
        assert_eq!(
            signed()
                .signed_url(url)
                .header("x-signature", hex_sha256(&format!("{BODY}{url}")))
                .verify(),
            Passed
        );
        for other in [
            BODY.to_string(),
            format!("{BODY}https://elsewhere.example.com/hook"),
            format!("{url}{BODY}"),
        ] {
            assert_eq!(
                signed()
                    .signed_url(url)
                    .header("x-signature", hex_sha256(&other))
                    .verify(),
                Invalid
            );
        }
    }

    #[test]
    fn hmac_rejects_a_digest_over_reserialized_json() {
        let value: serde_json::Value = serde_json::from_str(BODY).unwrap();
        let reserialized = serde_json::to_string_pretty(&value).unwrap();
        assert_eq!(
            signed()
                .header("x-signature", hex_sha256(&reserialized))
                .verify(),
            Invalid
        );
    }

    #[test]
    fn hmac_rejects_another_secret_and_a_tampered_body() {
        assert_eq!(
            signed()
                .header("x-signature", hmac(BODY, "other", "sha256", "hex"))
                .verify(),
            Invalid
        );
        assert_eq!(
            signed()
                .header("x-signature", hex_sha256(BODY))
                .body(Some(r#"{"action":"closed"}"#))
                .verify(),
            Invalid
        );
    }

    #[test]
    fn hmac_rejects_when_no_raw_body_was_captured() {
        assert_eq!(
            signed()
                .header("x-signature", hex_sha256(BODY))
                .body(None)
                .verify(),
            Invalid
        );
    }

    #[test]
    fn hmac_rejects_a_truncated_digest() {
        assert_eq!(
            signed()
                .header("x-signature", hex_sha256(BODY)[..20].to_string())
                .verify(),
            Invalid
        );
    }

    #[test]
    fn hmac_accepts_hex_in_either_case_but_is_strict_about_base64() {
        assert_eq!(
            signed()
                .header("x-signature", hex_sha256(BODY).to_uppercase())
                .verify(),
            Passed
        );
        let b64 = hmac(BODY, SECRET, "sha256", "base64");
        assert_eq!(
            signed()
                .encoding("base64")
                .header("x-signature", b64.clone())
                .verify(),
            Passed
        );
        assert_eq!(
            signed()
                .encoding("base64")
                .header("x-signature", b64.to_lowercase())
                .verify(),
            Invalid
        );
    }

    #[test]
    fn hmac_supports_sha1_and_sha512_digests() {
        for algorithm in ["sha1", "sha512"] {
            assert_eq!(
                signed()
                    .algorithm(algorithm)
                    .header("x-signature", hmac(BODY, SECRET, algorithm, "hex"))
                    .verify(),
                Passed
            );
            // The digest must match the configured algorithm, not just any of them.
            assert_eq!(
                signed()
                    .algorithm(algorithm)
                    .header("x-signature", hex_sha256(BODY))
                    .verify(),
                Invalid
            );
        }
    }

    #[test]
    fn hmac_accepts_any_candidate_in_a_comma_separated_header() {
        let header = format!(
            "v1={},v1={}",
            hmac(BODY, "old-secret", "sha256", "hex"),
            hex_sha256(BODY)
        );
        assert_eq!(
            signed()
                .prefix("v1=")
                .header("x-signature", header)
                .verify(),
            Passed
        );
    }

    #[test]
    fn hmac_rejects_a_comma_separated_header_where_nothing_matches() {
        let header = format!(
            "v1={},v1={}",
            hmac(BODY, "old", "sha256", "hex"),
            hmac(BODY, "older", "sha256", "hex")
        );
        assert_eq!(
            signed()
                .prefix("v1=")
                .header("x-signature", header)
                .verify(),
            Invalid
        );
    }

    #[test]
    fn hmac_ignores_empty_candidates_from_stray_commas() {
        assert_eq!(
            signed()
                .header("x-signature", format!(",,{},", hex_sha256(BODY)))
                .verify(),
            Passed
        );
        assert_eq!(signed().header("x-signature", ",,,").verify(), Invalid);
    }

    #[test]
    fn hmac_strips_the_configured_prefix_from_the_digest() {
        assert_eq!(
            signed()
                .prefix("sha256=")
                .header("x-signature", format!("sha256={}", hex_sha256(BODY)))
                .verify(),
            Passed
        );
        assert_eq!(
            signed()
                .prefix("sha256=")
                .header("x-signature", format!("sha1={}", hex_sha256(BODY)))
                .verify(),
            Invalid
        );
    }

    #[test]
    fn verifies_the_documented_sender_recipes() {
        // GitHub-style: hmac, X-Hub-Signature-256, sha256=.
        assert_eq!(
            case()
                .auth("hmac", Some(SECRET), Some("X-Hub-Signature-256"))
                .prefix("sha256=")
                .header(
                    "x-hub-signature-256",
                    format!("sha256={}", hex_sha256(BODY))
                )
                .verify(),
            Passed
        );
        // PagerDuty-style multi-signature header: hmac, v1=.
        assert_eq!(
            case()
                .auth("hmac", Some(SECRET), Some("X-PagerDuty-Signature"))
                .prefix("v1=")
                .header(
                    "x-pagerduty-signature",
                    format!(
                        "v1={},v1={}",
                        hmac(BODY, "rotated-out", "sha256", "hex"),
                        hex_sha256(BODY)
                    )
                )
                .verify(),
            Passed
        );
        // GitLab-style secret token: token, X-Gitlab-Token, no prefix.
        assert_eq!(
            case()
                .auth("token", Some(SECRET), Some("X-Gitlab-Token"))
                .header("x-gitlab-token", SECRET)
                .verify(),
            Passed
        );
        // Alertmanager-style bearer token: token, Authorization, `Bearer `.
        assert_eq!(
            case()
                .auth("token", Some(SECRET), Some("Authorization"))
                .prefix("Bearer ")
                .header("authorization", format!("Bearer {SECRET}"))
                .verify(),
            Passed
        );
        // A base64 HMAC sender.
        assert_eq!(
            case()
                .auth("hmac", Some(SECRET), Some("X-Sender-Hmac-Sha256"))
                .encoding("base64")
                .header(
                    "x-sender-hmac-sha256",
                    hmac(BODY, SECRET, "sha256", "base64")
                )
                .verify(),
            Passed
        );
    }

    #[test]
    fn verifies_a_trello_style_signature_over_the_body_and_the_callback_url() {
        let callback_url = "https://prism.example.com/agents/webhooks/trello";
        let body = r#"{"action":{"type":"createCard","data":{"card":{"name":"Fix login ✓"}}}}"#;
        assert_eq!(
            case()
                .auth("hmac", Some(SECRET), Some("X-Trello-Webhook"))
                .algorithm("sha1")
                .encoding("base64")
                .signed_url(callback_url)
                .body(Some(body))
                .header(
                    "x-trello-webhook",
                    hmac(&format!("{body}{callback_url}"), SECRET, "sha1", "base64")
                )
                .verify(),
            Passed
        );
    }
}
