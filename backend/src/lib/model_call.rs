//! The one way this runtime calls a model. Every call goes through `call_model` or
//! `call_model_for_object`, which record what it cost in `llm_calls` before handing
//! the result back, so accounting is a property of the seam rather than something
//! each call site has to remember.

use std::sync::Arc;

use crate::ai::{
    GenerateObjectOptions, GenerateObjectResult, GenerateTextOptions, GenerateTextResult,
    LanguageModelUsage, NoObjectGeneratedError, PrepareStepOptions, StepResult, generate_object,
    generate_text,
};
use serde_json::Value;

use crate::lib::inference_gate::INFERENCE_GATE;
use crate::lib::telemetry::LangfuseTelemetry;
use crate::services::llm_call_service::{LLM_CALL_SERVICE, LlmCallPurpose, RecordInput};

/// What a model call is for, recorded on its `llm_calls` rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCallMeta {
    pub purpose: LlmCallPurpose,
    /// The thread this call belongs to, where it has one.
    pub thread_id: Option<String>,
    /// The subagent the call ran for, where it was not the owner's own work.
    pub agent_id: Option<String>,
}

impl ModelCallMeta {
    /// A call for `purpose` with no thread and no subagent.
    pub fn new(purpose: LlmCallPurpose) -> Self {
        Self {
            purpose,
            thread_id: None,
            agent_id: None,
        }
    }
}

/// Sets a call's tracing options from `langfuse_telemetry(…)`: its runtime context
/// and its telemetry settings.
pub fn apply_telemetry(params: &mut GenerateTextOptions, telemetry: LangfuseTelemetry) {
    if let Some(identifiers) = telemetry.runtime_context {
        params.runtime_context = identifiers
            .into_iter()
            .map(|(key, value)| (key, Value::String(value)))
            .collect();
    }
    if let Some(experimental) = telemetry.experimental_telemetry {
        params.telemetry = Some(experimental);
    }
}

/// `apply_telemetry` for a `generate_object` call, which takes the telemetry
/// settings alone.
pub fn apply_object_telemetry(params: &mut GenerateObjectOptions, telemetry: LangfuseTelemetry) {
    if let Some(experimental) = telemetry.experimental_telemetry {
        params.telemetry = Some(experimental);
    }
}

/// `generate_text`, with one `llm_calls` row per completed step.
///
/// Recording rides `on_step_finish` so a multi-step turn is counted step by step,
/// as the provider bills it, and a turn that dies part-way keeps the steps it
/// finished. A caller's own `on_step_finish` runs after the row is written
/// (`LLM_CALL_SERVICE.record({ ...meta, model, usage: step.usage })`, where `model`
/// is the id of `params.model`).
///
/// The gate a secure takeover of the computer holds is asked before every step,
/// not only before the call: one `generate_text` runs a whole tool loop, so a
/// takeover that opens mid-turn has to stop the next step rather than the next
/// turn. A password is then typed with nothing running that could decide to look
/// at it. Each step waits on the gate, runs the caller's own `prepare_step`, and
/// waits on the gate again, since the caller's hook awaits work of its own — the
/// steering drain reads the database — so a window that opened while it ran is
/// still ahead of this step.
pub async fn call_model(
    meta: ModelCallMeta,
    mut params: GenerateTextOptions,
) -> anyhow::Result<GenerateTextResult> {
    INFERENCE_GATE.wait(params.abort_signal.as_ref()).await?;
    let model = params.model.model_id().to_string();
    let caller_on_step_finish = params.on_step_finish.take();
    let caller_prepare_step = params.prepare_step.take();
    let abort_signal = params.abort_signal.clone();

    params.prepare_step = Some(Arc::new(move |options: PrepareStepOptions| {
        let caller_prepare_step = caller_prepare_step.clone();
        let abort_signal = abort_signal.clone();
        Box::pin(async move {
            INFERENCE_GATE.wait(abort_signal.as_ref()).await?;
            let prepared = match &caller_prepare_step {
                Some(prepare) => prepare(options).await?,
                None => None,
            };
            // The caller's own hook awaits work of its own (the steering drain reads
            // the database), so a window that opened while it ran is still ahead of
            // this step.
            INFERENCE_GATE.wait(abort_signal.as_ref()).await?;
            Ok(prepared)
        })
    }));

    params.on_step_finish = Some(Arc::new(move |step: Arc<StepResult>| {
        let meta = meta.clone();
        let model = model.clone();
        let caller_on_step_finish = caller_on_step_finish.clone();
        Box::pin(async move {
            LLM_CALL_SERVICE.record(RecordInput {
                purpose: meta.purpose,
                model,
                usage: Some(step.usage.clone()),
                thread_id: meta.thread_id,
                agent_id: meta.agent_id,
            });
            if let Some(on_step_finish) = &caller_on_step_finish {
                on_step_finish(step).await;
            }
        })
    }));

    generate_text(params).await
}

