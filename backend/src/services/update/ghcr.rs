//! Version check against the GHCR container registry.
//!
//! The registry's tag list is the single source of "what is the latest
//! release" for every install shape: release-production.yml pushes the
//! release tag (vYYYY.M.DDHHMMSS) and `latest` in one atomic
//! `imagetools create` call, and version-shaped tags come only from that
//! workflow — so the highest release tag is what `latest` points to. Reading
//! the tag list needs no auth (an anonymous registry token) and no manifest
//! fetches.
//!
//! Every failure here returns `None` and logs at debug only: an update check
//! that cannot run is a non-event, never a user-visible error.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::constants::{RELEASE_VERSION_RE, UPDATE_GITHUB_REPO};
use crate::log_debug;

const REGISTRY: &str = "https://ghcr.io";
const FETCH_TIMEOUT_MS: u64 = 10_000;
/// Pagination backstop — far above the real tag count.
const MAX_TAG_PAGES: usize = 50;

/// The registry client. No proxy, as Node's `fetch` uses none.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("the registry client builds")
});

/// Parse a release tag (vYYYY.M.DDHHMMSS) into its numeric segments.
/// The third segment concatenates the unpadded day with a zero-padded HHMMSS,
/// so it is monotonic within a month and numeric compare is correct.
pub fn parse_release_version(tag: &str) -> Option<[i64; 3]> {
    if !RELEASE_VERSION_RE.is_match(tag) {
        return None;
    }
    let mut parts = tag[1..].split('.').map(|part| part.parse::<i64>().ok());
    Some([parts.next()??, parts.next()??, parts.next()??])
}

