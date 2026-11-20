//! Embeddings over InvokeModel (`AmazonBedrockEmbeddingModel`): Titan, Cohere and
//! Nova bodies, chosen by the model id.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::api::{
    FetchFunction, combine_headers, encode_uri_component, failed_response_error,
    parse_json_response, post_json,
};
use crate::ai::errors::{InvalidArgumentError, TooManyEmbeddingValuesForCallError};
use crate::ai::model::EmbeddingModel;
use crate::ai::provider::{
    EmbeddingModelUsage, EmbeddingModelV4CallOptions, EmbeddingModelV4Result, Headers,
    ProviderOptions,
};

/// What an embedding model needs from its provider.
pub struct EmbeddingConfig {
    pub base_url: Arc<dyn Fn() -> anyhow::Result<String> + Send + Sync>,
    pub headers: Arc<dyn Fn() -> Headers + Send + Sync>,
    pub fetch: FetchFunction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelFamily {
    Titan,
    Cohere,
    Nova,
}

/// `detectEmbeddingModelFamily`; `includes` so inference profile ids match too.
fn detect_family(model_id: &str) -> ModelFamily {
    if model_id.contains("amazon.nova-") && model_id.contains("embed") {
        ModelFamily::Nova
    } else if model_id.contains("cohere.embed-") {
        ModelFamily::Cohere
    } else {
        ModelFamily::Titan
    }
}

/// An embedding model on bedrock-runtime (`amazon-bedrock`).
pub struct AmazonBedrockEmbeddingModel {
    model_id: String,
    config: Arc<EmbeddingConfig>,
}

impl AmazonBedrockEmbeddingModel {
    pub fn new(model_id: &str, config: Arc<EmbeddingConfig>) -> Self {
        Self {
            model_id: model_id.to_string(),
            config,
        }
    }

    fn family(&self) -> ModelFamily {
        detect_family(&self.model_id)
    }
}

/// `amazonBedrockEmbeddingModelOptionsSchema`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingOptions {
    dimensions: Option<i64>,
    normalize: Option<bool>,
    embedding_dimension: Option<i64>,
    embedding_purpose: Option<String>,
    input_type: Option<String>,
    truncate: Option<String>,
    output_dimension: Option<i64>,
}

impl EmbeddingOptions {
    fn is_valid(&self) -> bool {
        let one_of =
            |value: Option<i64>, allowed: &[i64]| value.is_none_or(|v| allowed.contains(&v));
        let one_of_text = |value: &Option<String>, allowed: &[&str]| {
            value.as_deref().is_none_or(|v| allowed.contains(&v))
        };
        one_of(self.dimensions, &[1024, 512, 256])
            && one_of(self.embedding_dimension, &[256, 384, 1024, 3072])
            && one_of(self.output_dimension, &[256, 512, 1024, 1536])
            && one_of_text(
                &self.embedding_purpose,
                &[
                    "GENERIC_INDEX",
                    "TEXT_RETRIEVAL",
                    "IMAGE_RETRIEVAL",
                    "VIDEO_RETRIEVAL",
                    "DOCUMENT_RETRIEVAL",
                    "AUDIO_RETRIEVAL",
                    "GENERIC_RETRIEVAL",
                    "CLASSIFICATION",
                    "CLUSTERING",
                ],
            )
            && one_of_text(
                &self.input_type,
                &[
                    "search_document",
                    "search_query",
                    "classification",
                    "clustering",
                ],
            )
            && one_of_text(&self.truncate, &["NONE", "START", "END"])
    }
}

/// The `amazonBedrock` options, else the `bedrock` ones.
fn parse_options(provider_options: Option<&ProviderOptions>) -> anyhow::Result<EmbeddingOptions> {
    for provider in ["amazonBedrock", "bedrock"] {
        let Some(value) = provider_options
            .and_then(|o| o.get(provider))
            .filter(|v| !v.is_null())
        else {
            continue;
        };
        let parsed = value
            .is_object()
            .then(|| serde_json::from_value::<EmbeddingOptions>(value.clone()).ok())
            .flatten()
            .filter(EmbeddingOptions::is_valid);
        return parsed.ok_or_else(|| {
            InvalidArgumentError {
                message: format!("invalid {provider} provider options"),
                parameter: "providerOptions".to_string(),
                value: Value::Null,
            }
            .into()
        });
    }
    Ok(EmbeddingOptions::default())
}

