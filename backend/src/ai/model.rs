//! The model interfaces a provider implements, and middleware around them.

use std::sync::Arc;

use async_trait::async_trait;

use super::provider::{
    EmbeddingModelV4CallOptions, EmbeddingModelV4Result, LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult, SupportedUrls,
};

/// A language model (`LanguageModelV4`), held as `Arc<dyn LanguageModel>`.
#[async_trait]
pub trait LanguageModel: Send + Sync {
    /// The provider's id, such as `amazon-bedrock` or `anthropic.messages`.
    fn provider(&self) -> &str;

    /// The model's id as the provider names it.
    fn model_id(&self) -> &str;

    /// The URLs the model reads itself, by media type. A file at any other URL is
    /// downloaded and sent inline.
    fn supported_urls(&self) -> SupportedUrls {
        SupportedUrls::new()
    }

    /// One call to the model.
    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult>;
}

/// An embedding model (`EmbeddingModelV4`), held as `Arc<dyn EmbeddingModel>`.
#[async_trait]
pub trait EmbeddingModel: Send + Sync {
    fn provider(&self) -> &str;

    fn model_id(&self) -> &str;

    /// The most values one call may embed; `None` for no limit.
    fn max_embeddings_per_call(&self) -> Option<usize> {
        None
    }

    /// Whether several calls may run at once.
    fn supports_parallel_calls(&self) -> bool {
        true
    }

    /// One call to the model.
    async fn do_embed(
        &self,
        options: EmbeddingModelV4CallOptions,
    ) -> anyhow::Result<EmbeddingModelV4Result>;
}

/// Middleware around a language model (`LanguageModelMiddleware`).
#[async_trait]
pub trait LanguageModelMiddleware: Send + Sync {
    /// Rewrites the call options before the model sees them.
    async fn transform_params(
        &self,
        params: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4CallOptions> {
        Ok(params)
    }

    /// Wraps the call. `model.do_generate(params)` is the call itself.
    async fn wrap_generate(
        &self,
        params: LanguageModelV4CallOptions,
        model: &Arc<dyn LanguageModel>,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        model.do_generate(params).await
    }

    /// A provider id that replaces the model's.
    fn override_provider(&self, _model: &Arc<dyn LanguageModel>) -> Option<String> {
        None
    }

    /// A model id that replaces the model's.
    fn override_model_id(&self, _model: &Arc<dyn LanguageModel>) -> Option<String> {
        None
    }
}

struct WrappedLanguageModel {
    model: Arc<dyn LanguageModel>,
    middleware: Arc<dyn LanguageModelMiddleware>,
    provider: String,
    model_id: String,
}

#[async_trait]
impl LanguageModel for WrappedLanguageModel {
    fn provider(&self) -> &str {
        &self.provider
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn supported_urls(&self) -> SupportedUrls {
        self.model.supported_urls()
    }

    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        let params = self.middleware.transform_params(options).await?;
        self.middleware.wrap_generate(params, &self.model).await
    }
}

/// The options of `wrap_language_model`.
pub struct WrapLanguageModelOptions {
    pub model: Arc<dyn LanguageModel>,
    pub middleware: Arc<dyn LanguageModelMiddleware>,
}

/// `wrapLanguageModel`: the model with the middleware around it. The wrapped model
/// keeps the model's provider and id unless the middleware overrides them.
pub fn wrap_language_model(options: WrapLanguageModelOptions) -> Arc<dyn LanguageModel> {
    let WrapLanguageModelOptions { model, middleware } = options;
    let provider = middleware
        .override_provider(&model)
        .unwrap_or_else(|| model.provider().to_string());
    let model_id = middleware
        .override_model_id(&model)
        .unwrap_or_else(|| model.model_id().to_string());
    Arc::new(WrappedLanguageModel {
        model,
        middleware,
        provider,
        model_id,
    })
}
