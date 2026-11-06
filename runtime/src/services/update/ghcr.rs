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

use regex::Regex;
use serde::Deserialize;

use crate::constants::{RELEASE_VERSION_RE, UPDATE_GITHUB_REPO};
use crate::log_debug;

const REGISTRY: &str = "https://ghcr.io";
const FETCH_TIMEOUT_MS: u64 = 10_000;
/// Pagination backstop — far above the real tag count.
const MAX_TAG_PAGES: usize = 50;

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
/// cannot complete. Anonymous: fetches a pull-scoped registry token
/// (`<REGISTRY>/token?service=ghcr.io&scope=repository:<repo>:pull`), then pages
/// through `/v2/<repo>/tags/list?n=100` following Link headers, each request
/// bounded by `FETCH_TIMEOUT_MS`.
///
/// Debug logs: `[Update] GHCR token request failed: <status>`, `[Update] GHCR
/// token response had no token`, `[Update] GHCR tags list failed: <status>`,
/// `[Update] check failed: <message>`.
pub async fn fetch_latest_release_version() -> Option<String> {
    todo!()
}

static NEXT_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<([^>]+)>\s*;\s*rel="next""#).unwrap());

/// Resolve the RFC 5988 `Link: <...>; rel="next"` header against the registry
/// host. An absolute URL resolves as-is, so the host is pinned: a header naming
/// somewhere else would otherwise send the bearer token there on the next
/// request. It is only an anonymous pull token, and the header arrives from
/// ghcr.io over TLS, but the check is one line.
fn next_page_url(link_header: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(link_header) = link_header else {
        return Ok(None);
    };
    let Some(caps) = NEXT_LINK_RE.captures(link_header) else {
        return Ok(None);
    };
    let registry = url::Url::parse(REGISTRY)?;
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
