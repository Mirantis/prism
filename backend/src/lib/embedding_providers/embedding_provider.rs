//! The shape every embedding vendor factory returns.
//!
//! Embeddings are their own feature, decoupled from the chat provider: which vendor
//! embeds memory is selected by `CONFIG.embedding_provider`, not derived from
//! `LLM_PROVIDER`, because the two don't align — a chat vendor may serve no
//! embedding models at all, and a future embedding vendor (Voyage AI) may serve no
//! chat.

use std::sync::Arc;

use crate::ai::EmbeddingModel;
use crate::lib::llm_providers::llm_provider::ProviderOptionsFragment;

/// The vector width every vendor must emit — and the width of the sqlite-vec index
/// itself (`sqlite_bootstrap` builds its vec0 table from this same constant, so the
/// two cannot drift apart).
pub const EMBEDDING_DIMENSIONS: usize = 1024;

/// An embedding vendor: the model factory and the options every call sends.
#[derive(Clone)]
pub struct EmbeddingProvider {
    /// The embedding model `embed()`/`embed_many()` consume.
    pub model: Arc<dyn Fn(&str) -> Arc<dyn EmbeddingModel> + Send + Sync>,
    /// The `providerOptions` fragment to send with every embedding call. It holds
    /// the 1024-dim truncation target under the namespace the serving SDK reads
    /// (`bedrock` for Titan, `openai` for the text-embedding-3 models). A wrong
    /// namespace is silently ignored and yields wrong-dimension vectors, which is
    /// why the fragment lives on the provider rather than on the caller.
    pub provider_options: ProviderOptionsFragment,
}

impl EmbeddingProvider {
    /// `provider.model(modelId)`.
    pub fn model(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        (self.model)(model_id)
    }
}
