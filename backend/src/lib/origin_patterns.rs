//! Origin patterns: the syntax of a configured list of browser origins.
//!
//! The list is comma-separated, and each entry takes one of two forms:
//!
//! - `scheme://host[:port]` names one origin. The port is compared after URL
//!   normalization, so `https://h` and `https://h:443` are the same entry.
//! - `scheme://host:*` names every port of that host, the scheme's default port
//!   included, because a browser leaves the default port out of `Origin`.
//!
//! The scheme is `http` or `https`, and scheme and host compare
//! case-insensitively. A `*` anywhere other than the port, a path, a query, a
//! fragment and userinfo make the entry invalid, and the parser fails with the
//! entry named, so a typo stops startup.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OriginPattern {
    /// `http:` or `https:`.
    pub protocol: String,
    /// Lowercase, as the URL parser gives it; an IPv6 literal keeps its brackets.
    pub hostname: String,
    /// The normalized port (`""` for the scheme's default), or `*` for any port.
    pub port: String,
}

const ANY_PORT: &str = ":*";

/// `http://` or `https://` and an authority, with nothing after it. The raw text
/// is checked first: the URL parser accepts `*` in a hostname, drops a trailing
/// `/` or an empty `?`, repairs `https:host`, and decodes `%2A` into a hostname.
static BARE_ORIGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://[^/?#@\\\s*%]+$").expect("valid regex"));

/// An `Origin` header value: the same shape, with one trailing `/` tolerated.
static ORIGIN_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://[^/?#@\\\s%]+/?$").expect("valid regex"));

/// A port on the authority. The brackets of an IPv6 literal hold colons too.
static EXPLICIT_PORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r":[^:\]]*$").expect("valid regex"));

fn port_text(url: &Url) -> String {
    url.port().map(|port| port.to_string()).unwrap_or_default()
}

fn parse_entry(entry: &str) -> anyhow::Result<OriginPattern> {
    let invalid = || {
        anyhow::anyhow!(
            "Invalid origin pattern \"{entry}\": expected scheme://host[:port] or scheme://host:* with scheme http or https"
        )
    };

    let any_port = entry.ends_with(ANY_PORT);
    let bare = if any_port {
        &entry[..entry.len() - ANY_PORT.len()]
    } else {
        entry
    };
    if !BARE_ORIGIN.is_match(bare) {
        return Err(invalid());
    }
    // A port and the wildcard together, the scheme's default port included.
    let authority = bare.find("//").map(|i| &bare[i + 2..]).unwrap_or(bare);
    if any_port && EXPLICIT_PORT.is_match(authority) {
        return Err(invalid());
    }
    // An empty port.
    if bare.ends_with(':') {
        return Err(invalid());
    }

    let url = Url::parse(bare).map_err(|_| invalid())?;
    let hostname = url.host_str().unwrap_or_default().to_string();
    // A trailing-dot host and port 0 can never match an `Origin` a browser sends,
    // so either is a typo.
    if hostname.ends_with('.') || url.port() == Some(0) {
        return Err(invalid());
    }
    Ok(OriginPattern {
        protocol: format!("{}:", url.scheme()),
        hostname,
        port: if any_port {
            "*".to_string()
        } else {
            port_text(&url)
        },
    })
}

/// Parses a comma-separated list. Blank items are skipped; an empty list matches nothing.
pub fn parse_origin_patterns(csv: &str) -> anyhow::Result<Vec<OriginPattern>> {
    csv.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(parse_entry)
        .collect()
}

