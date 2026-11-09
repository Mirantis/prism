//! Langfuse tracing-pipeline tests.
//!
//! These run the real `generate_text` and the real integration against an
//! in-memory span collector. They assert on the two span facts Langfuse depends
//! on, and on the one case that must produce no span at all.
//!
//! The SDK does not write spans itself. It calls whatever telemetry integration
//! is registered, so an unregistered — or renamed, or reshaped — integration
//! means every trace silently disappears. Nothing fails, nothing warns; the only
//! symptom is an empty Langfuse.

use super::*;
use crate::ai::generate_text::{GenerateTextOptions, generate_text};
use crate::ai::provider::{
    LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4FinishReason,
    LanguageModelV4GenerateResult, LanguageModelV4InputTokens, LanguageModelV4OutputTokens,
    LanguageModelV4Usage,
};
use crate::ai::{
    LanguageModel, ModelMessage, TelemetryOptions, Tool, ToolSet, execute_fn, step_count_is,
};
use async_trait::async_trait;
use opentelemetry_sdk::trace::SpanData;

/// Keeps every ended span.
#[derive(Debug, Default, Clone)]
struct Collector(Arc<Mutex<Vec<SpanData>>>);

impl SpanProcessor for Collector {
    fn on_start(&self, _span: &mut SdkSpan, _cx: &Context) {}
    fn on_end(&self, span: SpanData) {
        self.0.lock().push(span);
    }
    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }
    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }
}

impl Collector {
    fn spans(&self) -> Vec<SpanData> {
        self.0.lock().clone()
    }

    fn span(&self, name: &str) -> SpanData {
        self.spans()
            .into_iter()
            .find(|span| span.name == name)
            .unwrap_or_else(|| panic!("no span {name}"))
    }
}

fn attr(span: &SpanData, key: &str) -> Option<OtelValue> {
    span.attributes
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| kv.value.clone())
}

fn attr_text(span: &SpanData, key: &str) -> Option<String> {
    attr(span, key).map(|value| value.as_str().into_owned())
}

/// A model that answers immediately: a tool call when it was given tools and has
/// not called one yet, else `ok`.
struct Model;

fn usage() -> LanguageModelV4Usage {
    LanguageModelV4Usage {
        input_tokens: LanguageModelV4InputTokens {
            total: Some(3),
            no_cache: Some(3),
            cache_read: Some(0),
            ..Default::default()
        },
        output_tokens: LanguageModelV4OutputTokens {
            total: Some(1),
            text: Some(1),
            reasoning: Some(0),
        },
        raw: None,
    }
}

#[async_trait]
impl LanguageModel for Model {
    fn provider(&self) -> &str {
        "mock-provider"
    }

    fn model_id(&self) -> &str {
        "mock-model-id"
    }

    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        let called = options
            .prompt
            .iter()
            .any(|message| message.role() == "tool");
        let has_tools = options
            .tools
            .as_ref()
            .is_some_and(|tools| !tools.is_empty());
        let (content, finish) = if has_tools && !called {
            (
                vec![LanguageModelV4Content::ToolCall {
                    tool_call_id: "call-1".into(),
                    tool_name: "echo".into(),
                    input: r#"{"value":1}"#.into(),
                    provider_executed: None,
                    dynamic: None,
                    provider_metadata: None,
                }],
                FinishReason::ToolCalls,
            )
        } else {
            (
                vec![LanguageModelV4Content::Text {
                    text: "ok".into(),
                    provider_metadata: None,
                }],
                FinishReason::Stop,
            )
        };
        Ok(LanguageModelV4GenerateResult {
            content,
            finish_reason: LanguageModelV4FinishReason {
                unified: finish,
                raw: Some("end_turn".into()),
            },
            usage: usage(),
            provider_metadata: None,
            request: None,
            response: None,
            warnings: vec![],
        })
    }
}

fn pipeline() -> (Collector, Arc<LegacyOpenTelemetry>, SdkTracerProvider) {
    let collector = Collector::default();
    let processor =
        LangfuseSpanProcessor::new(collector.clone(), &ProcessorSettings::default(), None);
    let provider = SdkTracerProvider::builder()
        .with_span_processor(processor)
        .build();
    let integration = Arc::new(LegacyOpenTelemetry::new(provider.tracer("ai")));
    (collector, integration, provider)
}

fn options(
    integration: &Arc<LegacyOpenTelemetry>,
    telemetry: TelemetryOptions,
) -> GenerateTextOptions {
    let mut options = GenerateTextOptions::new(Arc::new(Model));
    options.messages = Some(vec![ModelMessage::user("hello")]);
    options.telemetry = Some(TelemetryOptions {
        integrations: Some(vec![integration.clone() as Arc<dyn Telemetry>]),
        ..telemetry
    });
    options
}

