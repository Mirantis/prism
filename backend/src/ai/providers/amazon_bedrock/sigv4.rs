//! AWS Signature Version 4 for a Bedrock POST, as `aws4fetch`'s `AwsV4Signer`
//! signs it: every header except the unsignable ones, `x-amz-date`, the session
//! token as `x-amz-security-token`, and the body's SHA-256.

use std::sync::LazyLock;

use hmac::{Hmac, Mac};
use regex::Regex;
use sha2::{Digest, Sha256};

/// Headers `aws4fetch` never signs.
const UNSIGNABLE_HEADERS: &[&str] = &[
    "authorization",
    "content-type",
    "content-length",
    "user-agent",
    "presigned-expires",
    "expect",
    "x-amzn-trace-id",
    "range",
    "connection",
];

/// What one signature covers.
pub struct SignInput<'a> {
    pub url: &'a str,
    pub method: &'a str,
    /// The request headers; names in any case.
    pub headers: &'a [(String, String)],
    pub body: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
    pub session_token: Option<&'a str>,
    /// `YYYYMMDDTHHMMSSZ`.
    pub datetime: &'a str,
}

/// A signed request: every header to send (lowercase names, sorted, as `Headers`
/// iterates them) and the canonical request the signature covers.
#[derive(Debug, Clone, PartialEq)]
pub struct Signed {
    pub headers: Vec<(String, String)>,
    pub canonical_string: String,
}

/// The signing time of now, as `aws4fetch` writes it.
pub fn datetime_now() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// `new Headers(init)`: lowercase names in sorted order, values without leading or
/// trailing HTTP whitespace, a repeated name joined with `, `.
fn headers_object(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        let name = name.to_lowercase();
        let value = value
            .trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
            .to_string();
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some((_, existing)) => {
                existing.push_str(", ");
                existing.push_str(&value);
            }
            None => out.push((name, value)),
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    match headers.iter_mut().find(|(n, _)| n == name) {
        Some((_, existing)) => *existing = value.to_string(),
        None => headers.push((name.to_string(), value.to_string())),
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));
}