/// Numeric per-segment compare of two release tags: negative, zero, positive.
/// Fails with `not release versions: <a>, <b>` when either is not a release tag.
pub fn compare_release_versions(a: &str, b: &str) -> anyhow::Result<i64> {
    let (Some(pa), Some(pb)) = (parse_release_version(a), parse_release_version(b)) else {
        anyhow::bail!("not release versions: {a}, {b}");
    };
    for i in 0..3 {
        if pa[i] != pb[i] {
            return Ok(pa[i] - pb[i]);
        }
    }
    Ok(0)
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TagsPage {
    tags: Option<serde_json::Value>,
}

/// The newest release version published to GHCR, or `None` when the check
/// cannot complete. Anonymous: fetches a pull-scoped registry token, then pages
/// through `/v2/<repo>/tags/list` following Link headers.
pub async fn fetch_latest_release_version() -> Option<String> {
    fetch_latest_release_version_from(REGISTRY).await
}

/// [`fetch_latest_release_version`] against `registry`.
async fn fetch_latest_release_version_from(registry: &str) -> Option<String> {
    match fetch_latest(registry).await {
        Ok(latest) => latest,
        Err(err) => {
            log_debug!("[Update] check failed: {}", err);
            None
        }
    }
}

async fn fetch_latest(registry: &str) -> anyhow::Result<Option<String>> {
    let timeout = Duration::from_millis(FETCH_TIMEOUT_MS);
    let token_res = CLIENT
        .get(format!(
            "{registry}/token?service=ghcr.io&scope=repository:{UPDATE_GITHUB_REPO}:pull"
        ))
        .timeout(timeout)
        .send()
        .await?;
    if !token_res.status().is_success() {
        log_debug!(
            "[Update] GHCR token request failed: {}",
            token_res.status().as_u16()
        );
        return Ok(None);
    }
    let token_body: Value = token_res.json().await?;
    let token = match token_body.get("token") {
        Some(Value::String(token)) if !token.is_empty() => token.clone(),
        _ => {
            log_debug!("[Update] GHCR token response had no token");
            return Ok(None);
        }
    };

    let mut latest: Option<String> = None;
    let mut url = Some(format!(
        "{registry}/v2/{UPDATE_GITHUB_REPO}/tags/list?n=100"
    ));
    let mut page = 0;
    while let Some(current) = url.take() {
        if page >= MAX_TAG_PAGES {
            break;
        }
        page += 1;
        let res = CLIENT
            .get(&current)
            .header("Authorization", format!("Bearer {token}"))
            .timeout(timeout)
            .send()
            .await?;
        if !res.status().is_success() {
            log_debug!("[Update] GHCR tags list failed: {}", res.status().as_u16());
            return Ok(None);
        }
        let link = res
            .headers()
            .get("link")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body: TagsPage = res.json().await?;
        let tags = match body.tags {
            Some(Value::Array(tags)) => tags,
            _ => Vec::new(),
        };
        for tag in tags {
            let Value::String(tag) = tag else { continue };
            if !RELEASE_VERSION_RE.is_match(&tag) {
                continue;
            }
            let newer = match &latest {
                None => true,
                Some(current) => compare_release_versions(&tag, current)? > 0,
            };
            if newer {
                latest = Some(tag);
            }
        }
        url = next_page_url(registry, link.as_deref())?;
    }
    Ok(latest)
}

static NEXT_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<([^>]+)>\s*;\s*rel="next""#).unwrap());

/// Resolve the RFC 5988 `Link: <...>; rel="next"` header against the registry
/// host. An absolute URL resolves as-is, so the host is pinned: a header naming
/// somewhere else would otherwise send the bearer token there on the next
/// request. It is only an anonymous pull token, and the header arrives from
/// ghcr.io over TLS, but the check is one line.
fn next_page_url(registry: &str, link_header: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(link_header) = link_header.filter(|header| !header.is_empty()) else {
        return Ok(None);
    };
    let Some(caps) = NEXT_LINK_RE.captures(link_header) else {
        return Ok(None);
    };
    let registry = url::Url::parse(registry)?;
    let next = registry.join(&caps[1])?;
    if next.origin() != registry.origin() {
        log_debug!(
            "[Update] ignoring a next-page link off the registry host: {}",
            next.origin().ascii_serialization()
        );
        return Ok(None);
    }
    Ok(Some(next.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::extract::{Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use parking_lot::Mutex;

    #[test]
    fn parses_a_release_tag_into_numeric_segments() {
        assert_eq!(
            parse_release_version("v2026.8.24083158"),
            Some([2026, 8, 24083158])
        );
    }

    #[test]
    fn rejects_anything_not_release_shaped() {
        for tag in [
            "dev",
            "0.1.0",
            "v2026.8",
            "canary",
            "latest",
            "v2026.08.1x",
            "1aa19077",
        ] {
            assert_eq!(parse_release_version(tag), None, "{tag}");
        }
    }

    #[test]
    fn compares_day_and_time_numerically_within_a_month() {
        assert!(compare_release_versions("v2026.8.5090000", "v2026.8.24083158").unwrap() < 0);
    }

    #[test]
    fn orders_across_month_and_year_rollovers() {
        assert!(compare_release_versions("v2026.9.1000000", "v2026.8.31235959").unwrap() > 0);
        assert!(compare_release_versions("v2027.1.1000000", "v2026.12.31235959").unwrap() > 0);
    }

    #[test]
    fn returns_zero_for_equal_tags() {
        assert_eq!(
            compare_release_versions("v2026.8.24083158", "v2026.8.24083158").unwrap(),
            0
        );
    }

    #[test]
    fn fails_on_non_release_input() {
        let err = compare_release_versions("dev", "v2026.8.24083158").unwrap_err();
        assert_eq!(
            err.to_string(),
            "not release versions: dev, v2026.8.24083158"
        );
    }

    #[test]
    fn pins_the_next_page_link_to_the_registry_host() {
        assert_eq!(
            next_page_url(
                REGISTRY,
                Some(r#"</v2/lensapp/prism-agent/tags/list?n=100&last=x>; rel="next""#)
            )
            .unwrap()
            .as_deref(),
            Some("https://ghcr.io/v2/lensapp/prism-agent/tags/list?n=100&last=x")
        );
        assert_eq!(
            next_page_url(REGISTRY, Some(r#"<https://evil.test/x>; rel="next""#)).unwrap(),
            None
        );
        assert_eq!(next_page_url(REGISTRY, None).unwrap(), None);
    }

    /// One scripted answer: status, body, optional Link header.
    type Answer = (u16, Value, Option<String>);

    #[derive(Clone, Default)]
    struct Registry {
        answers: Arc<Mutex<Vec<Answer>>>,
        requests: Arc<Mutex<Vec<String>>>,
    }

    async fn answer(
        State(registry): State<Registry>,
        uri: axum::http::Uri,
        _query: Query<std::collections::HashMap<String, String>>,
        _headers: HeaderMap,
    ) -> Response {
        registry.requests.lock().push(uri.to_string());
        let next = {
            let mut answers = registry.answers.lock();
            if answers.is_empty() {
                None
            } else {
                Some(answers.remove(0))
            }
        };
        let Some((status, body, link)) = next else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let mut response =
            (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response();
        if let Some(link) = link {
            response.headers_mut().insert("link", link.parse().unwrap());
        }
        response
    }

    async fn registry(answers: Vec<Answer>) -> (String, Registry) {
        let state = Registry {
            answers: Arc::new(Mutex::new(answers)),
            requests: Arc::default(),
        };
        let app = axum::Router::new()
            .fallback(answer)
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), state)
    }

    fn ok(body: Value) -> Answer {
        (200, body, None)
    }

    #[tokio::test]
    async fn picks_the_highest_release_tag_across_pages() {
        let (base, state) = registry(vec![
            ok(serde_json::json!({ "token": "tok" })),
            (
                200,
                serde_json::json!({ "tags": ["latest", "canary", "1aa190771c3698cf", "v2026.5.26071530", "v2026.8.5090000"] }),
                Some(r#"</v2/lensapp/prism-agent/tags/list?n=100&last=x>; rel="next""#.to_string()),
            ),
            ok(serde_json::json!({ "tags": ["v2026.8.24083158", "pr-12-foo"] })),
        ])
        .await;

        assert_eq!(
            fetch_latest_release_version_from(&base).await.as_deref(),
            Some("v2026.8.24083158")
        );
        let requests = state.requests.lock().clone();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("/token"));
        assert!(requests[0].contains("repository:lensapp/prism-agent:pull"));
        assert_eq!(
            requests[2],
            "/v2/lensapp/prism-agent/tags/list?n=100&last=x"
        );
    }

    #[tokio::test]
    async fn answers_none_when_the_token_request_fails() {
        let (base, _) = registry(vec![(500, serde_json::json!({}), None)]).await;
        assert_eq!(fetch_latest_release_version_from(&base).await, None);
    }

    #[tokio::test]
    async fn answers_none_when_the_token_response_has_no_token() {
        let (base, _) = registry(vec![ok(serde_json::json!({}))]).await;
        assert_eq!(fetch_latest_release_version_from(&base).await, None);
    }

    #[tokio::test]
    async fn answers_none_when_the_tags_list_fails() {
        let (base, _) = registry(vec![
            ok(serde_json::json!({ "token": "tok" })),
            (401, serde_json::json!({}), None),
        ])
        .await;
        assert_eq!(fetch_latest_release_version_from(&base).await, None);
    }

    #[tokio::test]
    async fn answers_none_when_no_release_shaped_tag_exists() {
        let (base, _) = registry(vec![
            ok(serde_json::json!({ "token": "tok" })),
            ok(serde_json::json!({ "tags": ["latest", "canary"] })),
        ])
        .await;
        assert_eq!(fetch_latest_release_version_from(&base).await, None);
    }

    #[tokio::test]
    async fn answers_none_on_a_network_failure() {
        // Nothing listens on this port.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        assert_eq!(
            fetch_latest_release_version_from(&format!("http://{addr}")).await,
            None
        );
    }
}