fn enabled(function_id: &str) -> TelemetryOptions {
    TelemetryOptions {
        is_enabled: Some(true),
        function_id: Some(function_id.to_string()),
        ..Default::default()
    }
}

#[tokio::test]
async fn emits_the_span_names_and_prompt_attributes_langfuse_reads() {
    let (collector, integration, _provider) = pipeline();
    generate_text(options(&integration, enabled("probe")))
        .await
        .unwrap();

    let names: Vec<String> = collector
        .spans()
        .iter()
        .map(|span| span.name.to_string())
        .collect();
    assert!(names.contains(&"ai.generateText".to_string()));
    assert!(names.contains(&"ai.generateText.doGenerate".to_string()));

    // Langfuse reads the conversation out of these two attributes, one on each
    // span. A span that arrives without them renders with no prompt.
    let outer = collector.span("ai.generateText");
    assert_eq!(
        attr_text(&outer, "ai.prompt").as_deref(),
        Some(r#"{"messages":[{"role":"user","content":"hello"}]}"#)
    );
    assert_eq!(
        attr_text(&outer, "operation.name").as_deref(),
        Some("ai.generateText probe")
    );
    assert_eq!(attr_text(&outer, "resource.name").as_deref(), Some("probe"));
    assert_eq!(attr_text(&outer, "ai.response.text").as_deref(), Some("ok"));
    assert_eq!(
        attr(&outer, "ai.usage.inputTokens"),
        Some(OtelValue::I64(3))
    );
    assert_eq!(
        attr(&outer, "ai.settings.maxRetries"),
        Some(OtelValue::I64(2))
    );

    let inner = collector.span("ai.generateText.doGenerate");
    assert!(attr(&inner, "ai.prompt.messages").is_some());
    assert_eq!(
        attr_text(&inner, "ai.prompt.toolChoice").as_deref(),
        Some(r#"{"type":"auto"}"#)
    );
    assert_eq!(
        attr_text(&inner, "gen_ai.system").as_deref(),
        Some("mock-provider")
    );
    assert_eq!(inner.parent_span_id, outer.span_context.span_id());
    assert_eq!(
        attr(&inner, "gen_ai.response.finish_reasons"),
        Some(OtelValue::Array(Array::String(vec!["stop".into()])))
    );

    // The outer span starts the trace; Langfuse treats it as the app root.
    assert_eq!(
        attr(&outer, "langfuse.internal.is_app_root"),
        Some(OtelValue::Bool(true))
    );
    assert_eq!(attr(&inner, "langfuse.internal.is_app_root"), None);
}

#[tokio::test]
async fn carries_a_call_site_s_identifiers_onto_the_span() {
    let (collector, integration, _provider) = pipeline();
    let mut options = options(
        &integration,
        TelemetryOptions {
            include_runtime_context: Some(
                [
                    ("userId".to_string(), true),
                    ("sessionId".to_string(), true),
                ]
                .into_iter()
                .collect(),
            ),
            ..enabled("probe")
        },
    );
    options.runtime_context = json!({ "userId": "user-1", "sessionId": "thread-1", "other": "x" })
        .as_object()
        .cloned()
        .unwrap();
    generate_text(options).await.unwrap();

    let outer = collector.span("ai.generateText");
    assert_eq!(
        attr_text(&outer, "ai.settings.context.userId").as_deref(),
        Some("user-1")
    );
    assert_eq!(
        attr_text(&outer, "ai.settings.context.sessionId").as_deref(),
        Some("thread-1")
    );
    assert_eq!(attr(&outer, "ai.settings.context.other"), None);
}

#[tokio::test]
async fn emits_nothing_when_a_call_site_opts_out() {
    let (collector, integration, _provider) = pipeline();
    generate_text(options(
        &integration,
        TelemetryOptions {
            is_enabled: Some(false),
            ..Default::default()
        },
    ))
    .await
    .unwrap();
    // The thread reply classifier relies on this: its prompt is a channel
    // transcript, and an integration being registered must not start recording
    // it.
    assert!(collector.spans().is_empty());
}

#[tokio::test]
async fn traces_without_recording_content_when_asked() {
    let (collector, integration, _provider) = pipeline();
    generate_text(options(
        &integration,
        TelemetryOptions {
            record_inputs: Some(false),
            record_outputs: Some(false),
            ..enabled("probe")
        },
    ))
    .await
    .unwrap();

    // What `langfuse_telemetry(…, record_content: false)` buys the meeting gate:
    // the call is still timed and counted, the words never leave the host.
    let outer = collector.span("ai.generateText");
    assert_eq!(attr(&outer, "ai.prompt"), None);
    assert_eq!(attr(&outer, "ai.response.text"), None);
    assert_eq!(
        attr(&outer, "ai.usage.outputTokens"),
        Some(OtelValue::I64(1))
    );

    let inner = collector.span("ai.generateText.doGenerate");
    assert_eq!(attr(&inner, "ai.prompt.messages"), None);
}

#[tokio::test]
async fn nests_a_tool_call_under_its_step() {
    let (collector, integration, _provider) = pipeline();
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|input, _| async move { Ok(input) })),
            ..Default::default()
        },
    );
    let mut options = options(&integration, enabled("probe"));
    options.tools = Some(tools);
    options.stop_when = Some(vec![step_count_is(5)]);
    generate_text(options).await.unwrap();

    let tool = collector.span("ai.toolCall");
    assert_eq!(
        attr_text(&tool, "ai.toolCall.name").as_deref(),
        Some("echo")
    );
    assert_eq!(
        attr_text(&tool, "ai.toolCall.id").as_deref(),
        Some("call-1")
    );
    assert_eq!(
        attr_text(&tool, "ai.toolCall.args").as_deref(),
        Some(r#"{"value":1}"#)
    );
    assert_eq!(
        attr_text(&tool, "ai.toolCall.result").as_deref(),
        Some(r#"{"value":1}"#)
    );
    let steps: Vec<SpanData> = collector
        .spans()
        .into_iter()
        .filter(|span| span.name == "ai.generateText.doGenerate")
        .collect();
    assert_eq!(steps.len(), 2);
    assert!(
        steps
            .iter()
            .any(|step| step.span_context.span_id() == tool.parent_span_id)
    );
    let outer = collector.span("ai.generateText");
    assert_eq!(
        attr_text(&outer, "ai.response.toolCalls").as_deref(),
        Some(r#"[{"toolCallId":"call-1","toolName":"echo","input":{"value":1}}]"#)
    );
}

#[test]
fn stringifies_file_data_as_plain_text() {
    use crate::ai::provider::{DataContent, FileData, LanguageModelV4Message, LanguageModelV4Part};
    let prompt = vec![LanguageModelV4Message::User {
        content: vec![
            LanguageModelV4Part::Text {
                text: "see".into(),
                provider_options: None,
            },
            LanguageModelV4Part::File {
                filename: None,
                data: FileData::Data {
                    data: DataContent::Bytes(vec![1u8, 2, 3].into()),
                },
                media_type: "image/png".into(),
                provider_options: None,
            },
        ],
        provider_options: None,
    }];
    assert_eq!(
        stringify_for_telemetry(&prompt),
        r#"[{"role":"user","content":[{"type":"text","text":"see"},{"type":"file","data":"AQID","mediaType":"image/png"}]}]"#
    );
}

#[test]
fn keeps_only_homogeneous_primitive_arrays() {
    assert_eq!(
        json_value(&json!(["a", null, "b"])),
        Some(OtelValue::Array(Array::String(vec![
            "a".into(),
            "b".into()
        ])))
    );
    assert_eq!(json_value(&json!(["a", 1])), None);
    assert_eq!(json_value(&json!([])), None);
    assert_eq!(
        json_value(&json!([1, 2])),
        Some(OtelValue::Array(Array::I64(vec![1, 2])))
    );
    assert_eq!(json_value(&json!(0.5)), Some(OtelValue::F64(0.5)));
    assert_eq!(json_value(&json!(2.0)), Some(OtelValue::I64(2)));
}

#[test]
fn flattens_a_nested_runtime_context() {
    let context = json!({ "user": { "id": "u1", "tags": ["a"] }, "skip": null })
        .as_object()
        .cloned()
        .unwrap();
    let attrs = base_attributes(
        "p",
        "m",
        &Settings::default(),
        Some(&context),
        &Headers::new(),
    );
    let keys: Vec<&str> = attrs.0.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        vec![
            "ai.model.provider",
            "ai.model.id",
            "ai.settings.context.user.id",
            "ai.settings.context.user.tags",
        ]
    );
}

#[test]
fn tags_media_by_its_content_hash() {
    let upload = MediaUpload::new(
        b"hello".to_vec(),
        "image/png",
        "trace".into(),
        "span".into(),
    );
    // sha256("hello") in base64 is LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=.
    assert_eq!(
        upload.sha256_hash,
        "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ="
    );
    assert_eq!(upload.media_id, "LPJNul-wow4m6Dsqxbninh");
    assert_eq!(
        upload.tag(),
        "@@@langfuseMedia:type=image/png|id=LPJNul-wow4m6Dsqxbninh|source=bytes@@@"
    );
}