#[async_trait]
impl EmbeddingModel for AmazonBedrockEmbeddingModel {
    fn provider(&self) -> &str {
        "amazon-bedrock"
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn max_embeddings_per_call(&self) -> Option<usize> {
        Some(if self.family() == ModelFamily::Cohere {
            96
        } else {
            1
        })
    }

    fn supports_parallel_calls(&self) -> bool {
        true
    }

    async fn do_embed(
        &self,
        options: EmbeddingModelV4CallOptions,
    ) -> anyhow::Result<EmbeddingModelV4Result> {
        let max = self.max_embeddings_per_call().unwrap_or(1);
        if options.values.len() > max {
            return Err(TooManyEmbeddingValuesForCallError::new(
                self.provider(),
                &self.model_id,
                max,
                options.values.len(),
            )
            .into());
        }
        let bedrock = parse_options(options.provider_options.as_ref())?;
        let first = options.values.first().cloned();

        let mut args = Map::new();
        match self.family() {
            ModelFamily::Nova => {
                args.insert("taskType".into(), json!("SINGLE_EMBEDDING"));
                args.insert(
                    "singleEmbeddingParams".into(),
                    json!({
                        "embeddingPurpose": bedrock.embedding_purpose.as_deref().unwrap_or("GENERIC_INDEX"),
                        "embeddingDimension": bedrock.embedding_dimension.or(options.dimensions).unwrap_or(1024),
                        "text": {
                            "truncationMode": bedrock.truncate.as_deref().unwrap_or("END"),
                            "value": first,
                        },
                    }),
                );
            }
            ModelFamily::Cohere => {
                args.insert(
                    "input_type".into(),
                    json!(bedrock.input_type.as_deref().unwrap_or("search_query")),
                );
                args.insert("texts".into(), json!(options.values));
                if let Some(truncate) = &bedrock.truncate {
                    args.insert("truncate".into(), json!(truncate));
                }
                if let Some(dimension) = bedrock.output_dimension.or(options.dimensions) {
                    args.insert("output_dimension".into(), json!(dimension));
                }
            }
            ModelFamily::Titan => {
                if let Some(text) = &first {
                    args.insert("inputText".into(), json!(text));
                }
                if let Some(dimensions) = bedrock.dimensions.or(options.dimensions) {
                    args.insert("dimensions".into(), json!(dimensions));
                }
                if let Some(normalize) = bedrock.normalize {
                    args.insert("normalize".into(), json!(normalize));
                }
            }
        }
        let body = Value::Object(args);

        let url = format!(
            "{}/model/{}/invoke",
            (self.config.base_url)()?,
            encode_uri_component(&self.model_id)
        );
        let config_headers = (self.config.headers)();
        let headers = combine_headers(&[Some(&config_headers), options.headers.as_ref()]);
        let response = post_json(
            &url,
            &headers,
            &body,
            options.abort_signal.as_ref(),
            &self.config.fetch,
        )
        .await?;
        if !response.ok() {
            return Err(failed_response_error(
                &response,
                &url,
                &body,
                |error| match &error.error_type {
                    None => error.message.clone(),
                    Some(error_type) => format!("{error_type}: {}", error.message),
                },
            ));
        }
        let (parsed, _): (EmbeddingResponse, Value) = parse_json_response(&response, &url, &body)?;

        let header_tokens = response
            .headers
            .get("x-amzn-bedrock-input-token-count")
            .and_then(|v| crate::support::js::number_from(v))
            .unwrap_or(f64::NAN);
        let (embeddings, tokens) = match parsed {
            EmbeddingResponse::Titan {
                embedding,
                input_text_token_count,
            } => (vec![embedding], input_text_token_count),
            EmbeddingResponse::Nova {
                embeddings,
                input_token_count,
            } => {
                let tokens = input_token_count.unwrap_or(header_tokens);
                match embeddings.into_iter().next() {
                    Some(first) => (vec![first.embedding], tokens),
                    None => (Vec::new(), tokens),
                }
            }
            EmbeddingResponse::CohereV3 { embeddings } => (embeddings, header_tokens),
            EmbeddingResponse::CohereV4 { embeddings } => (embeddings.float, header_tokens),
        };

        Ok(EmbeddingModelV4Result {
            embeddings,
            usage: Some(EmbeddingModelUsage { tokens }),
            provider_metadata: None,
            response: None,
            warnings: Vec::new(),
        })
    }
}

/// The four response shapes the SDK accepts.
#[derive(Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
enum EmbeddingResponse {
    Titan {
        embedding: Vec<f64>,
        #[serde(rename = "inputTextTokenCount")]
        input_text_token_count: f64,
    },
    Nova {
        embeddings: Vec<NovaEmbedding>,
        #[serde(default, rename = "inputTokenCount")]
        input_token_count: Option<f64>,
    },
    CohereV3 {
        embeddings: Vec<Vec<f64>>,
    },
    CohereV4 {
        embeddings: CohereFloats,
    },
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct NovaEmbedding {
    #[serde(rename = "embeddingType")]
    embedding_type: String,
    embedding: Vec<f64>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct CohereFloats {
    float: Vec<Vec<f64>>,
}
