//! Managed providers describe protocols, not merely compatible chat SDKs.
//!
//! Voice resolves its endpoint and credential independently of chat, and keeps
//! each endpoint paired with its own credential.

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::anyhow;
use indexmap::IndexSet;
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    OpenaiRealtime,
}

#[derive(Debug, Clone, Copy)]
struct Surface {
    protocol: Protocol,
    base_url_env: &'static str,
    api_key_env: &'static str,
}

/// Order is also the legacy discovery order when Nexus supplied no provider markers.
/// OpenRouter and Mantle's OpenAI-compatible HTTP routes do not expose Realtime.
const PROVIDERS: [(&str, &[Surface]); 5] = [
    (
        "openai",
        &[Surface {
            protocol: Protocol::OpenaiRealtime,
            base_url_env: "LENS_INFERENCE_OPENAI_BASE_URL",
            api_key_env: "LENS_INFERENCE_OPENAI_API_KEY",
        }],
    ),
    (
        "azure",
        &[Surface {
            protocol: Protocol::OpenaiRealtime,
            base_url_env: "LENS_INFERENCE_AZURE_OPENAI_BASE_URL",
            api_key_env: "LENS_INFERENCE_AZURE_OPENAI_API_KEY",
        }],
    ),
    ("bedrock", &[]),
    ("bedrock-mantle", &[]),
    ("openrouter", &[]),
];

/// Where voice comes from: an explicit endpoint, a managed endpoint, direct
/// OpenAI, or nowhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeSource {
    Explicit,
    Managed,
    Direct,
    Unavailable,
}

impl RealtimeSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Managed => "managed",
            Self::Direct => "direct",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeConfiguration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub source: RealtimeSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

const MISMATCHED_MANAGED_CREDENTIAL: &str = "The managed voice credential does not match this endpoint. Set OPENAI_REALTIME_API_KEY to a separate credential for the explicit voice endpoint.";
const EXPLICIT_WITHOUT_KEY: &str = "Set OPENAI_REALTIME_API_KEY for the configured voice endpoint.";
const UNAVAILABLE: &str = "Voice needs a managed Realtime endpoint with its credential, or OPENAI_REALTIME_API_KEY for direct OpenAI. Use OPENAI_REALTIME_URL to select another voice endpoint.";

static MANAGED_PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^__(?:lens|nexus)_cred:nexus-llm(?:-|__)").expect("valid regex"));
static CREDENTIAL_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN)$").expect("valid regex"));

/// `env.NAME` as JavaScript reads it: present, possibly empty.
fn get<'a>(env: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str)
}

/// `env.NAME` where an empty value counts as unset (`||`).
fn set<'a>(env: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    get(env, name).filter(|value| !value.is_empty())
}

fn parse_url(text: &str) -> anyhow::Result<Url> {
    Url::parse(text).map_err(|_| anyhow!("Invalid URL"))
}

fn provider_order(env: &HashMap<String, String>) -> anyhow::Result<Vec<String>> {
    let primary = set(env, "LENS_MANAGED_INFERENCE_PROVIDER");
    let list = set(env, "LENS_MANAGED_INFERENCE_PROVIDERS");
    if primary.is_none() && list.is_none() {
        return Ok(PROVIDERS.iter().map(|(name, _)| name.to_string()).collect());
    }
    let parsed: serde_json::Value = match list {
        Some(list) => serde_json::from_str(list).map_err(|err| anyhow!("{err}"))?,
        None => serde_json::Value::Array(Vec::new()),
    };
    let ids: Option<Vec<String>> = parsed.as_array().and_then(|items| {
        items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect()
    });
    let Some(ids) = ids else {
        anyhow::bail!("LENS_MANAGED_INFERENCE_PROVIDERS must be a JSON array of provider IDs");
    };
    let mut order: IndexSet<String> = IndexSet::new();
    if let Some(primary) = primary {
        order.insert(primary.to_string());
    }
    order.extend(ids);
    Ok(order.into_iter().collect())
}

