//! The public internet, as an outbound read may reach it.
//!
//! The runtime process is on the host's network, so an address the agent chooses
//! could reach the host's loopback services, the LAN and the cloud metadata service.
//! The client from `get_public_dispatcher` checks every DNS answer when it
//! connects, so the address a connection uses is an address that was checked, and
//! `assert_public_literal` checks an address written in the URL itself.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, LazyLock};

use reqwest::dns::{Name, Resolve, Resolving};

/// IPv4 ranges outside the public internet, from the IANA special-purpose registry.
const NON_PUBLIC_IPV4: [(Ipv4Addr, u8); 15] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 88, 99, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];

/// IPv6 ranges outside the public internet. `::/96` holds the unspecified and loopback
/// addresses and the deprecated IPv4-compatible form. `2001::/23` holds the IETF
/// protocol assignments, Teredo, benchmarking and ORCHID among them, and no web server.
const NON_PUBLIC_IPV6: [(Ipv6Addr, u8); 12] = [
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0), 96),
    (Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64),
    (Ipv6Addr::new(0x100, 0, 0, 1, 0, 0, 0, 0), 64),
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
    (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),
    (Ipv6Addr::new(0x5f00, 0, 0, 0, 0, 0, 0, 0), 16),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
];

/// The IPv6 rules: the list above, plus, for each IPv4 rule, the NAT64, 6to4 and
/// IPv4-translated (`::ffff:0:a.b.c.d`) forms, which contain an IPv4 address that a
/// translator or gateway delivers to. An IPv4-mapped address (`::ffff:127.0.0.1`)
/// is checked against the IPv4 rules instead.
static NON_PUBLIC_V6_RULES: LazyLock<Vec<(u128, u8)>> = LazyLock::new(|| {
    let mut rules = Vec::new();
    for (network, prefix) in NON_PUBLIC_IPV4 {
        let [a, b, c, d] = network.octets();
        let high = (u16::from(a) << 8) | u16::from(b);
        let low = (u16::from(c) << 8) | u16::from(d);
        rules.push((
            u128::from(Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, high, low)),
            96 + prefix,
        ));
        rules.push((
            u128::from(Ipv6Addr::new(0x2002, high, low, 0, 0, 0, 0, 0)),
            16 + prefix,
        ));
        rules.push((
            u128::from(Ipv6Addr::new(0, 0, 0, 0, 0xffff, 0, high, low)),
            96 + prefix,
        ));
    }
    for (network, prefix) in NON_PUBLIC_IPV6 {
        rules.push((u128::from(network), prefix));
    }
    rules
});

fn in_ipv4_subnet(address: Ipv4Addr, network: Ipv4Addr, prefix: u8) -> bool {
    prefix == 0 || (u32::from(address) ^ u32::from(network)) >> (32 - u32::from(prefix)) == 0
}

fn in_ipv6_subnet(address: u128, network: u128, prefix: u8) -> bool {
    prefix == 0 || (address ^ network) >> (128 - u32::from(prefix)) == 0
}

fn is_non_public_ipv4(address: Ipv4Addr) -> bool {
    NON_PUBLIC_IPV4
        .iter()
        .any(|&(network, prefix)| in_ipv4_subnet(address, network, prefix))
}

/// Whether an IP address is on the public internet. Anything that is not an IP address is not.
pub fn is_public_address(address: &str) -> bool {
    match address.parse::<IpAddr>() {
        Err(_) => false,
        Ok(IpAddr::V4(v4)) => !is_non_public_ipv4(v4),
        Ok(IpAddr::V6(v6)) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                if is_non_public_ipv4(v4) {
                    return false;
                }
            }
            let value = u128::from(v6);
            !NON_PUBLIC_V6_RULES
                .iter()
                .any(|&(network, prefix)| in_ipv6_subnet(value, network, prefix))
        }
    }
}

/// A host that is, or resolves to, an address outside the public internet.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{address} is not a public address")]
pub struct PrivateAddressError {
    pub hostname: String,
    pub address: String,
}

impl PrivateAddressError {
    pub const CODE: &'static str = "EPRIVATEADDRESS";
    pub const NAME: &'static str = "PrivateAddressError";

    pub fn new(hostname: impl Into<String>, address: impl Into<String>) -> Self {
        Self {
            hostname: hostname.into(),
            address: address.into(),
        }
    }

    /// `"EPRIVATEADDRESS"`.
    pub fn code(&self) -> &'static str {
        Self::CODE
    }
}

/// Refuse an address literal that is not public. A connection to a literal makes no
/// DNS lookup, so `PublicResolver` never sees it. `hostname` is `URL.hostname`, which
/// keeps the brackets of an IPv6 literal.
pub fn assert_public_literal(hostname: &str) -> Result<(), PrivateAddressError> {
    let host = match hostname.strip_prefix('[') {
        Some(rest) => {
            let mut chars = rest.chars();
            chars.next_back();
            chars.as_str()
        }
        None => hostname,
    };
    if host.parse::<IpAddr>().is_ok() && !is_public_address(host) {
        return Err(PrivateAddressError::new(host, host));
    }
    Ok(())
}

/// The DNS lookup for a connection, failing with `PrivateAddressError` when any
/// answer is not public. Every answer is checked, because the connection may use
/// any of them.
#[derive(Debug, Clone, Copy, Default)]
pub struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let hostname = name.as_str().to_string();
            let answers: Vec<std::net::SocketAddr> =
                tokio::net::lookup_host((hostname.as_str(), 0))
                    .await?
                    .collect();
            if let Some(refused) = answers
                .iter()
                .find(|a| !is_public_address(&a.ip().to_string()))
            {
                let err: Box<dyn std::error::Error + Send + Sync> = Box::new(
                    PrivateAddressError::new(hostname.clone(), refused.ip().to_string()),
                );
                return Err(err);
            }
            let addrs: reqwest::dns::Addrs = Box::new(answers.into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_addresses_outside_the_public_internet() {
        for address in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.31.255.255",
            "192.0.0.8",
            "192.168.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:a9fe:a9fe",
            "::127.0.0.1",
            "::ffff:0:127.0.0.1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "100::1",
            "5f00::1",
            "2002:7f00:1::",
            "2001:0:4136:e378::1",
            "2001:1ff:ffff::1",
            "2001:db8::1",
            "3fff::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "localhost",
        ] {
            assert!(!is_public_address(address), "{address}");
        }
    }

    #[test]
    fn allows_public_addresses() {
        for address in [
            "1.1.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700:4700::1111",
            "2001:200::1",
            "64:ff9b::808:808",
            "2002:808:808::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_address(address), "{address}");
        }
    }

    #[test]
    fn refuses_a_private_literal_and_leaves_a_name_to_the_connection() {
        assert_eq!(
            assert_public_literal("[::1]").unwrap_err().address,
            "::1".to_string()
        );
        assert!(assert_public_literal("127.0.0.1").is_err());
        assert!(assert_public_literal("[2606:4700:4700::1111]").is_ok());
        assert!(assert_public_literal("localhost").is_ok());
    }

    #[tokio::test]
    async fn refuses_a_name_that_resolves_to_loopback() {
        let resolved = PublicResolver.resolve("localhost".parse().unwrap()).await;
        assert!(resolved.is_err());
    }
}

static PUBLIC_DISPATCHER: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(PublicResolver))
        .no_proxy()
        .build()
        .expect("the public HTTP client builds")
});

/// The client for a direct read: each connection resolves its host with `PublicResolver`.
pub fn get_public_dispatcher() -> reqwest::Client {
    PUBLIC_DISPATCHER.clone()
}