/// `encodeRfc3986(encodeURIComponent(text))`: everything but the RFC 3986
/// unreserved characters, percent-encoded as UTF-8.
fn encode_rfc3986_component(text: &str) -> String {
    const UNRESERVED: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    percent_encoding::utf8_percent_encode(text, UNRESERVED).to_string()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Signs one request.
pub fn sign(input: &SignInput<'_>) -> anyhow::Result<Signed> {
    static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("valid regex"));
    static SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/+").expect("valid regex"));

    let url = url::Url::parse(input.url)?;
    let mut headers = headers_object(input.headers);
    headers.retain(|(name, _)| name != "host");
    set_header(&mut headers, "x-amz-date", input.datetime);
    if let Some(token) = input.session_token.filter(|t| !t.is_empty()) {
        set_header(&mut headers, "x-amz-security-token", token);
    }

    let mut signable: Vec<String> = std::iter::once("host".to_string())
        .chain(headers.iter().map(|(name, _)| name.clone()))
        .filter(|name| !UNSIGNABLE_HEADERS.contains(&name.as_str()))
        .collect();
    signable.sort();
    let signed_headers = signable.join(";");
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
        None => url.host_str().unwrap_or("").to_string(),
    };
    let canonical_headers = signable
        .iter()
        .map(|name| {
            let value = if name == "host" {
                host.clone()
            } else {
                let value = headers
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, v)| v.as_str())
                    .unwrap_or("");
                WHITESPACE.replace_all(value, " ").into_owned()
            };
            format!("{name}:{value}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let credential_scope = format!(
        "{}/{}/{}/aws4_request",
        &input.datetime[..8],
        input.region,
        input.service
    );

    let path = SLASHES.replace_all(url.path(), "/").into_owned();
    let encoded_path = encode_rfc3986_component(&path).replace("%2F", "/");
    let mut query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !key.is_empty())
        .map(|(key, value)| {
            (
                encode_rfc3986_component(&key),
                encode_rfc3986_component(&value),
            )
        })
        .collect();
    query.sort();
    let encoded_search = query
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");

    let body_hash = headers
        .iter()
        .find(|(name, _)| name == "x-amz-content-sha256")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| sha256_hex(input.body.as_bytes()));
    let canonical_string = [
        input.method.to_uppercase(),
        encoded_path,
        encoded_search,
        format!("{canonical_headers}\n"),
        signed_headers.clone(),
        body_hash,
    ]
    .join("\n");

    let string_to_sign = [
        "AWS4-HMAC-SHA256".to_string(),
        input.datetime.to_string(),
        credential_scope.clone(),
        sha256_hex(canonical_string.as_bytes()),
    ]
    .join("\n");
    let k_date = hmac(
        format!("AWS4{}", input.secret_access_key).as_bytes(),
        &input.datetime[..8],
    );
    let k_region = hmac(&k_date, input.region);
    let k_service = hmac(&k_region, input.service);
    let k_credentials = hmac(&k_service, "aws4_request");
    let signature = hex::encode(hmac(&k_credentials, &string_to_sign));

    set_header(
        &mut headers,
        "authorization",
        &format!(
            "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.access_key_id
        ),
    );
    Ok(Signed {
        headers,
        canonical_string,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixtures() -> Vec<Value> {
        let text = include_str!("testdata/sdk_requests.json");
        let all: Value = serde_json::from_str(text).unwrap();
        all["sigv4"].as_array().unwrap().clone()
    }

    #[test]
    fn signs_as_aws4fetch_does() {
        for case in fixtures() {
            let headers: Vec<(String, String)> = case["headers"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect();
            let signed = sign(&SignInput {
                url: case["url"].as_str().unwrap(),
                method: "POST",
                headers: &headers,
                body: case["body"].as_str().unwrap(),
                region: case["region"].as_str().unwrap(),
                service: "bedrock",
                access_key_id: case["accessKeyId"].as_str().unwrap(),
                secret_access_key: case["secretAccessKey"].as_str().unwrap(),
                session_token: case["sessionToken"].as_str(),
                datetime: case["datetime"].as_str().unwrap(),
            })
            .unwrap();
            let name = case["name"].as_str().unwrap();
            assert_eq!(
                signed.canonical_string,
                case["canonicalString"].as_str().unwrap(),
                "{name}"
            );
            let expected: Vec<(String, String)> = case["signedHeaders"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect();
            assert_eq!(signed.headers, expected, "{name}");
        }
    }

    /// The `get-vanilla` and `post-vanilla` cases of the AWS Signature Version 4
    /// test suite.
    #[test]
    fn matches_the_aws_test_suite() {
        let headers = vec![("Host".to_string(), "example.amazonaws.com".to_string())];
        let input = |method| SignInput {
            url: "https://example.amazonaws.com/",
            method,
            headers: &headers,
            body: "",
            region: "us-east-1",
            service: "service",
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            session_token: None,
            datetime: "20150830T123600Z",
        };
        let authorization = |signed: Signed| {
            signed
                .headers
                .into_iter()
                .find(|(n, _)| n == "authorization")
                .unwrap()
                .1
        };
        assert_eq!(
            authorization(sign(&input("GET")).unwrap()),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
        assert_eq!(
            authorization(sign(&input("POST")).unwrap()),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
        );
    }

    /// The `aws-sigv4` crate signs the same canonical request to the same signature.
    #[test]
    fn agrees_with_the_aws_sigv4_crate() {
        use aws_credential_types::Credentials;
        use aws_sigv4::http_request::{SignableBody, SignableRequest, SigningSettings};
        use aws_sigv4::sign::v4;

        let url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-opus-5-5/invoke";
        let body = r#"{"max_tokens":16,"messages":[],"anthropic_version":"bedrock-2023-05-31"}"#;
        let headers = vec![
            (
                "anthropic-beta".to_string(),
                "context-1m-2025-08-07".to_string(),
            ),
            ("content-type".to_string(), "application/json".to_string()),
        ];
        let ours = sign(&SignInput {
            url,
            method: "POST",
            headers: &headers,
            body,
            region: "us-east-1",
            service: "bedrock",
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: "secret",
            session_token: Some("token"),
            datetime: "20261106T120000Z",
        })
        .unwrap();
        let ours_authorization = ours
            .headers
            .iter()
            .find(|(n, _)| n == "authorization")
            .unwrap()
            .1
            .clone();

        let identity =
            Credentials::new("AKIDEXAMPLE", "secret", Some("token".into()), None, "test").into();
        let mut settings = SigningSettings::default();
        settings.excluded_headers = Some(
            UNSIGNABLE_HEADERS
                .iter()
                .map(|h| std::borrow::Cow::Borrowed(*h))
                .collect(),
        );
        let time = chrono::DateTime::parse_from_rfc3339("2026-11-06T12:00:00Z").unwrap();
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region("us-east-1")
            .name("bedrock")
            .time(std::time::SystemTime::from(time))
            .settings(settings)
            .build()
            .unwrap()
            .into();
        let request = SignableRequest::new(
            "POST",
            url,
            headers.iter().map(|(k, v)| (k.as_str(), v.as_str())),
            SignableBody::Bytes(body.as_bytes()),
        )
        .unwrap();
        let (instructions, _) = aws_sigv4::http_request::sign(request, &params)
            .unwrap()
            .into_parts();
        let theirs = instructions
            .headers()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .unwrap()
            .1
            .to_string();
        assert_eq!(ours_authorization, theirs);
    }
}
