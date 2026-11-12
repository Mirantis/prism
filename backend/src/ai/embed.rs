//! `embed` and `embedMany`: embedding vectors for text.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::VERSION;
use super::errors::{InvalidArgumentError, InvalidResponseDataError, ensure_log_fields_registered};
use super::generate_text::{create_id, with_user_agent_suffix};
use super::model::EmbeddingModel;
use super::provider::{
    EmbeddingModelUsage, EmbeddingModelV4CallOptions, EmbeddingModelV4Response, Headers,
    JsonObject, ProviderMetadata, ProviderOptions, Warning,
};
use super::retry::prepare_retries;
use super::telemetry::{
    EmbedEndEvent, EmbedStartEvent, EmbeddingModelCallEndEvent, EmbeddingModelCallStartEvent,
    OperationEndEvent, OperationStartEvent, TelemetryDispatcher, TelemetryOptions,
};
use super::warnings::log_warnings;

/// An embedding vector.
pub type Embedding = Vec<f64>;

/// The options of `embed`.
#[derive(Clone)]
pub struct EmbedOptions {
    pub model: Arc<dyn EmbeddingModel>,
    pub value: String,
    pub dimensions: Option<i64>,
    pub max_retries: Option<i64>,
    pub abort_signal: Option<CancellationToken>,
    pub headers: Option<Headers>,
    pub provider_options: Option<ProviderOptions>,
    pub telemetry: Option<TelemetryOptions>,
    pub runtime_context: JsonObject,
}

impl EmbedOptions {
    pub fn new(model: Arc<dyn EmbeddingModel>, value: impl Into<String>) -> Self {
        Self {
            model,
            value: value.into(),
            dimensions: None,
            max_retries: None,
            abort_signal: None,
            headers: None,
            provider_options: None,
            telemetry: None,
            runtime_context: JsonObject::new(),
        }
    }
}

/// The result of `embed`.
#[derive(Debug, Clone)]
pub struct EmbedResult {
    pub value: String,
    pub embedding: Embedding,
    pub usage: EmbeddingModelUsage,
    pub warnings: Vec<Warning>,
    pub provider_metadata: Option<ProviderMetadata>,
    pub response: Option<EmbeddingModelV4Response>,
}

/// The options of `embed_many`.
#[derive(Clone)]
pub struct EmbedManyOptions {
    pub model: Arc<dyn EmbeddingModel>,
    pub values: Vec<String>,
    pub dimensions: Option<i64>,
    pub max_retries: Option<i64>,
    pub abort_signal: Option<CancellationToken>,
    pub headers: Option<Headers>,
    pub provider_options: Option<ProviderOptions>,
    pub telemetry: Option<TelemetryOptions>,
    pub runtime_context: JsonObject,
    /// How many provider calls may run at once; unlimited when `None`.
    pub max_parallel_calls: Option<usize>,
}

impl EmbedManyOptions {
    pub fn new(model: Arc<dyn EmbeddingModel>, values: Vec<String>) -> Self {
        Self {
            model,
            values,
            dimensions: None,
            max_retries: None,
            abort_signal: None,
            headers: None,
            provider_options: None,
            telemetry: None,
            runtime_context: JsonObject::new(),
            max_parallel_calls: None,
        }
    }
}

/// The result of `embed_many`.
#[derive(Debug, Clone)]
pub struct EmbedManyResult {
    pub values: Vec<String>,
    pub embeddings: Vec<Embedding>,
    pub usage: EmbeddingModelUsage,
    pub warnings: Vec<Warning>,
    pub provider_metadata: Option<ProviderMetadata>,
    pub responses: Vec<Option<EmbeddingModelV4Response>>,
}

fn validate_dimensions(dimensions: Option<i64>) -> Result<(), InvalidArgumentError> {
    match dimensions {
        Some(d) if d <= 0 => Err(InvalidArgumentError::new(
            "dimensions",
            json!(d),
            "dimensions must be a positive integer",
        )),
        _ => Ok(()),
    }
}

async fn race_abort<T>(
    future: impl std::future::Future<Output = anyhow::Result<T>>,
    abort: Option<&CancellationToken>,
) -> anyhow::Result<T> {
    match abort {
        Some(token) => tokio::select! {
            result = future => result,
            _ = token.cancelled() => Err(super::errors::AbortError::operation().into()),
        },
        None => future.await,
    }
}

