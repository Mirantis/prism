//! Embedding Service
//!
//! Handles vector embedding generation for memory entries. Storage and
//! search are delegated to `MEMORY_EMBEDDING_STORE` (sqlite-vec backed).
//! The embedding model comes from the embedding provider
//! (`lib/embedding_providers/`), selected by `EMBEDDING_PROVIDER` independently
//! of the chat vendor. The model is optional — when unset (or the provider is
//! `none`), embedding generation fail-opens (returns `None`) and memory search
//! is effectively disabled.

use std::sync::LazyLock;

use serde_json::json;

use crate::ai::{EmbedManyOptions, EmbedOptions, embed, embed_many};
use crate::config::CONFIG;
use crate::lib::embedding_providers::create_embedding_provider::create_embedding_provider;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::langfuse_embed_telemetry;
use crate::log_warn;
use crate::services::memory_manager_service::MemorySearchResult;
use crate::services::memory_store::{MEMORY_EMBEDDING_STORE, SearchOptions};

pub struct EmbeddingService;

impl EmbeddingService {
    pub fn new() -> Self {
        EmbeddingService
    }

    /// Generate an embedding vector for the given text. `None` when no embedding
    /// model is configured or the call fails; both are logged as warnings.
    pub async fn generate_embedding(&self, agent_id: &str, text: &str) -> Option<Vec<f64>> {
        if CONFIG.embedding_model_id.is_empty() {
            // No embedding model configured (EMBEDDING_PROVIDER=none, or the active
            // vendor's embedding var set to '') — skip the SDK call entirely instead
            // of failing on a '' model name.
            log_warn!(
                json!({ "agentId": agent_id }),
                "No embedding model configured; skipping embedding generation"
            );
            return None;
        }
        // The provider is built inside the fallible part so a factory that ever
        // starts validating eagerly still fail-opens.
        let Some(provider) = create_embedding_provider() else {
            // Unreachable via config — `none` resolves the model id to '' and the
            // guard above fires first — kept so the `None` contract holds if that
            // coupling ever loosens.
            log_warn!(
                json!({ "agentId": agent_id }),
                "No embedding provider configured; skipping embedding generation"
            );
            return None;
        };
        let mut options = EmbedOptions::new(provider.model(&CONFIG.embedding_model_id), text);
        options.provider_options = Some(provider.provider_options.clone());
        options.telemetry = langfuse_embed_telemetry("memory-embedding").experimental_telemetry;
        match embed(options).await {
            Ok(result) => Some(result.embedding),
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err), "agentId": agent_id }),
                    "Failed to generate embedding"
                );
                None
            }
        }
    }

    /// Generate embeddings for a batch of texts. An empty batch is `Some(vec![])`;
    /// `None` when no embedding model is configured or the call fails. Requests
    /// are serialized (`max_parallel_calls: 1`) so a large backfill does not trip
    /// per-account rate limits.
    pub async fn generate_embeddings(
        &self,
        agent_id: &str,
        texts: &[String],
    ) -> Option<Vec<Vec<f64>>> {
        if texts.is_empty() {
            return Some(Vec::new());
        }
        if CONFIG.embedding_model_id.is_empty() {
            log_warn!(
                json!({ "agentId": agent_id }),
                "No embedding model configured; skipping embedding backfill"
            );
            return None;
        }

        let Some(provider) = create_embedding_provider() else {
            log_warn!(
                json!({ "agentId": agent_id }),
                "No embedding provider configured; skipping embedding backfill"
            );
            return None;
        };
        let mut options =
            EmbedManyOptions::new(provider.model(&CONFIG.embedding_model_id), texts.to_vec());
        // Serialize requests: embed_many may otherwise split a large `values`
        // batch and dispatch in parallel, which trips per-account rate limits
        // during heavy backfills (Titan v2 on Bedrock; Azure OpenAI throttles
        // per-deployment the same way). Caller-side BATCH_SIZE keeps the
        // per-call payload small; this guards the rare case where the SDK
        // still parallelizes.
        options.max_parallel_calls = Some(1);
        options.provider_options = Some(provider.provider_options.clone());
        options.telemetry =
            langfuse_embed_telemetry("memory-embedding-backfill").experimental_telemetry;
        match embed_many(options).await {
            Ok(result) => Some(result.embeddings),
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err), "agentId": agent_id }),
                    "Failed to generate embeddings"
                );
                None
            }
        }
    }

    /// Persist an embedding for a memory entry (provider-aware).
    pub async fn store_embedding(&self, entry_id: &str, embedding: &[f64]) -> anyhow::Result<()> {
        MEMORY_EMBEDDING_STORE
            .store_embedding(entry_id, embedding)
            .await
    }

    /// Generate embedding and store it for a memory entry.
    pub async fn generate_and_store_embedding(
        &self,
        agent_id: &str,
        entry_id: &str,
        content: &str,
    ) -> anyhow::Result<()> {
        if let Some(embedding) = self.generate_embedding(agent_id, content).await {
            self.store_embedding(entry_id, &embedding).await?;
        }
        Ok(())
    }

    /// Cosine-similarity search over memory embeddings (provider-aware).
    pub async fn search_by_embedding(
        &self,
        agent_id: &str,
        query_embedding: &[f64],
        options: &SearchOptions,
    ) -> anyhow::Result<Vec<MemorySearchResult>> {
        MEMORY_EMBEDDING_STORE
            .search_by_embedding(agent_id, query_embedding, options)
            .await
    }
}

impl Default for EmbeddingService {
    fn default() -> Self {
        Self::new()
    }
}

pub static EMBEDDING_SERVICE: LazyLock<EmbeddingService> = LazyLock::new(EmbeddingService::new);