/// `generate_object`, with one `llm_calls` row for the call.
///
/// Structured output is a single request, so there is one row. A schema the model
/// failed to satisfy still spends the tokens it generated, and the SDK hands them
/// back on the error (`NoObjectGeneratedError.usage`), so that row is written too
/// before the error is returned.
pub async fn call_model_for_object(
    meta: ModelCallMeta,
    params: GenerateObjectOptions,
) -> anyhow::Result<GenerateObjectResult> {
    INFERENCE_GATE.wait(params.abort_signal.as_ref()).await?;
    let model = params.model.model_id().to_string();
    let record = |usage: Option<LanguageModelUsage>| {
        LLM_CALL_SERVICE.record(RecordInput {
            purpose: meta.purpose,
            model: model.clone(),
            usage,
            thread_id: meta.thread_id.clone(),
            agent_id: meta.agent_id.clone(),
        });
    };

    match generate_object(params).await {
        Ok(result) => {
            record(Some(result.usage.clone()));
            Ok(result)
        }
        Err(error) => {
            if let Some(no_object) = error.downcast_ref::<NoObjectGeneratedError>() {
                record(no_object.usage.clone());
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{
        FinishReason, LanguageModel, LanguageModelV4CallOptions, LanguageModelV4Content,
        LanguageModelV4FinishReason, LanguageModelV4GenerateResult, LanguageModelV4InputTokens,
        LanguageModelV4OutputTokens, LanguageModelV4Usage, PrepareStepResult,
    };
    use async_trait::async_trait;
    use parking_lot::Mutex;

    /// A model that answers every call with one text and records what it was sent.
    struct Scripted {
        calls: Mutex<Vec<LanguageModelV4CallOptions>>,
    }

    #[async_trait]
    impl LanguageModel for Scripted {
        fn provider(&self) -> &str {
            "mock-provider"
        }

        fn model_id(&self) -> &str {
            "a-model"
        }

        async fn do_generate(
            &self,
            options: LanguageModelV4CallOptions,
        ) -> anyhow::Result<LanguageModelV4GenerateResult> {
            self.calls.lock().push(options);
            Ok(LanguageModelV4GenerateResult {
                content: vec![LanguageModelV4Content::Text {
                    text: "done".into(),
                    provider_metadata: None,
                }],
                finish_reason: LanguageModelV4FinishReason {
                    unified: FinishReason::Stop,
                    raw: None,
                },
                usage: LanguageModelV4Usage {
                    input_tokens: LanguageModelV4InputTokens {
                        total: Some(10),
                        no_cache: Some(10),
                        ..Default::default()
                    },
                    output_tokens: LanguageModelV4OutputTokens {
                        total: Some(1),
                        text: Some(1),
                        ..Default::default()
                    },
                    raw: None,
                },
                provider_metadata: None,
                request: None,
                response: None,
                warnings: vec![],
            })
        }
    }

    #[tokio::test]
    async fn runs_the_callers_own_hooks_around_the_recording() {
        let model = Arc::new(Scripted {
            calls: Mutex::new(Vec::new()),
        });
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();

        let mut params = GenerateTextOptions::new(model.clone());
        params.prompt = Some("hi".into());
        let prepared = seen.clone();
        params.prepare_step = Some(Arc::new(move |_options| {
            let prepared = prepared.clone();
            Box::pin(async move {
                prepared.lock().push("prepare".into());
                Ok(Some(PrepareStepResult::default()))
            })
        }));
        let finished = seen.clone();
        params.on_step_finish = Some(Arc::new(move |step: Arc<StepResult>| {
            let finished = finished.clone();
            Box::pin(async move {
                finished
                    .lock()
                    .push(format!("finish:{}", step.usage.output_tokens.unwrap_or(0)));
            })
        }));

        let result = call_model(
            ModelCallMeta {
                purpose: LlmCallPurpose::Chat,
                thread_id: Some("thread-1".into()),
                agent_id: None,
            },
            params,
        )
        .await
        .unwrap();

        assert_eq!(result.text(), "done");
        assert_eq!(*seen.lock(), ["prepare", "finish:1"]);
        assert_eq!(model.calls.lock().len(), 1);
    }

    #[test]
    fn sets_the_tracing_options_of_a_call() {
        let model = Arc::new(Scripted {
            calls: Mutex::new(Vec::new()),
        });
        let mut params = GenerateTextOptions::new(model);
        let mut identifiers = indexmap::IndexMap::new();
        identifiers.insert("userId".to_string(), "user-1".to_string());
        apply_telemetry(
            &mut params,
            LangfuseTelemetry {
                runtime_context: Some(identifiers),
                experimental_telemetry: None,
            },
        );
        assert_eq!(params.runtime_context["userId"], "user-1");
        assert!(params.telemetry.is_none());
    }
}