fn realtime_url(base: &str) -> anyhow::Result<String> {
    let mut url = parse_url(base)?;
    let host = url.host_str().unwrap_or_default().to_string();
    if url.scheme() == "https" {
        let _ = url.set_scheme("wss");
    } else if url.scheme() == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(&host.as_str())
    {
        let _ = url.set_scheme("ws");
    } else {
        anyhow::bail!("Managed Realtime requires HTTPS, or HTTP on loopback");
    }
    let path = format!("{}/realtime", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url.to_string())
}

/// Managed placeholders are scoped to Nexus paths, never direct provider hosts.
fn is_managed_credential(key: &str, env: &HashMap<String, String>) -> bool {
    MANAGED_PLACEHOLDER.is_match(key)
        || env.iter().any(|(name, value)| {
            name.starts_with("LENS_INFERENCE_") && CREDENTIAL_NAME.is_match(name) && value == key
        })
}

fn is_direct_base(base: Option<&str>) -> bool {
    let Some(base) = base.filter(|base| !base.is_empty()) else {
        return true;
    };
    match Url::parse(base) {
        Ok(url) => {
            url.origin().ascii_serialization() == "https://api.openai.com"
                && url.path().trim_end_matches('/') == "/v1"
        }
        Err(_) => false,
    }
}

