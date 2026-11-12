//! Unified embedding provider factory — the embedding counterpart of
//! `llm_providers/create_provider.rs`, and deliberately separate from it: which
//! vendor embeds memory (`CONFIG.embedding_provider`) is decoupled from which
//! vendor chats (`CONFIG.llm_provider`).
//!
//! Each case keys off its *own* endpoint rather than the chat vendor's, so
//! embedding routing survives independently of chat routing — bedrock-mantle chats
//! on its own mount while Titan embeds over `nexus_llm_base_url`, and a chat vendor
//! with no gateway mount at all can still embed through the gateway.
//! `OPENAI_BASE_URL` and `OPENROUTER_BASE_URL` are each one endpoint for a whole
//! vendor surface, so the openai and openrouter legs follow the override their chat
//! leg follows.
//!
//! Returns `None` for `none` — the explicit "no embeddings". Config resolves the
//! embedding model id to '' in that case, so the embedding service's skip guard
//! fires before this factory is ever called.

use crate::config::{CONFIG, Config, EmbeddingProviderName};
use crate::lib::embedding_providers::azure_openai_embedding_provider::create_azure_open_ai_embedding_provider;
use crate::lib::embedding_providers::bedrock_embedding_provider::create_bedrock_embedding_provider;
use crate::lib::embedding_providers::embedding_provider::EmbeddingProvider;
use crate::lib::embedding_providers::openai_embedding_provider::create_open_ai_embedding_provider;
use crate::lib::embedding_providers::openrouter_embedding_provider::create_open_router_embedding_provider;

pub fn create_embedding_provider() -> Option<EmbeddingProvider> {
    let (vendor, base_url) = route(&CONFIG)?;
    Some(match vendor {
        EmbeddingProviderName::AzureOpenai => {
            create_azure_open_ai_embedding_provider(base_url.as_deref())
        }
        EmbeddingProviderName::Openai => create_open_ai_embedding_provider(base_url.as_deref()),
        EmbeddingProviderName::Openrouter => {
            create_open_router_embedding_provider(base_url.as_deref().unwrap_or_default())
        }
        EmbeddingProviderName::Bedrock | EmbeddingProviderName::None => {
            create_bedrock_embedding_provider(base_url.as_deref())
        }
    })
}

/// The vendor that embeds and the endpoint its factory receives; `None` for `none`.
fn route(config: &Config) -> Option<(EmbeddingProviderName, Option<String>)> {
    let base_url = match config.embedding_provider {
        EmbeddingProviderName::None => return None,
        EmbeddingProviderName::AzureOpenai => config.nexus_azure_open_ai_base_url.clone(),
        EmbeddingProviderName::Openai => config.openai_endpoint.clone(),
        EmbeddingProviderName::Openrouter => Some(config.openrouter_endpoint.clone()),
        EmbeddingProviderName::Bedrock => config.nexus_llm_base_url.clone(),
    };
    Some((config.embedding_provider, base_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route_for(pairs: &[(&str, &str)]) -> Option<(EmbeddingProviderName, Option<String>)> {
        let env = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        route(&Config::load(&env, &mut |_, _| {}).unwrap())
    }

    fn some(
        vendor: EmbeddingProviderName,
        url: Option<&str>,
    ) -> Option<(EmbeddingProviderName, Option<String>)> {
        Some((vendor, url.map(str::to_string)))
    }

    const NEXUS: (&str, &str) = ("NEXUS_API_URL", "https://nexus.example");

    #[test]
    fn bedrock_goes_direct_without_a_gateway_and_over_the_bedrock_mount_with_one() {
        let bedrock = ("EMBEDDING_PROVIDER", "bedrock");
        assert_eq!(
            route_for(&[bedrock]),
            some(EmbeddingProviderName::Bedrock, None)
        );
        assert_eq!(
            route_for(&[bedrock, NEXUS, ("AWS_REGION", "us-east-1")]),
            some(
                EmbeddingProviderName::Bedrock,
                Some("https://nexus.example/llm/bedrock/us-east-1")
            )
        );
    }

    #[test]
    fn azure_openai_rides_its_own_gateway_mount() {
        let azure = ("EMBEDDING_PROVIDER", "azure-openai");
        assert_eq!(
            route_for(&[azure]),
            some(EmbeddingProviderName::AzureOpenai, None)
        );
        assert_eq!(
            route_for(&[azure, NEXUS]),
            some(
                EmbeddingProviderName::AzureOpenai,
                Some("https://nexus.example/llm/azure/openai/v1")
            )
        );
    }

    #[test]
    fn openai_follows_the_endpoint_its_chat_leg_follows() {
        let openai = ("EMBEDDING_PROVIDER", "openai");
        assert_eq!(
            route_for(&[openai]),
            some(EmbeddingProviderName::Openai, None)
        );
        assert_eq!(
            route_for(&[openai, NEXUS]),
            some(
                EmbeddingProviderName::Openai,
                Some("https://nexus.example/llm/openai/v1")
            )
        );
        // An OPENAI_BASE_URL override reaches the factory, mount set or not.
        assert_eq!(
            route_for(&[
                openai,
                NEXUS,
                ("OPENAI_BASE_URL", "https://openai.example/v1")
            ]),
            some(
                EmbeddingProviderName::Openai,
                Some("https://openai.example/v1")
            )
        );
    }

    #[test]
    fn openrouter_defaults_to_openrouter_ai_not_the_sdk_default() {
        let openrouter = ("EMBEDDING_PROVIDER", "openrouter");
        assert_eq!(
            route_for(&[openrouter]),
            some(
                EmbeddingProviderName::Openrouter,
                Some("https://openrouter.ai/api/v1")
            )
        );
        assert_eq!(
            route_for(&[
                openrouter,
                ("OPENROUTER_BASE_URL", "https://proxy.example/openrouter/v1")
            ]),
            some(
                EmbeddingProviderName::Openrouter,
                Some("https://proxy.example/openrouter/v1")
            )
        );
    }

    #[test]
    fn none_selects_no_factory() {
        assert_eq!(route_for(&[("EMBEDDING_PROVIDER", "none")]), None);
    }
}
