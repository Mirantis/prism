//! Lazily-built proxy client for the runtime's plain HTTP calls.
//!
//! Outbound calls normally traverse the sandbox network directly (a transparent
//! MITM that rewrites `__nexus_cred:…__` credential sentinels on the wire), so a
//! plain request matches that path with no extra work. When an EXPLICIT
//! `HTTPS_PROXY` is configured we route through it so any header rewriting
//! still applies.
//!
//! Memoized process-wide: one proxied client shared by every caller, built on
//! first use. Returns `None` — never fails — when no proxy is configured or when
//! the proxy cannot be built, so callers degrade to a direct request.
//!
//! `HTTP_PROXY` and `NO_PROXY` are deliberately not read. That's a pre-existing
//! gap; honouring them would change the behaviour of every channel's file
//! download.

use std::sync::OnceLock;

use crate::log_warn;

static PROXY_DISPATCHER: OnceLock<Option<reqwest::Client>> = OnceLock::new();

/// The shared proxied client, or `None` to fetch directly.
///
/// Reads `HTTPS_PROXY`, else `https_proxy`; an empty value counts as unset.
/// Every request of the returned client goes through that proxy.
pub async fn get_proxy_dispatcher() -> Option<reqwest::Client> {
    PROXY_DISPATCHER.get_or_init(build_proxy_dispatcher).clone()
}

fn build_proxy_dispatcher() -> Option<reqwest::Client> {
    let proxy = std::env::var("HTTPS_PROXY")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("https_proxy").ok().filter(|v| !v.is_empty()))?;
    let built =
        reqwest::Proxy::all(&proxy).and_then(|p| reqwest::Client::builder().proxy(p).build());
    match built {
        Ok(client) => Some(client),
        Err(err) => {
            log_warn!(
                "[Proxy] HTTPS_PROXY set but undici ProxyAgent unavailable: {}",
                err
            );
            None
        }
    }
}