/// Whether the request's `Origin` header names an origin the list admits. A match
/// needs `http://` or `https://` and a host the URL parser reads, with at most a
/// trailing `/` after it, so the literal `null`, a path, a query and userinfo
/// never match.
pub fn matches_origin(patterns: &[OriginPattern], origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return false;
    };
    if origin.is_empty() || patterns.is_empty() {
        return false;
    }
    if !ORIGIN_HEADER.is_match(origin) {
        return false;
    }
    let Ok(parsed) = Url::parse(origin) else {
        return false;
    };
    let protocol = format!("{}:", parsed.scheme());
    let hostname = parsed.host_str().unwrap_or_default();
    let port = port_text(&parsed);
    patterns.iter().any(|pattern| {
        pattern.protocol == protocol
            && pattern.hostname == hostname
            && (pattern.port == "*" || pattern.port == port)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(protocol: &str, hostname: &str, port: &str) -> OriginPattern {
        OriginPattern {
            protocol: protocol.into(),
            hostname: hostname.into(),
            port: port.into(),
        }
    }

    fn error_text(csv: &str) -> String {
        parse_origin_patterns(csv).expect_err(csv).to_string()
    }

    #[test]
    fn accepts_each_valid_form() {
        for entry in [
            "https://app.example.com",
            "https://app.example.com:8443",
            "https://app.example.com:*",
            "http://localhost:*",
            "HTTPS://App.Example.COM",
        ] {
            assert_eq!(parse_origin_patterns(entry).unwrap().len(), 1, "{entry}");
        }
    }

    #[test]
    fn normalizes_scheme_and_host_to_lowercase() {
        assert_eq!(
            parse_origin_patterns("HTTPS://App.Example.COM").unwrap(),
            vec![pattern("https:", "app.example.com", "")]
        );
    }

    #[test]
    fn ignores_surrounding_whitespace_and_empty_items() {
        assert_eq!(
            parse_origin_patterns(" https://a.example.com , ,https://b.example.com ")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn reads_an_empty_string_as_no_patterns() {
        assert_eq!(parse_origin_patterns("").unwrap(), vec![]);
    }

    #[test]
    fn rejects_an_invalid_entry_and_names_it() {
        for entry in [
            "*",
            "https://*.example.com",
            "https://app.*.com",
            "https://app.example.com/",
            "https://app.example.com/path",
            "https://app.example.com?q=1",
            "https://app.example.com#frag",
            "https://user@app.example.com",
            "https://user:pw@app.example.com",
            "null",
            "ftp://app.example.com",
            "app.example.com",
            "https://app.example.com:*:*",
            "https://app.example.com:abc",
            "https://",
        ] {
            let text = error_text(&format!("https://ok.example.com,{entry}"));
            assert!(text.contains(&format!("\"{entry}\"")), "{entry}: {text}");
        }
    }

    #[test]
    fn rejects_a_port_together_with_the_wildcard() {
        for entry in [
            "https://app.example.com:443:*",
            "https://app.example.com:8443:*",
        ] {
            assert!(
                error_text(entry).contains(&format!("\"{entry}\"")),
                "{entry}"
            );
        }
    }

    #[test]
    fn reads_an_explicit_default_port_as_none() {
        assert_eq!(
            parse_origin_patterns("https://app.example.com:443").unwrap(),
            parse_origin_patterns("https://app.example.com").unwrap()
        );
    }

    #[test]
    fn rejects_the_edge_cases_every_component_refuses() {
        for entry in [
            "https://%2A.example.com",
            "https://app.example.com.",
            "https://app.example.com.:*",
            "https://app.example.com:0",
            "https://app.example.com:",
            "https://app.example.com::*",
        ] {
            assert!(
                error_text(entry).contains(&format!("\"{entry}\"")),
                "{entry}"
            );
        }
    }

    #[test]
    fn accepts_any_port_of_an_ipv6_loopback_literal() {
        assert_eq!(
            parse_origin_patterns("http://[::1]:*").unwrap(),
            vec![pattern("http:", "[::1]", "*")]
        );
    }

    fn patterns() -> Vec<OriginPattern> {
        parse_origin_patterns("https://app.example.com, https://any.example.com:*").unwrap()
    }

    #[test]
    fn matches_each_origin_as_the_table_says() {
        let patterns = patterns();
        for (origin, expected) in [
            (Some("https://app.example.com"), true),
            (Some("https://app.example.com:443"), true),
            (Some("https://app.example.com:8443"), false),
            (Some("http://app.example.com"), false),
            (Some("https://APP.Example.COM"), true),
            (Some("https://evil.app.example.com"), false),
            (Some("https://app.example.com.evil.com"), false),
            (Some("https://any.example.com"), true),
            (Some("https://any.example.com:443"), true),
            (Some("https://any.example.com:53224"), true),
            (Some("http://any.example.com:53224"), false),
            (Some("https://sub.any.example.com:1"), false),
            (Some("null"), false),
            (Some("not a url"), false),
            (Some(""), false),
            (None, false),
        ] {
            assert_eq!(matches_origin(&patterns, origin), expected, "{origin:?}");
        }
    }

    #[test]
    fn matches_nothing_with_an_empty_list() {
        assert!(!matches_origin(&[], Some("https://app.example.com")));
    }

    #[test]
    fn never_matches_a_malformed_origin() {
        let patterns = patterns();
        for origin in [
            "https:app.example.com",
            "https://app.example.com/path",
            "https://app.example.com?q=1",
            "https://user@app.example.com",
        ] {
            assert!(!matches_origin(&patterns, Some(origin)), "{origin}");
        }
    }

    #[test]
    fn tolerates_a_single_trailing_slash() {
        let patterns = patterns();
        assert!(matches_origin(&patterns, Some("https://app.example.com/")));
        assert!(!matches_origin(
            &patterns,
            Some("https://app.example.com//")
        ));
    }
}
