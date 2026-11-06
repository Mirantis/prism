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

use crate::services::memory_manager_service::MemorySearchResult;
use crate::services::memory_store::SearchOptions;

pub struct EmbeddingService;

impl EmbeddingService {
    pub fn new() -> Self {
        EmbeddingService
    }

    /// Generate an embedding vector for the given text. `None` when no embedding
    /// model is configured or the call fails; both are logged as warnings.
    pub async fn generate_embedding(&self, agent_id: &str, text: &str) -> Option<Vec<f64>> {
        todo!()
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
        todo!()
    }

    /// Persist an embedding for a memory entry (provider-aware).
    pub async fn store_embedding(&self, entry_id: &str, embedding: &[f64]) -> anyhow::Result<()> {
        todo!()
    }

    /// Generate embedding and store it for a memory entry.
    pub async fn generate_and_store_embedding(
        &self,
        agent_id: &str,
        entry_id: &str,
        content: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Cosine-similarity search over memory embeddings (provider-aware).
    pub async fn search_by_embedding(
        &self,
        agent_id: &str,
        query_embedding: &[f64],
        options: &SearchOptions,
    ) -> anyhow::Result<Vec<MemorySearchResult>> {
        todo!()
    }
}

impl Default for EmbeddingService {
    fn default() -> Self {
        Self::new()
    }
}

pub static EMBEDDING_SERVICE: LazyLock<EmbeddingService> = LazyLock::new(EmbeddingService::new);