/// `embed`: one value's embedding.
pub async fn embed(options: EmbedOptions) -> anyhow::Result<EmbedResult> {
    ensure_log_fields_registered();
    let EmbedOptions {
        model,
        value,
        dimensions,
        max_retries,
        abort_signal,
        headers,
        provider_options,
        telemetry,
        runtime_context,
    } = options;
    validate_dimensions(dimensions)?;
    let retry = prepare_retries(max_retries, abort_signal.clone())?;
    let headers = with_user_agent_suffix(headers.as_ref(), &format!("ai/{VERSION}"));
    let call_id = create_id("call", 24);
    let dispatcher = TelemetryDispatcher::new(telemetry.as_ref());

    if dispatcher.is_active() {
        dispatcher.on_start(&OperationStartEvent::Embed(Box::new(EmbedStartEvent {
            call_id: call_id.clone(),
            operation_id: "ai.embed",
            runtime_context: dispatcher.filter_context(&runtime_context),
            provider: model.provider().to_string(),
            model_id: model.model_id().to_string(),
            value: json!(value),
            dimensions,
            max_retries: retry.max_retries,
            headers: headers.clone(),
            provider_options: provider_options.clone(),
        })));
    }

    let outcome: anyhow::Result<EmbedResult> = async {
        let (embedding, usage, warnings, provider_metadata, response) = retry
            .run(|| {
                let model = model.clone();
                let dispatcher = dispatcher.clone();
                let call_id = call_id.clone();
                let value = value.clone();
                let options = EmbeddingModelV4CallOptions {
                    values: vec![value.clone()],
                    dimensions,
                    abort_signal: abort_signal.clone(),
                    provider_options: provider_options.clone(),
                    headers: Some(headers.clone()),
                };
                let abort = abort_signal.clone();
                async move {
                    let embed_call_id = create_id("call", 24);
                    if dispatcher.is_active() {
                        dispatcher.on_embed_start(&EmbeddingModelCallStartEvent {
                            call_id: call_id.clone(),
                            embed_call_id: embed_call_id.clone(),
                            operation_id: "ai.embed.doEmbed",
                            provider: model.provider().to_string(),
                            model_id: model.model_id().to_string(),
                            values: vec![value.clone()],
                            dimensions,
                        });
                    }
                    let result = race_abort(model.do_embed(options), abort.as_ref()).await?;
                    let usage = result
                        .usage
                        .unwrap_or(EmbeddingModelUsage { tokens: f64::NAN });
                    if dispatcher.is_active() {
                        dispatcher.on_embed_end(&EmbeddingModelCallEndEvent {
                            call_id,
                            embed_call_id,
                            operation_id: "ai.embed.doEmbed",
                            provider: model.provider().to_string(),
                            model_id: model.model_id().to_string(),
                            values: vec![value],
                            embeddings: result.embeddings.clone(),
                            tokens: usage.tokens,
                        });
                    }
                    let Some(embedding) = result.embeddings.first().cloned() else {
                        return Err(InvalidResponseDataError::new(
                            json!(result.embeddings),
                            Some("No embedding generated.".to_string()),
                        )
                        .into());
                    };
                    Ok((
                        embedding,
                        usage,
                        result.warnings,
                        result.provider_metadata,
                        result.response,
                    ))
                }
            })
            .await?;
        log_warnings(&warnings, Some(model.provider()), Some(model.model_id()));
        if dispatcher.is_active() {
            dispatcher.on_end(&OperationEndEvent::Embed(Box::new(EmbedEndEvent {
                call_id: call_id.clone(),
                operation_id: "ai.embed",
                runtime_context: dispatcher.filter_context(&runtime_context),
                provider: model.provider().to_string(),
                model_id: model.model_id().to_string(),
                value: json!(value),
                embedding: json!(embedding),
                tokens: usage.tokens,
                warnings: warnings.clone(),
                provider_metadata: provider_metadata.clone(),
            })));
        }
        Ok(EmbedResult {
            value: value.clone(),
            embedding,
            usage,
            warnings,
            provider_metadata,
            response,
        })
    }
    .await;

    if let Err(error) = &outcome {
        dispatcher.on_error(&call_id, error);
    }
    outcome
}

/// Splits values into calls of at most `max` values each.
fn split_by_limit(values: &[String], max: usize) -> Vec<Vec<String>> {
    if values.is_empty() {
        return Vec::new();
    }
    values.chunks(max.max(1)).map(|c| c.to_vec()).collect()
}

