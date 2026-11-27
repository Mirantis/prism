//! `generateObject` in `object` mode: one model call whose answer is JSON that
//! must match a schema.

use std::sync::Arc;

use chrono::Utc;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::VERSION;
use super::errors::{JsonParseError, NoObjectGeneratedError, ensure_log_fields_registered};
use super::generate_text::{
    CallSettings, FinishReason, LanguageModelRequestMetadata, LanguageModelResponseMetadata,
    create_id, with_user_agent_suffix,
};
use super::json::secure_json_parse;
use super::messages::ModelMessage;
use super::model::LanguageModel;
use super::prompt::{Instructions, Prompt, convert_to_language_model_prompt, standardize_prompt};
use super::provider::{
    Headers, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4ResponseFormat,
    ProviderMetadata, ProviderOptions, Warning,
};
use super::retry::prepare_retries;
use super::telemetry::{
    GenerateObjectEndEvent, GenerateObjectStartEvent, GenerateObjectStepEndEvent,
    GenerateObjectStepStartEvent, OperationEndEvent, OperationStartEvent, TelemetryDispatcher,
    TelemetryOptions,
};
use super::tool::{Schema, safe_validate_types};
use super::usage::LanguageModelUsage;
use super::warnings::log_warnings;

/// The options of `generate_object`.
#[derive(Clone)]
pub struct GenerateObjectOptions {
    pub model: Arc<dyn LanguageModel>,
    /// The schema the object must match.
    pub schema: Schema,
    pub schema_name: Option<String>,
    pub schema_description: Option<String>,
    pub system: Option<Instructions>,
    pub prompt: Option<Prompt>,
    pub messages: Option<Vec<ModelMessage>>,
    pub allow_system_in_messages: bool,
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub seed: Option<i64>,
    pub max_retries: Option<i64>,
    pub abort_signal: Option<CancellationToken>,
    pub headers: Option<Headers>,
    pub telemetry: Option<TelemetryOptions>,
    pub provider_options: Option<ProviderOptions>,
}

impl GenerateObjectOptions {
    /// Options with every other setting at its default.
    pub fn new(model: Arc<dyn LanguageModel>, schema: Schema) -> Self {
        Self {
            model,
            schema,
            schema_name: None,
            schema_description: None,
            system: None,
            prompt: None,
            messages: None,
            allow_system_in_messages: false,
            max_output_tokens: None,
            temperature: None,
            top_p: None,
            top_k: None,
            presence_penalty: None,
            frequency_penalty: None,
            seed: None,
            max_retries: None,
            abort_signal: None,
            headers: None,
            telemetry: None,
            provider_options: None,
        }
    }
}

/// The result of `generate_object`.
#[derive(Debug, Clone)]
pub struct GenerateObjectResult {
    /// The object, as the schema parsed it.
    pub object: Value,
    pub reasoning: Option<String>,
    pub finish_reason: FinishReason,
    pub usage: LanguageModelUsage,
    pub warnings: Vec<Warning>,
    pub request: LanguageModelRequestMetadata,
    pub response: LanguageModelResponseMetadata,
    pub provider_metadata: Option<ProviderMetadata>,
}

