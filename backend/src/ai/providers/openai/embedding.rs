//! The embeddings model (`OpenAIEmbeddingModel`), which the Azure provider uses too.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::api::{
    combine_headers, invalid_json_response, openai_failed_response_error, parse_json_body,
    post_json,
};
use super::responses::OpenAIConfig;
use super::responses_options::parse_provider_options;
use crate::ai::errors::TooManyEmbeddingValuesForCallError;
use crate::ai::json::normalize_numbers;
use crate::ai::model::EmbeddingModel;
use crate::ai::provider::{
    EmbeddingModelUsage, EmbeddingModelV4CallOptions, EmbeddingModelV4Response,
    EmbeddingModelV4Result,
};

pub const MAX_EMBEDDINGS_PER_CALL: usize = 2048;

/// The `openai` provider options of an embedding call.
#[derive(Debug, Clone, Default, Deserialize)]
struct OpenAIEmbeddingOptions {
    #[serde(default)]
    dimensions: Option<serde_json::Number>,
    #[serde(default)]
    user: Option<String>,
}

pub struct OpenAIEmbeddingModel {
    model_id: String,
    config: OpenAIConfig,
}

impl OpenAIEmbeddingModel {
    pub fn new(model_id: &str, config: OpenAIConfig) -> Self {
        Self {
            model_id: model_id.to_string(),
            config,
        }
    }
}

/// The response as `openaiTextEmbeddingResponseSchema` reads it: the vectors, and
/// the prompt tokens when the response counts them.
fn parse_embeddings(raw: &Value) -> anyhow::Result<(Vec<Vec<f64>>, Option<f64>)> {
    let invalid = |message: &str| anyhow::anyhow!("{message}");
    let data = raw
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("invalid data"))?;
    let mut embeddings = Vec::with_capacity(data.len());
    for item in data {
        let vector = item
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("invalid embedding"))?;
        let numbers: Option<Vec<f64>> = vector.iter().map(Value::as_f64).collect();
        embeddings.push(numbers.ok_or_else(|| invalid("invalid embedding value"))?);
    }
    let tokens = match raw.get("usage") {
        None | Some(Value::Null) => None,
        Some(usage) => Some(
            usage
                .get("prompt_tokens")
                .and_then(Value::as_f64)
                .ok_or_else(|| invalid("invalid usage"))?,
        ),
    };
    Ok((embeddings, tokens))
}

#[async_trait]
impl EmbeddingModel for OpenAIEmbeddingModel {
    fn provider(&self) -> &str {
        &self.config.provider
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn max_embeddings_per_call(&self) -> Option<usize> {
        Some(MAX_EMBEDDINGS_PER_CALL)
    }

    fn supports_parallel_calls(&self) -> bool {
        true
    }

    async fn do_embed(
        &self,
        options: EmbeddingModelV4CallOptions,
    ) -> anyhow::Result<EmbeddingModelV4Result> {
        if options.values.len() > MAX_EMBEDDINGS_PER_CALL {
            return Err(TooManyEmbeddingValuesForCallError::new(
                &self.config.provider,
                &self.model_id,
                MAX_EMBEDDINGS_PER_CALL,
                options.values.len(),
            )
            .into());
        }

        let openai_options: OpenAIEmbeddingOptions =
            parse_provider_options("openai", options.provider_options.as_ref())?
                .unwrap_or_default();

        let url = (self.config.url)("/embeddings", &self.model_id)?;
        let provider_headers = (self.config.headers)()?;
        let headers = combine_headers(&[Some(&provider_headers), options.headers.as_ref()]);

        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(self.model_id.clone()));
        body.insert(
            "input".to_string(),
            Value::Array(options.values.iter().cloned().map(Value::String).collect()),
        );
        body.insert(
            "encoding_format".to_string(),
            Value::String("float".to_string()),
        );
        let dimensions = openai_options
            .dimensions
            .map(Value::Number)
            .or_else(|| options.dimensions.map(Value::from));
        if let Some(dimensions) = dimensions {
            body.insert("dimensions".to_string(), dimensions);
        }
        if let Some(user) = openai_options.user {
            body.insert("user".to_string(), Value::String(user));
        }
        let body = normalize_numbers(Value::Object(body));

        let response = post_json(
            &url,
            &headers,
            &body,
            options.abort_signal.as_ref(),
            &self.config.fetch,
            self.config.provider_utils_version,
        )
        .await?;
        if !response.ok() {
            return Err(openai_failed_response_error(&response, &url, &body));
        }
        let raw = parse_json_body(&response, &url, &body)?;
        let (embeddings, tokens) = parse_embeddings(&raw)
            .map_err(|cause| invalid_json_response(&response, &url, &body, cause))?;

        Ok(EmbeddingModelV4Result {
            embeddings,
            usage: tokens.map(|tokens| EmbeddingModelUsage { tokens }),
            provider_metadata: None,
            response: Some(EmbeddingModelV4Response {
                headers: Some(response.headers.clone()),
                body: Some(raw),
            }),
            warnings: Vec::new(),
        })
    }
}
