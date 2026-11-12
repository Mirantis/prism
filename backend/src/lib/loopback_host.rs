//! Whether a hostname names this machine: a bind address, or the host part of a
//! `Host` or `Origin` header.
//!
//! The value goes through the URL parser first, which gives every spelling of an
//! address one form: `127.1` and `0x7f.1` become `127.0.0.1`, and
//! `0:0:0:0:0:0:0:1` becomes `[::1]`. A zone index (`::1%lo0`) is dropped first,
//! because the parser refuses it and the socket binds the address without it.
//! Any other value the parser cannot read is compared as written.
//!
//! `localhost` and names under it count, as RFC 6761 reserves them for loopback.
//! A name that only resolves to loopback through `/etc/hosts` or DNS does not:
//! this decides from the text, so it is not exhaustive.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

const LOOPBACK_HOSTNAMES: [&str; 3] = ["localhost", "localhost.", "[::1]"];

/// The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
static IPV4_LOOPBACK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^127(\.[0-9]{1,3}){3}$").expect("valid regex"));

/// The same block as an IPv4-mapped IPv6 address, which the parser writes in hex.
static IPV4_MAPPED_LOOPBACK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$").expect("valid regex"));

static LOCALHOST_SUBDOMAIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.localhost\.?$").expect("valid regex"));

/// Drops a zone index: from the first `%` up to a `]` or the end.
fn unzone(raw: &str) -> String {
    let Some(start) = raw.find('%') else {
        return raw.to_string();
    };
    let end = raw[start..]
        .find(']')
        .map(|i| start + i)
        .unwrap_or(raw.len());
    format!("{}{}", &raw[..start], &raw[end..])
}

fn normalize_hostname(raw: &str) -> String {
    let unzoned = unzone(raw);
    let bracketed = if unzoned.contains(':') && !unzoned.starts_with('[') {
        format!("[{unzoned}]")
    } else {
        unzoned.clone()
    };
    match Url::parse(&format!("http://{bracketed}")) {
        Ok(url) => url.host_str().unwrap_or_default().to_string(),
        Err(_) => unzoned.to_lowercase(),
    }
}

pub fn is_loopback_hostname(hostname: &str) -> bool {
    let normalized = normalize_hostname(hostname);
    LOOPBACK_HOSTNAMES.contains(&normalized.as_str())
        || LOCALHOST_SUBDOMAIN.is_match(&normalized)
        || IPV4_LOOPBACK.is_match(&normalized)
        || IPV4_MAPPED_LOOPBACK.is_match(&normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_spelling_of_a_loopback_address() {
        for host in [
            "127.0.0.1",
            "localhost",
            "::1",
            "127.1",
            "0x7f.1",
            "2130706433",
            "::ffff:127.0.0.1",
            "0:0:0:0:0:0:0:1",
            "[::1]",
            "localhost.",
            "LOCALHOST",
            "::1%lo0",
            "[::1%lo0]",
            "agent.localhost",
        ] {
            assert!(is_loopback_hostname(host), "{host}");
        }
    }

    #[test]
    fn refuses_a_wider_address() {
        for host in [
            "0.0.0.0",
            "::",
            "192.0.2.10",
            "::ffff:192.0.2.10",
            "fe80::1%en0",
            "example.com",
        ] {
            assert!(!is_loopback_hostname(host), "{host}");
        }
    }
}