fn extract_text(content: &[LanguageModelV4Content]) -> Option<String> {
    let texts: Vec<&str> = content
        .iter()
        .filter_map(|part| match part {
            LanguageModelV4Content::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if texts.is_empty() {
        None
    } else {
        Some(texts.concat())
    }
}

fn extract_reasoning(content: &[LanguageModelV4Content]) -> Option<String> {
    let texts: Vec<&str> = content
        .iter()
        .filter_map(|part| match part {
            LanguageModelV4Content::Reasoning { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

/// `generateObject`: the object the model wrote, parsed and checked against the
/// schema. A failed parse or check is a `NoObjectGeneratedError` that carries the
/// tokens the model spent.
pub async fn generate_object(
    options: GenerateObjectOptions,
) -> anyhow::Result<GenerateObjectResult> {
    ensure_log_fields_registered();
    log_warnings(
        &[Warning::Deprecated {
            setting: "generateObject".to_string(),
            message: "Use generateText with an output setting instead.".to_string(),
        }],
        None,
        None,
    );
    let GenerateObjectOptions {
        model,
        schema,
        schema_name,
        schema_description,
        system,
        prompt,
        messages,
        allow_system_in_messages,
        max_output_tokens,
        temperature,
        top_p,
        top_k,
        presence_penalty,
        frequency_penalty,
        seed,
        max_retries,
        abort_signal,
        headers,
        telemetry,
        provider_options,
    } = options;

    let retry = prepare_retries(max_retries, abort_signal.clone())?;
    let settings = CallSettings {
        max_output_tokens,
        temperature,
        top_p,
        top_k,
        presence_penalty,
        frequency_penalty,
        stop_sequences: None,
        seed,
        reasoning: None,
    };
    settings.validate()?;
    let headers = with_user_agent_suffix(headers.as_ref(), &format!("ai/{VERSION}"));
    let dispatcher = TelemetryDispatcher::new(telemetry.as_ref());
    let json_schema = schema.json_schema().clone();
    let call_id = create_id("aiobj", 24);

    if dispatcher.is_active() {
        dispatcher.on_start(&OperationStartEvent::GenerateObject(Box::new(
            GenerateObjectStartEvent {
                call_id: call_id.clone(),
                operation_id: "ai.generateObject",
                provider: model.provider().to_string(),
                model_id: model.model_id().to_string(),
                system: system.clone(),
                prompt: prompt.clone(),
                messages: messages.clone(),
                max_output_tokens,
                temperature,
                top_p,
                top_k,
                presence_penalty,
                frequency_penalty,
                seed,
                max_retries: retry.max_retries,
                headers: headers.clone(),
                provider_options: provider_options.clone(),
                output: "object",
                schema: Some(json_schema.clone()),
                schema_name: schema_name.clone(),
                schema_description: schema_description.clone(),
            },
        )));
    }

    let outcome: anyhow::Result<GenerateObjectResult> = async {
        let standardized = standardize_prompt(system, prompt, messages, allow_system_in_messages)?;
        let provider_prefix = model.provider().split('.').next().unwrap_or_default().to_string();
        let prompt_messages = convert_to_language_model_prompt(
            &standardized,
            &model.supported_urls(),
            abort_signal.as_ref(),
            Some(&provider_prefix),
        )
        .await?;

        if dispatcher.is_active() {
            dispatcher.on_object_step_start(&GenerateObjectStepStartEvent {
                call_id: call_id.clone(),
                step_number: 0,
                provider: model.provider().to_string(),
                model_id: model.model_id().to_string(),
                provider_options: provider_options.clone(),
                headers: headers.clone(),
                prompt_messages: prompt_messages.clone(),
            });
        }

        let mut call_options = LanguageModelV4CallOptions {
            response_format: Some(LanguageModelV4ResponseFormat::Json {
                schema: Some(json_schema.clone()),
                name: schema_name.clone(),
                description: schema_description.clone(),
            }),
            prompt: prompt_messages,
            provider_options: provider_options.clone(),
            abort_signal: abort_signal.clone(),
            headers: Some(headers.clone()),
            ..Default::default()
        };
        settings.apply_to(&mut call_options);

        let generated = retry
            .run(|| {
                let model = model.clone();
                let options = call_options.clone();
                let abort = abort_signal.clone();
                async move {
                    match abort {
                        Some(token) => tokio::select! {
                            result = model.do_generate(options) => result,
                            _ = token.cancelled() => Err(super::errors::AbortError::operation().into()),
                        },
                        None => model.do_generate(options).await,
                    }
                }
            })
            .await?;

        let provider_response = generated.response.clone().unwrap_or_default();
        let response = LanguageModelResponseMetadata {
            id: provider_response.id.clone().unwrap_or_else(|| create_id("aiobj", 24)),
            timestamp: provider_response.timestamp.unwrap_or_else(Utc::now),
            model_id: provider_response
                .model_id
                .clone()
                .unwrap_or_else(|| model.model_id().to_string()),
            headers: provider_response.headers.clone(),
            body: provider_response.body.clone(),
            messages: Vec::new(),
        };
        let usage = LanguageModelUsage::from_v4(&generated.usage);
        let finish_reason = generated.finish_reason.unified;
        let text = extract_text(&generated.content);
        let reasoning = extract_reasoning(&generated.content);

        let Some(text) = text else {
            return Err(NoObjectGeneratedError {
                message: "No object generated: the model did not return a response.".to_string(),
                cause: None,
                text: None,
                response: Some(response),
                usage: Some(usage),
                finish_reason: Some(finish_reason),
            }
            .into());
        };

        let request = LanguageModelRequestMetadata {
            body: generated.request.as_ref().and_then(|r| r.body.clone()),
            messages: None,
        };
        log_warnings(&generated.warnings, Some(model.provider()), Some(model.model_id()));

        if dispatcher.is_active() {
            dispatcher.on_object_step_end(&GenerateObjectStepEndEvent {
                call_id: call_id.clone(),
                step_number: 0,
                provider: model.provider().to_string(),
                model_id: model.model_id().to_string(),
                finish_reason,
                usage: usage.clone(),
                object_text: text.clone(),
                reasoning: reasoning.clone(),
                warnings: generated.warnings.clone(),
                request: request.clone(),
                response: response.clone(),
                provider_metadata: generated.provider_metadata.clone(),
            });
        }

        let no_object = |message: &str, cause: anyhow::Error| NoObjectGeneratedError {
            message: message.to_string(),
            cause: Some(Arc::new(cause)),
            text: Some(text.clone()),
            response: Some(response.clone()),
            usage: Some(usage.clone()),
            finish_reason: Some(finish_reason),
        };
        let parsed = secure_json_parse(&text).map_err(|e| {
            no_object(
                "No object generated: could not parse the response.",
                JsonParseError::new(text.clone(), anyhow::Error::new(e)).into(),
            )
        })?;
        let object = safe_validate_types(&parsed, &schema)
            .map_err(|e| no_object("No object generated: response did not match schema.", e.into()))?;

        if dispatcher.is_active() {
            dispatcher.on_end(&OperationEndEvent::GenerateObject(Box::new(GenerateObjectEndEvent {
                call_id: call_id.clone(),
                object: object.clone(),
                reasoning: reasoning.clone(),
                finish_reason,
                usage: usage.clone(),
                warnings: generated.warnings.clone(),
                request: request.clone(),
                response: response.clone(),
                provider_metadata: generated.provider_metadata.clone(),
            })));
        }

        Ok(GenerateObjectResult {
            object,
            reasoning,
            finish_reason,
            usage,
            warnings: generated.warnings,
            request,
            response,
            provider_metadata: generated.provider_metadata,
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
    use crate::ai::model::LanguageModel;
    use crate::ai::provider::{
        LanguageModelV4FinishReason, LanguageModelV4GenerateResult, LanguageModelV4OutputTokens,
        LanguageModelV4Usage,
    };
    use crate::ai::tool::zod_schema;
    use async_trait::async_trait;
    use parking_lot::Mutex;
    use serde_json::json;

    struct Answer {
        text: String,
        seen: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl LanguageModel for Answer {
        fn provider(&self) -> &str {
            "mock.messages"
        }
        fn model_id(&self) -> &str {
            "mock-model"
        }
        async fn do_generate(
            &self,
            options: LanguageModelV4CallOptions,
        ) -> anyhow::Result<LanguageModelV4GenerateResult> {
            self.seen.lock().push(serde_json::to_value(&options)?);
            Ok(LanguageModelV4GenerateResult {
                content: vec![LanguageModelV4Content::Text {
                    text: self.text.clone(),
                    provider_metadata: None,
                }],
                finish_reason: LanguageModelV4FinishReason {
                    unified: FinishReason::Stop,
                    raw: None,
                },
                usage: LanguageModelV4Usage {
                    output_tokens: LanguageModelV4OutputTokens {
                        total: Some(3),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                provider_metadata: None,
                request: None,
                response: None,
                warnings: vec![],
            })
        }
    }

    fn schema() -> Schema {
        zod_schema(json!({
            "type": "object",
            "properties": { "action": { "type": "string", "enum": ["respond", "no_reply"] } },
            "required": ["action"],
            "additionalProperties": false
        }))
    }

    #[tokio::test]
    async fn returns_the_parsed_object_and_sends_a_json_response_format() {
        let model = Arc::new(Answer {
            text: "{\"action\":\"respond\"}".into(),
            seen: Mutex::new(vec![]),
        });
        let mut options = GenerateObjectOptions::new(model.clone(), schema());
        options.schema_name = Some("decision".into());
        options.system = Some("judge".into());
        options.prompt = Some("hello".into());
        options.temperature = Some(0.0);
        let result = generate_object(options).await.unwrap();
        assert_eq!(result.object, json!({ "action": "respond" }));
        let seen = model.seen.lock()[0].clone();
        assert_eq!(seen["responseFormat"]["type"], "json");
        assert_eq!(seen["responseFormat"]["name"], "decision");
        assert_eq!(seen["temperature"], json!(0));
        assert!(seen.get("tools").is_none());
        assert!(seen.get("toolChoice").is_none());
    }

    #[tokio::test]
    async fn reports_the_usage_of_an_object_that_does_not_match() {
        let model = Arc::new(Answer {
            text: "{\"action\":\"maybe\"}".into(),
            seen: Mutex::new(vec![]),
        });
        let mut options = GenerateObjectOptions::new(model, schema());
        options.prompt = Some("hello".into());
        let err = generate_object(options).await.unwrap_err();
        let no_object = err.downcast_ref::<NoObjectGeneratedError>().unwrap();
        assert_eq!(
            no_object.message,
            "No object generated: response did not match schema."
        );
        assert_eq!(no_object.usage.as_ref().unwrap().output_tokens, Some(3));
    }
}
