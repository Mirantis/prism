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

use crate::config::{CONFIG, EmbeddingProviderName};
use crate::lib::embedding_providers::azure_openai_embedding_provider::create_azure_open_ai_embedding_provider;
use crate::lib::embedding_providers::bedrock_embedding_provider::create_bedrock_embedding_provider;
use crate::lib::embedding_providers::embedding_provider::EmbeddingProvider;
use crate::lib::embedding_providers::openai_embedding_provider::create_open_ai_embedding_provider;
use crate::lib::embedding_providers::openrouter_embedding_provider::create_open_router_embedding_provider;

pub fn create_embedding_provider() -> Option<EmbeddingProvider> {
    match CONFIG.embedding_provider {
        EmbeddingProviderName::None => None,
        EmbeddingProviderName::AzureOpenai => Some(create_azure_open_ai_embedding_provider(
            CONFIG.nexus_azure_open_ai_base_url.as_deref(),
        )),
        EmbeddingProviderName::Openai => Some(create_open_ai_embedding_provider(
            CONFIG.openai_endpoint.as_deref(),
        )),
        EmbeddingProviderName::Openrouter => Some(create_open_router_embedding_provider(
            &CONFIG.openrouter_endpoint,
        )),
        EmbeddingProviderName::Bedrock => Some(create_bedrock_embedding_provider(
            CONFIG.nexus_llm_base_url.as_deref(),
        )),
    }
}