/// `embedMany`: the embeddings of several values, in order. Values beyond what one
/// call serves are split across calls.
pub async fn embed_many(options: EmbedManyOptions) -> anyhow::Result<EmbedManyResult> {
    ensure_log_fields_registered();
    let EmbedManyOptions {
        model,
        values,
        dimensions,
        max_retries,
        abort_signal,
        headers,
        provider_options,
        telemetry,
        runtime_context,
        max_parallel_calls,
    } = options;
    validate_dimensions(dimensions)?;
    let retry = prepare_retries(max_retries, abort_signal.clone())?;
    let headers = with_user_agent_suffix(headers.as_ref(), &format!("ai/{VERSION}"));
    let call_id = create_id("call", 24);
    let dispatcher = TelemetryDispatcher::new(telemetry.as_ref());

    if dispatcher.is_active() {
        dispatcher.on_start(&OperationStartEvent::Embed(Box::new(EmbedStartEvent {
            call_id: call_id.clone(),
            operation_id: "ai.embedMany",
            runtime_context: dispatcher.filter_context(&runtime_context),
            provider: model.provider().to_string(),
            model_id: model.model_id().to_string(),
            value: json!(values),
            dimensions,
            max_retries: retry.max_retries,
            headers: headers.clone(),
            provider_options: provider_options.clone(),
        })));
    }

    let call_chunk = |chunk: Vec<String>| {
        let model = model.clone();
        let dispatcher = dispatcher.clone();
        let call_id = call_id.clone();
        let options = EmbeddingModelV4CallOptions {
            values: chunk.clone(),
            dimensions,
            abort_signal: abort_signal.clone(),
            provider_options: provider_options.clone(),
            headers: Some(headers.clone()),
        };
        let abort = abort_signal.clone();
        let retry = retry.clone();
        async move {
            let result = retry
                .run(|| {
                    let model = model.clone();
                    let dispatcher = dispatcher.clone();
                    let call_id = call_id.clone();
                    let chunk = chunk.clone();
                    let options = options.clone();
                    let abort = abort.clone();
                    async move {
                        let embed_call_id = create_id("call", 24);
                        if dispatcher.is_active() {
                            dispatcher.on_embed_start(&EmbeddingModelCallStartEvent {
                                call_id: call_id.clone(),
                                embed_call_id: embed_call_id.clone(),
                                operation_id: "ai.embedMany.doEmbed",
                                provider: model.provider().to_string(),
                                model_id: model.model_id().to_string(),
                                values: chunk.clone(),
                                dimensions,
                            });
                        }
                        let result = race_abort(model.do_embed(options), abort.as_ref()).await?;
                        let usage = result
                            .usage
                            .unwrap_or(EmbeddingModelUsage { tokens: f64::NAN });
                        if dispatcher.is_active() {
                            dispatcher.on_embed_end(&EmbeddingModelCallEndEvent {
                                call_id,
                                embed_call_id,
                                operation_id: "ai.embedMany.doEmbed",
                                provider: model.provider().to_string(),
                                model_id: model.model_id().to_string(),
                                values: chunk.clone(),
                                embeddings: result.embeddings.clone(),
                                tokens: usage.tokens,
                            });
                        }
                        Ok((result, usage))
                    }
                })
                .await?;
            if result.0.embeddings.len() != chunk.len() {
                return Err(InvalidResponseDataError::new(
                    json!(result.0.embeddings),
                    Some(format!(
                        "Expected {} embeddings, but received {}.",
                        chunk.len(),
                        result.0.embeddings.len()
                    )),
                )
                .into());
            }
            Ok::<_, anyhow::Error>(result)
        }
    };

    let outcome: anyhow::Result<EmbedManyResult> = async {
        let limit = model.max_embeddings_per_call();
        let Some(max_per_call) = limit else {
            let (result, usage) = call_chunk(values.clone()).await?;
            log_warnings(
                &result.warnings,
                Some(model.provider()),
                Some(model.model_id()),
            );
            if dispatcher.is_active() {
                dispatcher.on_end(&OperationEndEvent::Embed(Box::new(EmbedEndEvent {
                    call_id: call_id.clone(),
                    operation_id: "ai.embedMany",
                    runtime_context: dispatcher.filter_context(&runtime_context),
                    provider: model.provider().to_string(),
                    model_id: model.model_id().to_string(),
                    value: json!(values),
                    embedding: json!(result.embeddings),
                    tokens: usage.tokens,
                    warnings: result.warnings.clone(),
                    provider_metadata: result.provider_metadata.clone(),
                })));
            }
            return Ok(EmbedManyResult {
                values: values.clone(),
                embeddings: result.embeddings,
                usage,
                warnings: result.warnings,
                provider_metadata: result.provider_metadata,
                responses: vec![result.response],
            });
        };

        let chunks = split_by_limit(&values, max_per_call);
        let parallel = if model.supports_parallel_calls() {
            max_parallel_calls.unwrap_or(usize::MAX)
        } else {
            1
        };
        if parallel == 0 {
            return Err(InvalidArgumentError::new(
                "chunkSize",
                json!(0),
                "chunkSize must be greater than 0",
            )
            .into());
        }
        let mut embeddings: Vec<Embedding> = Vec::new();
        let mut warnings: Vec<Warning> = Vec::new();
        let mut responses = Vec::new();
        let mut tokens = 0.0;
        let mut provider_metadata: Option<ProviderMetadata> = None;
        for group in chunks.chunks(parallel) {
            let results = futures::future::join_all(group.iter().cloned().map(&call_chunk)).await;
            for result in results {
                let (result, usage) = result?;
                embeddings.extend(result.embeddings);
                warnings.extend(result.warnings);
                responses.push(result.response);
                tokens += usage.tokens;
                if let Some(metadata) = result.provider_metadata {
                    let merged = provider_metadata.get_or_insert_with(ProviderMetadata::new);
                    for (provider, value) in metadata {
                        let mut entry = merged
                            .get(&provider)
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        if let Value::Object(fields) = value {
                            entry.extend(fields);
                        }
                        merged.insert(provider, Value::Object(entry));
                    }
                }
            }
        }
        log_warnings(&warnings, Some(model.provider()), Some(model.model_id()));
        if dispatcher.is_active() {
            dispatcher.on_end(&OperationEndEvent::Embed(Box::new(EmbedEndEvent {
                call_id: call_id.clone(),
                operation_id: "ai.embedMany",
                runtime_context: dispatcher.filter_context(&runtime_context),
                provider: model.provider().to_string(),
                model_id: model.model_id().to_string(),
                value: json!(values),
                embedding: json!(embeddings),
                tokens,
                warnings: warnings.clone(),
                provider_metadata: provider_metadata.clone(),
            })));
        }
        Ok(EmbedManyResult {
            values: values.clone(),
            embeddings,
            usage: EmbeddingModelUsage { tokens },
            warnings,
            provider_metadata,
            responses,
        })
    }
    .await;

    if let Err(error) = &outcome {
        dispatcher.on_error(&call_id, error);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::EmbeddingModelV4Result;
    use async_trait::async_trait;
    use parking_lot::Mutex;

    struct Counter {
        max: Option<usize>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    #[async_trait]
    impl EmbeddingModel for Counter {
        fn provider(&self) -> &str {
            "mock"
        }
        fn model_id(&self) -> &str {
            "embed"
        }
        fn max_embeddings_per_call(&self) -> Option<usize> {
            self.max
        }
        async fn do_embed(
            &self,
            options: EmbeddingModelV4CallOptions,
        ) -> anyhow::Result<EmbeddingModelV4Result> {
            self.calls.lock().push(options.values.clone());
            Ok(EmbeddingModelV4Result {
                embeddings: options
                    .values
                    .iter()
                    .map(|v| vec![v.len() as f64])
                    .collect(),
                usage: Some(EmbeddingModelUsage {
                    tokens: options.values.len() as f64,
                }),
                ..Default::default()
            })
        }
    }

    #[tokio::test]
    async fn embeds_one_value() {
        let model = Arc::new(Counter {
            max: None,
            calls: Mutex::new(vec![]),
        });
        let result = embed(EmbedOptions::new(model, "abc")).await.unwrap();
        assert_eq!(result.embedding, vec![3.0]);
        assert_eq!(result.usage.tokens, 1.0);
    }

    #[tokio::test]
    async fn splits_values_beyond_the_per_call_limit_and_keeps_their_order() {
        let model = Arc::new(Counter {
            max: Some(2),
            calls: Mutex::new(vec![]),
        });
        let values: Vec<String> = ["a", "bb", "ccc", "dddd", "eeeee"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut options = EmbedManyOptions::new(model.clone(), values);
        options.max_parallel_calls = Some(1);
        let result = embed_many(options).await.unwrap();
        assert_eq!(
            result.embeddings,
            vec![vec![1.0], vec![2.0], vec![3.0], vec![4.0], vec![5.0]]
        );
        assert_eq!(model.calls.lock().len(), 3);
        assert_eq!(result.usage.tokens, 5.0);
    }
}