/// Resolve voice independently of chat, keeping each endpoint and credential paired.
pub fn resolve_realtime_configuration(
    env: &HashMap<String, String>,
) -> anyhow::Result<RealtimeConfiguration> {
    if let Some(explicit_url) = set(env, "OPENAI_REALTIME_URL") {
        let api_key = set(env, "OPENAI_REALTIME_API_KEY").or_else(|| set(env, "OPENAI_API_KEY"));
        // An explicit URL does not widen a managed credential's scope. Require
        // the same protocol, host and route as its discovered endpoint/key pair.
        if let Some(key) = api_key.filter(|key| is_managed_credential(key, env)) {
            let target = parse_url(explicit_url)?;
            let mut matches_managed_endpoint = false;
            for surface in PROVIDERS.iter().flat_map(|(_, surfaces)| surfaces.iter()) {
                let Some(base) = set(env, surface.base_url_env) else {
                    continue;
                };
                if get(env, surface.api_key_env) != Some(key) {
                    continue;
                }
                let managed = parse_url(&realtime_url(base)?)?;
                if target.origin() == managed.origin()
                    && target.path() == managed.path()
                    && target.username().is_empty()
                    && target.password().is_none_or(str::is_empty)
                {
                    matches_managed_endpoint = true;
                    break;
                }
            }
            if !matches_managed_endpoint {
                return Ok(RealtimeConfiguration {
                    url: Some(explicit_url.to_string()),
                    api_key: None,
                    source: RealtimeSource::Explicit,
                    provider: None,
                    unavailable_reason: Some(MISMATCHED_MANAGED_CREDENTIAL.to_string()),
                });
            }
        }
        return Ok(RealtimeConfiguration {
            url: Some(explicit_url.to_string()),
            api_key: api_key.map(str::to_string),
            source: RealtimeSource::Explicit,
            provider: None,
            unavailable_reason: api_key.is_none().then(|| EXPLICIT_WITHOUT_KEY.to_string()),
        });
    }

    for provider in provider_order(env)? {
        let surfaces = PROVIDERS
            .iter()
            .find(|(name, _)| *name == provider)
            .map(|(_, surfaces)| *surfaces)
            .unwrap_or(&[]);
        for surface in surfaces {
            if surface.protocol != Protocol::OpenaiRealtime {
                continue;
            }
            let base = set(env, surface.base_url_env);
            let api_key = set(env, surface.api_key_env);
            if let (Some(base), Some(api_key)) = (base, api_key) {
                return Ok(RealtimeConfiguration {
                    url: Some(realtime_url(base)?),
                    api_key: Some(api_key.to_string()),
                    source: RealtimeSource::Managed,
                    provider: Some(provider.clone()),
                    unavailable_reason: None,
                });
            }
        }
    }

    // A dedicated voice key can serve direct OpenAI even when chat is managed.
    // Shared chat credentials are only eligible in a standalone direct setup.
    let managed = set(env, "LENS_MANAGED_INFERENCE_PROVIDER").is_some()
        || set(env, "LENS_MANAGED_INFERENCE_PROVIDERS").is_some()
        || env
            .iter()
            .any(|(name, value)| name.starts_with("LENS_INFERENCE_") && !value.is_empty());
    let api_key = set(env, "OPENAI_REALTIME_API_KEY").or_else(|| {
        if !managed && is_direct_base(get(env, "OPENAI_BASE_URL")) {
            set(env, "OPENAI_API_KEY")
        } else {
            None
        }
    });
    if let Some(api_key) = api_key.filter(|key| !is_managed_credential(key, env)) {
        return Ok(RealtimeConfiguration {
            url: None,
            api_key: Some(api_key.to_string()),
            source: RealtimeSource::Direct,
            provider: Some("openai".to_string()),
            unavailable_reason: None,
        });
    }
    Ok(RealtimeConfiguration {
        url: None,
        api_key: None,
        source: RealtimeSource::Unavailable,
        provider: None,
        unavailable_reason: Some(UNAVAILABLE.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AZURE_BASE: &str = "https://lens.example/prefix/v1/projects/p/llm/azure/openai/v1/";
    const AZURE_KEY: &str = "__lens_cred:nexus-llm-azure-openai__";
    const OPENAI_BASE: &str = "https://lens.example/v1/projects/p/llm/openai/v1";
    const OPENAI_KEY: &str = "__lens_cred:nexus-llm-openai__";

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn azure() -> Vec<(&'static str, String)> {
        vec![
            (
                "LENS_INFERENCE_AZURE_OPENAI_BASE_URL",
                AZURE_BASE.to_string(),
            ),
            ("LENS_INFERENCE_AZURE_OPENAI_API_KEY", AZURE_KEY.to_string()),
        ]
    }

    fn openai() -> Vec<(&'static str, String)> {
        vec![
            ("LENS_INFERENCE_OPENAI_BASE_URL", OPENAI_BASE.to_string()),
            ("LENS_INFERENCE_OPENAI_API_KEY", OPENAI_KEY.to_string()),
        ]
    }

    fn ordered(primary: &str, list: &[&str]) -> Vec<(&'static str, String)> {
        vec![
            ("LENS_MANAGED_INFERENCE_PROVIDER", primary.to_string()),
            (
                "LENS_MANAGED_INFERENCE_PROVIDERS",
                serde_json::to_string(list).unwrap(),
            ),
        ]
    }

    fn build(
        parts: Vec<Vec<(&'static str, String)>>,
        extra: &[(&str, &str)],
    ) -> HashMap<String, String> {
        let mut map: HashMap<String, String> = HashMap::new();
        for part in parts {
            for (k, v) in part {
                map.insert(k.to_string(), v);
            }
        }
        for (k, v) in extra {
            map.insert(k.to_string(), v.to_string());
        }
        map
    }

    fn resolve(env: &HashMap<String, String>) -> RealtimeConfiguration {
        resolve_realtime_configuration(env).unwrap()
    }

    #[test]
    fn selects_managed_voice_in_the_declared_order() {
        let cases: [(&str, &[&str], &str); 8] = [
            ("bedrock", &["bedrock", "azure"], "azure"),
            ("bedrock", &["bedrock", "openai"], "openai"),
            ("bedrock", &["bedrock", "azure", "openai"], "azure"),
            ("bedrock", &["bedrock", "openai", "azure"], "openai"),
            ("azure", &["openai", "azure"], "azure"),
            ("openai", &["azure", "openai"], "openai"),
            (
                "openrouter",
                &["openrouter", "bedrock-mantle", "azure"],
                "azure",
            ),
            ("future-provider", &["future-provider", "azure"], "azure"),
        ];
        for (primary, list, expected) in cases {
            let result = resolve(&build(vec![azure(), openai(), ordered(primary, list)], &[]));
            assert_eq!(result.source, RealtimeSource::Managed, "{primary} {list:?}");
            assert_eq!(result.provider.as_deref(), Some(expected));
            let (key, base) = if expected == "azure" {
                (AZURE_KEY, AZURE_BASE)
            } else {
                (OPENAI_KEY, OPENAI_BASE)
            };
            assert_eq!(result.api_key.as_deref(), Some(key));
            let url = format!(
                "{}/realtime",
                base.trim_end_matches('/').replacen("https:", "wss:", 1)
            );
            assert_eq!(result.url.as_deref(), Some(url.as_str()));
        }
    }

    #[test]
    fn uses_stable_legacy_discovery_and_skips_incomplete_pairs() {
        assert_eq!(
            resolve(&build(vec![azure(), openai()], &[]))
                .provider
                .as_deref(),
            Some("openai")
        );
        assert_eq!(
            resolve(&build(
                vec![azure(), openai()],
                &[("LENS_INFERENCE_OPENAI_API_KEY", "")]
            ))
            .provider
            .as_deref(),
            Some("azure")
        );
        assert_eq!(
            resolve(&build(vec![azure()], &[])).provider.as_deref(),
            Some("azure")
        );
    }

    #[test]
    fn does_not_select_stale_endpoints_outside_the_declared_provider_list() {
        let result = resolve(&build(
            vec![azure(), openai(), ordered("openrouter", &["openrouter"])],
            &[],
        ));
        assert_eq!(result.source, RealtimeSource::Unavailable);
    }

    #[test]
    fn does_not_infer_a_realtime_route_from_openrouter_chat_compatibility() {
        let result = resolve(&build(
            vec![ordered("openrouter", &["openrouter"])],
            &[
                (
                    "LENS_INFERENCE_OPENROUTER_BASE_URL",
                    "https://lens.example/v1/projects/p/llm/openrouter/openai/v1",
                ),
                ("LENS_INFERENCE_OPENROUTER_API_KEY", "router-key"),
                ("OPENAI_API_KEY", "router-key"),
            ],
        ));
        assert_eq!(result.source, RealtimeSource::Unavailable);
    }

    #[test]
    fn keeps_a_dedicated_direct_key_separate_from_the_selected_managed_credential() {
        let result = resolve(&build(
            vec![azure()],
            &[("OPENAI_REALTIME_API_KEY", "direct-key")],
        ));
        assert_eq!(result.api_key.as_deref(), Some(AZURE_KEY));
    }

    #[test]
    fn allows_direct_voice_with_a_dedicated_key_when_managed_chat_has_no_voice_candidate() {
        let result = resolve(&build(
            vec![ordered("bedrock", &["bedrock", "openrouter"])],
            &[("OPENAI_REALTIME_API_KEY", "direct-key")],
        ));
        assert_eq!(
            result,
            RealtimeConfiguration {
                url: None,
                api_key: Some("direct-key".into()),
                source: RealtimeSource::Direct,
                provider: Some("openai".into()),
                unavailable_reason: None,
            }
        );
    }

    #[test]
    fn preserves_standalone_direct_openai_credentials() {
        assert_eq!(
            resolve(&env(&[("OPENAI_API_KEY", "direct-key")])).source,
            RealtimeSource::Direct
        );
        assert_eq!(
            resolve(&env(&[
                ("OPENAI_API_KEY", "direct-key"),
                ("OPENAI_BASE_URL", "https://api.openai.com/v1/")
            ]))
            .source,
            RealtimeSource::Direct
        );
    }

    #[test]
    fn does_not_repurpose_a_custom_chat_credential_for_direct_voice() {
        let result = resolve(&env(&[
            ("OPENAI_BASE_URL", "https://chat.example/v1"),
            ("OPENAI_API_KEY", "chat-key"),
        ]));
        assert_eq!(result.source, RealtimeSource::Unavailable);
    }

    #[test]
    fn never_sends_a_managed_placeholder_to_direct_openai() {
        for key in [
            "__lens_cred:nexus-llm-openai__",
            "__nexus_cred:nexus-llm-azure-openai__",
        ] {
            assert_eq!(
                resolve(&env(&[("OPENAI_REALTIME_API_KEY", key)])).source,
                RealtimeSource::Unavailable
            );
        }
    }

    #[test]
    fn recognizes_a_managed_credential_by_its_namespaced_alias_even_with_an_opaque_id() {
        let result = resolve(&env(&[
            ("LENS_INFERENCE_OPENROUTER_API_KEY", "__lens_cred:opaque__"),
            ("OPENAI_REALTIME_API_KEY", "__lens_cred:opaque__"),
        ]));
        assert_eq!(result.source, RealtimeSource::Unavailable);
    }

    #[test]
    fn preserves_explicit_endpoint_and_key_overrides() {
        let result = resolve(&build(
            vec![azure()],
            &[
                ("OPENAI_REALTIME_URL", "wss://voice.example/realtime"),
                ("OPENAI_REALTIME_API_KEY", "voice-key"),
            ],
        ));
        assert_eq!(
            result,
            RealtimeConfiguration {
                url: Some("wss://voice.example/realtime".into()),
                api_key: Some("voice-key".into()),
                source: RealtimeSource::Explicit,
                provider: None,
                unavailable_reason: None,
            }
        );
    }

    #[test]
    fn rejects_a_managed_key_even_when_direct_openai_is_explicitly_selected() {
        let result = resolve(&build(
            vec![azure()],
            &[
                ("OPENAI_REALTIME_URL", "wss://api.openai.com/v1/realtime"),
                ("OPENAI_API_KEY", AZURE_KEY),
            ],
        ));
        assert_eq!(result.api_key, None);
    }

    #[test]
    fn rejects_a_managed_credential_for_an_unrelated_explicit_endpoint() {
        for url in [
            "wss://voice.example/realtime",
            "wss://lens.example/prefix/v1/projects/p/llm/openai/v1/realtime",
        ] {
            let result = resolve(&build(
                vec![azure()],
                &[("OPENAI_REALTIME_URL", url), ("OPENAI_API_KEY", AZURE_KEY)],
            ));
            assert_eq!(result.api_key, None, "{url}");
        }
    }

    #[test]
    fn preserves_an_explicit_managed_url_with_its_own_scoped_credential() {
        let result = resolve(&build(
            vec![azure()],
            &[
                (
                    "OPENAI_REALTIME_URL",
                    "wss://lens.example/prefix/v1/projects/p/llm/azure/openai/v1/realtime",
                ),
                ("OPENAI_API_KEY", AZURE_KEY),
            ],
        ));
        assert_eq!(result.source, RealtimeSource::Explicit);
        assert_eq!(result.api_key.as_deref(), Some(AZURE_KEY));
    }

    #[test]
    fn does_not_borrow_a_discovered_key_for_an_explicit_endpoint() {
        let result = resolve(&build(
            vec![azure()],
            &[("OPENAI_REALTIME_URL", "wss://voice.example/realtime")],
        ));
        assert_eq!(result.api_key, None);
    }

    #[test]
    fn reports_why_voice_is_unavailable_without_credentials() {
        let result = resolve(&HashMap::new());
        assert!(
            result
                .unavailable_reason
                .unwrap()
                .contains("OPENAI_REALTIME_API_KEY")
        );
    }

    #[test]
    fn accepts_managed_loopback_http_but_rejects_remote_plaintext() {
        let result = resolve(&build(
            vec![azure()],
            &[(
                "LENS_INFERENCE_AZURE_OPENAI_BASE_URL",
                "http://127.0.0.1:3103/v1",
            )],
        ));
        assert_eq!(
            result.url.as_deref(),
            Some("ws://127.0.0.1:3103/v1/realtime")
        );
        let err = resolve_realtime_configuration(&build(
            vec![azure()],
            &[(
                "LENS_INFERENCE_AZURE_OPENAI_BASE_URL",
                "http://voice.example/v1",
            )],
        ))
        .unwrap_err();
        assert!(err.to_string().contains("HTTPS"));
    }

    #[test]
    fn reports_an_invalid_provider_list() {
        for list in ["null", "{}", "[1]"] {
            let err =
                resolve_realtime_configuration(&env(&[("LENS_MANAGED_INFERENCE_PROVIDERS", list)]))
                    .unwrap_err();
            assert!(err.to_string().contains("JSON array"), "{list}");
        }
    }
}
