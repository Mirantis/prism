use std::collections::VecDeque;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::ai::cache::{call_key, parse_variables};
use crate::ai::errors::{ApiCallError, ToolChoiceViolationError};
use crate::ai::messages::{SystemModelMessage, ToolResultPart, UserContentPart};
use crate::ai::provider::{
    LanguageModelV4FinishReason, LanguageModelV4GenerateResult, LanguageModelV4InputTokens,
    LanguageModelV4OutputTokens, LanguageModelV4Usage, ToolResultContentPart,
};
use crate::ai::tool::{
    execute_fn, json_schema, on_input_available_fn, to_model_output_fn, tool, zod_schema,
};

const GOLDEN: &str = include_str!("testdata/sdk_golden.json");

/// A model that answers from a script and records what it was sent.
struct Scripted {
    responses: Mutex<VecDeque<anyhow::Result<LanguageModelV4GenerateResult>>>,
    calls: Mutex<Vec<LanguageModelV4CallOptions>>,
}

impl Scripted {
    fn new(responses: Vec<anyhow::Result<LanguageModelV4GenerateResult>>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into()),
            calls: Mutex::new(Vec::new()),
        })
    }

    fn call(&self, i: usize) -> LanguageModelV4CallOptions {
        self.calls.lock()[i].clone()
    }
}

#[async_trait]
impl LanguageModel for Scripted {
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
        self.calls.lock().push(options);
        self.responses
            .lock()
            .pop_front()
            .unwrap_or_else(|| Ok(text_response("fallback")))
    }
}

fn usage(input: i64, output: i64) -> LanguageModelV4Usage {
    LanguageModelV4Usage {
        input_tokens: LanguageModelV4InputTokens {
            total: Some(input),
            no_cache: Some(input),
            ..Default::default()
        },
        output_tokens: LanguageModelV4OutputTokens {
            total: Some(output),
            text: Some(output),
            ..Default::default()
        },
        raw: None,
    }
}

fn response(
    content: Vec<LanguageModelV4Content>,
    finish: FinishReason,
) -> LanguageModelV4GenerateResult {
    LanguageModelV4GenerateResult {
        content,
        finish_reason: LanguageModelV4FinishReason {
            unified: finish,
            raw: None,
        },
        usage: usage(3, 4),
        provider_metadata: None,
        request: None,
        response: None,
        warnings: vec![],
    }
}

fn text_response(text: &str) -> LanguageModelV4GenerateResult {
    response(
        vec![LanguageModelV4Content::Text {
            text: text.into(),
            provider_metadata: None,
        }],
        FinishReason::Stop,
    )
}

fn call(id: &str, name: &str, input: &str) -> LanguageModelV4Content {
    LanguageModelV4Content::ToolCall {
        tool_call_id: id.into(),
        tool_name: name.into(),
        input: input.into(),
        provider_executed: None,
        dynamic: None,
        provider_metadata: None,
    }
}

fn tool_response(calls: Vec<LanguageModelV4Content>) -> LanguageModelV4GenerateResult {
    response(calls, FinishReason::ToolCalls)
}

fn weather_schema() -> Schema {
    zod_schema(json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": { "city": { "type": "string" }, "unit": { "default": "c", "type": "string" } },
        "required": ["city"],
        "additionalProperties": false
    }))
}

fn options_of(value: Value) -> Option<ProviderOptions> {
    value.as_object().cloned()
}

fn golden_tools() -> ToolSet {
    let mut tools = ToolSet::new();
    tools.insert(
        "weather".into(),
        tool(Tool {
            description: Some("w".into()),
            input_schema: weather_schema(),
            execute: Some(execute_fn(|input, _| async move {
                Ok(json!({ "ok": input, "at": "2026-11-06T10:00:00.000Z" }))
            })),
            ..Default::default()
        }),
    );
    tools.insert(
        "boom".into(),
        tool(Tool {
            input_schema: zod_schema(json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {},
                "additionalProperties": false
            })),
            execute: Some(execute_fn(
                |_, _| async move { Err(anyhow::anyhow!("kaboom")) },
            )),
            ..Default::default()
        }),
    );
    tools.insert(
        "raw".into(),
        tool(Tool {
            description: Some("r".into()),
            input_schema: json_schema(
                json!({ "type": "object", "properties": { "n": { "type": "number" } } }),
            ),
            provider_options: options_of(json!({ "anthropic": { "deferLoading": true } })),
            execute: Some(execute_fn(|_, _| async move { Ok(json!("text out")) })),
            ..Default::default()
        }),
    );
    tools
}

fn golden_messages() -> Vec<ModelMessage> {
    vec![
        ModelMessage::user("see /tmp/abc.def/x and 0f8fad5b-d9cb-469f-a165-70867728950e"),
        ModelMessage::assistant_parts(vec![
            AssistantContentPart::Text(TextPart::new("ok")),
            AssistantContentPart::ToolCall(ToolCallPart {
                tool_call_id: "p1".into(),
                tool_name: "raw".into(),
                input: json!({ "n": 1.5 }),
                provider_executed: None,
                provider_options: None,
            }),
        ]),
        ModelMessage::tool(vec![ToolContentPart::ToolResult(ToolResultPart {
            tool_call_id: "p1".into(),
            tool_name: "raw".into(),
            output: ToolResultOutput::Content {
                value: vec![
                    ToolResultContentPart::Text {
                        text: "shot".into(),
                        provider_options: None,
                    },
                    ToolResultContentPart::ImageData {
                        data: "iVBORw0KGgo=".into(),
                        media_type: "image/jpeg".into(),
                        provider_options: None,
                    },
                ],
            },
            provider_options: None,
        })]),
        ModelMessage::user_parts(vec![
            UserContentPart::Text(TextPart::new("pdf")),
            UserContentPart::File(FilePart {
                data: FilePartData::from(vec![0x25u8, 0x50, 0x44, 0x46, 0x2d]),
                filename: Some("a.pdf".into()),
                media_type: "application/pdf".into(),
                provider_options: options_of(
                    json!({ "bedrock": { "citations": { "enabled": true } } }),
                ),
            }),
        ]),
    ]
}

fn without_headers(options: &LanguageModelV4CallOptions) -> Value {
    let mut value = serde_json::to_value(options).unwrap();
    value.as_object_mut().unwrap().remove("headers");
    value
}

#[tokio::test]
async fn sends_what_the_sdk_sends_and_keys_it_as_the_cache_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let model = Scripted::new(vec![
        Ok(response(
            vec![
                LanguageModelV4Content::Text {
                    text: "hi".into(),
                    provider_metadata: None,
                },
                call("c1", "weather", "{\"city\":1}"),
                call("c2", "nope", "{}"),
                call("c3", "boom", ""),
                call("c4", "weather", "{\"zz\": 1, \"city\":\"x\"}"),
                call("c5", "weather", "{\"city\":"),
            ],
            FinishReason::ToolCalls,
        )),
        Ok(text_response("done")),
    ]);
    let mut options = GenerateTextOptions::new(model.clone());
    options.system = Some(Instructions::Messages(vec![SystemModelMessage {
        content: "You are kind. Today's date (UTC): 2026-11-06 (Friday)".into(),
        provider_options: options_of(
            json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } }),
        ),
    }]));
    options.tools = Some(golden_tools());
    options.messages = Some(golden_messages());
    options.temperature = Some(0.7);
    options.max_output_tokens = Some(16000);
    options.provider_options = options_of(
        json!({ "anthropic": { "thinking": { "type": "adaptive" } }, "bedrock": { "10": 1, "9": 2, "b": 3, "a": 4 } }),
    );
    options.tool_choice = Some(ToolChoice::Auto);
    options.stop_when = Some(vec![step_count_is(5)]);

    let result = generate_text(options).await.unwrap();

    assert_eq!(
        without_headers(&model.call(0)),
        golden["firstOptionsSorted"]
    );
    assert_eq!(
        serde_json::to_value(&model.call(1).prompt).unwrap(),
        golden["secondPrompt"]
    );
    assert_eq!(
        model
            .call(0)
            .headers
            .unwrap()
            .get("user-agent")
            .map(String::as_str),
        Some("ai/7.0.137")
    );

    let variables = parse_variables(&golden["variables"].to_string()).unwrap();
    for i in 0..2 {
        let (key, bindings) = call_key(&model.call(i), &variables).unwrap();
        assert_eq!(
            key,
            golden["keys"][i]["key"].as_str().unwrap(),
            "key of call {i}"
        );
        let expected: Vec<(String, String)> =
            serde_json::from_value(golden["bindings"][i].clone()).unwrap();
        assert_eq!(bindings, expected);
    }

    assert_eq!(result.steps.len(), 2);
    assert_eq!(
        serde_json::to_value(&result.total_usage).unwrap(),
        golden["totalUsage"]
    );
    let calls: Vec<Value> = result.steps[0]
        .tool_calls()
        .into_iter()
        .map(|c| {
            let mut v = serde_json::to_value(c).unwrap();
            v.as_object_mut().unwrap().remove("error");
            let mut tagged = serde_json::Map::new();
            tagged.insert("type".into(), json!("tool-call"));
            tagged.extend(v.as_object().unwrap().clone());
            Value::Object(tagged)
        })
        .collect();
    assert_eq!(Value::Array(calls), golden["toolCalls"]);
    assert_eq!(
        serde_json::to_value(&result.response().messages).unwrap(),
        golden["responseMessages"]
    );
    assert_eq!(result.text(), "done");
    assert_eq!(result.finish_reason(), FinishReason::Stop);
    assert_eq!(result.output().unwrap(), "done");
}

#[tokio::test]
async fn keeps_tool_errors_with_their_original_error() {
    let model = Scripted::new(vec![
        Ok(tool_response(vec![call("c1", "boom", "{}")])),
        Ok(text_response("ok")),
    ]);
    let mut tools = ToolSet::new();
    tools.insert(
        "boom".into(),
        Tool {
            execute: Some(execute_fn(|_, _| async move {
                Err(anyhow::Error::new(ApiCallError::new(
                    "down",
                    "u",
                    json!({}),
                    Some(500),
                    None,
                    None,
                )))
            })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(3)]);
    let result = generate_text(options).await.unwrap();
    let error = result.steps[0]
        .content
        .iter()
        .find_map(|p| match p {
            ContentPart::ToolError(e) => Some(e.clone()),
            _ => None,
        })
        .unwrap();
    assert!(error.error.downcast_ref::<ApiCallError>().is_some());
    assert_eq!(error.dynamic, Some(false));
    let tool_message = serde_json::to_value(&model.call(1).prompt[2]).unwrap();
    assert_eq!(
        tool_message["content"][0]["output"],
        json!({ "type": "error-text", "value": "AI_APICallError: down" })
    );
}

#[tokio::test]
async fn stops_at_the_step_count() {
    let responses = (0..5)
        .map(|i| Ok(tool_response(vec![call(&format!("c{i}"), "echo", "{}")])))
        .collect();
    let model = Scripted::new(responses);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(3)]);
    let result = generate_text(options).await.unwrap();
    assert_eq!(result.steps.len(), 3);
    assert_eq!(model.calls.lock().len(), 3);
    assert_eq!(result.total_usage.input_tokens, Some(9));
    assert_eq!(result.finish_reason(), FinishReason::ToolCalls);
    assert!(result.output().is_err());
}

#[tokio::test]
async fn runs_one_step_by_default_and_ends_when_no_tool_runs() {
    let model = Scripted::new(vec![Ok(tool_response(vec![call("c1", "echo", "{}")]))]);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools.clone());
    options.prompt = Some("go".into());
    let result = generate_text(options).await.unwrap();
    assert_eq!(result.steps.len(), 1);
    assert_eq!(result.steps[0].tool_results().len(), 1);

    let model = Scripted::new(vec![Ok(tool_response(vec![call("c1", "client", "{}")]))]);
    let mut tools = ToolSet::new();
    tools.insert("client".into(), Tool::default());
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(10)]);
    let result = generate_text(options).await.unwrap();
    assert_eq!(
        result.steps.len(),
        1,
        "a tool without execute ends the loop"
    );

    let mut truncated = tool_response(vec![call("c1", "echo", "{}")]);
    truncated.finish_reason.unified = FinishReason::Length;
    let model = Scripted::new(vec![Ok(truncated)]);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(10)]);
    let result = generate_text(options).await.unwrap();
    assert_eq!(result.steps.len(), 1);
    assert!(
        result.steps[0].tool_results().is_empty(),
        "a cut-off step runs no tool"
    );
}

#[tokio::test]
async fn announces_every_call_before_any_runs_and_runs_them_together() {
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let model = Scripted::new(vec![
        Ok(tool_response(vec![
            call("a", "slow", "{}"),
            call("b", "slow", "{}"),
        ])),
        Ok(text_response("ok")),
    ]);
    let (log_available, log_execute) = (log.clone(), log.clone());
    let mut tools = ToolSet::new();
    tools.insert(
        "slow".into(),
        Tool {
            on_input_available: Some(on_input_available_fn(move |_, options| {
                let log = log_available.clone();
                async move {
                    log.lock()
                        .push(format!("available {}", options.tool_call_id));
                    Ok(())
                }
            })),
            execute: Some(execute_fn(move |_, options| {
                let log = log_execute.clone();
                async move {
                    log.lock().push(format!("start {}", options.tool_call_id));
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    log.lock().push(format!("end {}", options.tool_call_id));
                    Ok(json!(options.tool_call_id))
                }
            })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(2)]);
    generate_text(options).await.unwrap();
    assert_eq!(
        *log.lock(),
        vec![
            "available a",
            "available b",
            "start a",
            "start b",
            "end a",
            "end b"
        ]
    );
}

#[tokio::test]
async fn shows_the_model_what_to_model_output_returns() {
    let model = Scripted::new(vec![
        Ok(tool_response(vec![call("c1", "shot", "{}")])),
        Ok(text_response("ok")),
    ]);
    let mut tools = ToolSet::new();
    tools.insert(
        "shot".into(),
        Tool {
            execute: Some(execute_fn(|_, _| async move { Ok(json!({ "pixels": 3 })) })),
            to_model_output: Some(to_model_output_fn(|options| async move {
                Ok(ToolResultOutput::text(format!(
                    "{} pixels",
                    options.output["pixels"]
                )))
            })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(2)]);
    let result = generate_text(options).await.unwrap();
    let sent = serde_json::to_value(&model.call(1).prompt).unwrap();
    assert_eq!(
        sent[2]["content"][0]["output"],
        json!({ "type": "text", "value": "3 pixels" })
    );
    assert_eq!(
        result.steps[0].tool_results()[0].output,
        json!({ "pixels": 3 })
    );
}

#[tokio::test]
async fn lets_prepare_step_change_the_messages_and_options_of_a_step() {
    let model = Scripted::new(vec![
        Ok(tool_response(vec![call("c1", "echo", "{}")])),
        Ok(text_response("ok")),
    ]);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let seen: Arc<Mutex<Vec<(usize, usize, usize)>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_in_hook = seen.clone();
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(2)]);
    options.prepare_step = Some(Arc::new(move |step: PrepareStepOptions| {
        let seen = seen_in_hook.clone();
        Box::pin(async move {
            seen.lock().push((
                step.step_number,
                step.initial_messages.len(),
                step.response_messages.len(),
            ));
            let mut messages: Vec<ModelMessage> = step.initial_messages.clone();
            messages.extend(step.response_messages.clone());
            if let Some(last) = messages.last_mut() {
                *last.provider_options_mut() =
                    options_of(json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } }));
            }
            Ok(Some(PrepareStepResult {
                messages: Some(messages),
                provider_options: options_of(json!({ "anthropic": { "effort": "low" } })),
                max_output_tokens: Some(100),
                ..Default::default()
            }))
        })
    }));
    options.provider_options =
        options_of(json!({ "anthropic": { "thinking": { "type": "adaptive" } } }));
    generate_text(options).await.unwrap();

    assert_eq!(*seen.lock(), vec![(0, 1, 0), (1, 1, 2)]);
    let second = serde_json::to_value(&model.call(1)).unwrap();
    assert_eq!(second["maxOutputTokens"], 100);
    assert_eq!(
        second["providerOptions"],
        json!({ "anthropic": { "thinking": { "type": "adaptive" }, "effort": "low" } })
    );
    assert_eq!(
        second["prompt"][2]["providerOptions"],
        json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } })
    );
    assert!(second["prompt"][1].get("providerOptions").is_none());
}

#[tokio::test]
async fn calls_on_step_finish_once_a_step() {
    let model = Scripted::new(vec![
        Ok(tool_response(vec![call("c1", "echo", "{}")])),
        Ok(text_response("done")),
    ]);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let texts: Arc<Mutex<Vec<(usize, String, usize)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = texts.clone();
    let mut options = GenerateTextOptions::new(model);
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(5)]);
    options.on_step_finish = Some(Arc::new(move |step: Arc<StepResult>| {
        let sink = sink.clone();
        Box::pin(async move {
            sink.lock()
                .push((step.step_number, step.text(), step.tool_calls().len()));
        })
    }));
    generate_text(options).await.unwrap();
    assert_eq!(
        *texts.lock(),
        vec![(0, String::new(), 1), (1, "done".to_string(), 0)]
    );
}

#[tokio::test(start_paused = true)]
async fn retries_an_overloaded_model_with_backoff() {
    let overloaded = || -> anyhow::Result<LanguageModelV4GenerateResult> {
        Err(ApiCallError::new("Overloaded", "https://x", json!({}), Some(529), None, None).into())
    };
    let model = Scripted::new(vec![overloaded(), overloaded(), Ok(text_response("ok"))]);
    let mut options = GenerateTextOptions::new(model.clone());
    options.prompt = Some("go".into());
    let started = tokio::time::Instant::now();
    let result = generate_text(options).await.unwrap();
    assert_eq!(result.text(), "ok");
    assert_eq!(model.calls.lock().len(), 3);
    assert_eq!(started.elapsed(), Duration::from_secs(6));
}

#[tokio::test]
async fn stops_before_the_next_step_when_aborted() {
    let token = CancellationToken::new();
    let cancel = token.clone();
    let model = Scripted::new(vec![
        Ok(tool_response(vec![call("c1", "stop", "{}")])),
        Ok(text_response("never")),
    ]);
    let mut tools = ToolSet::new();
    tools.insert(
        "stop".into(),
        Tool {
            execute: Some(execute_fn(move |_, _| {
                let cancel = cancel.clone();
                async move {
                    cancel.cancel();
                    Ok(json!("stopped"))
                }
            })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model.clone());
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(5)]);
    options.abort_signal = Some(token);
    let err = generate_text(options).await.unwrap_err();
    assert!(crate::ai::errors::is_abort_error(&err));
    assert_eq!(model.calls.lock().len(), 1);
}

#[tokio::test]
async fn refuses_an_answer_without_the_required_tool_call() {
    let model = Scripted::new(vec![Ok(text_response("no tool"))]);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model);
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.tool_choice = Some(ToolChoice::Required);
    let err = generate_text(options).await.unwrap_err();
    assert_eq!(
        err.downcast_ref::<ToolChoiceViolationError>()
            .unwrap()
            .message,
        "Model response did not contain a tool call even though tool choice was required."
    );
}

#[tokio::test]
async fn sends_no_tools_and_auto_choice_when_there_are_none() {
    let model = Scripted::new(vec![Ok(text_response("hi"))]);
    let mut options = GenerateTextOptions::new(model.clone());
    options.system = Some("be brief".into());
    options.prompt = Some("hello".into());
    generate_text(options).await.unwrap();
    let sent = without_headers(&model.call(0));
    assert_eq!(
        crate::ai::json::js_stringify(&sent),
        r#"{"toolChoice":{"type":"auto"},"prompt":[{"role":"system","content":"be brief"},{"role":"user","content":[{"type":"text","text":"hello"}]}]}"#
    );
}

#[tokio::test]
async fn refuses_a_prompt_with_both_prompt_and_messages() {
    let model = Scripted::new(vec![]);
    let mut options = GenerateTextOptions::new(model);
    options.prompt = Some("a".into());
    options.messages = Some(vec![ModelMessage::user("b")]);
    let err = generate_text(options).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "Invalid prompt: prompt and messages cannot be defined at the same time"
    );
}

/// Records the hooks it is called at.
struct Recorder {
    events: Mutex<Vec<String>>,
}

impl crate::ai::telemetry::Telemetry for Recorder {
    fn on_start(
        &self,
        event: &crate::ai::telemetry::OperationStartEvent,
        meta: &crate::ai::telemetry::TelemetryMeta,
    ) {
        if let crate::ai::telemetry::OperationStartEvent::GenerateText(start) = event {
            self.events.lock().push(format!(
                "start {} {} {:?} {}",
                start.operation_id,
                meta.function_id.clone().unwrap_or_default(),
                start.runtime_context.keys().collect::<Vec<_>>(),
                meta.record_inputs == Some(false)
            ));
        }
    }
    fn on_step_start(
        &self,
        event: &GenerateTextStepStartEvent,
        _: &crate::ai::telemetry::TelemetryMeta,
    ) {
        self.events
            .lock()
            .push(format!("step {}", event.step_number));
    }
    fn on_language_model_call_start(
        &self,
        _: &LanguageModelCallStartEvent,
        _: &crate::ai::telemetry::TelemetryMeta,
    ) {
        self.events.lock().push("call".into());
    }
    fn on_language_model_call_end(
        &self,
        event: &LanguageModelCallEndEvent,
        _: &crate::ai::telemetry::TelemetryMeta,
    ) {
        self.events
            .lock()
            .push(format!("call end {}", event.finish_reason.as_str()));
    }
    fn on_tool_execution_start(
        &self,
        event: &ToolExecutionStartEvent,
        _: &crate::ai::telemetry::TelemetryMeta,
    ) {
        self.events
            .lock()
            .push(format!("tool {}", event.tool_call.tool_name));
    }
    fn on_tool_execution_end(
        &self,
        event: &ToolExecutionEndEvent,
        _: &crate::ai::telemetry::TelemetryMeta,
    ) {
        self.events
            .lock()
            .push(format!("tool end {}", event.tool_output.tool_call_id()));
    }
    fn on_step_end(&self, event: &StepResult, _: &crate::ai::telemetry::TelemetryMeta) {
        self.events
            .lock()
            .push(format!("step end {}", event.step_number));
    }
    fn on_end(&self, event: &OperationEndEvent, _: &crate::ai::telemetry::TelemetryMeta) {
        if let OperationEndEvent::GenerateText(end) = event {
            self.events.lock().push(format!(
                "end {}",
                end.total_usage.total_tokens.unwrap_or_default()
            ));
        }
    }
}

#[tokio::test]
async fn reports_each_span_point_to_telemetry() {
    let recorder = Arc::new(Recorder {
        events: Mutex::new(Vec::new()),
    });
    let model = Scripted::new(vec![
        Ok(tool_response(vec![call("c1", "echo", "{}")])),
        Ok(text_response("done")),
    ]);
    let mut tools = ToolSet::new();
    tools.insert(
        "echo".into(),
        Tool {
            execute: Some(execute_fn(|i, _| async move { Ok(i) })),
            ..Default::default()
        },
    );
    let mut options = GenerateTextOptions::new(model);
    options.tools = Some(tools);
    options.prompt = Some("go".into());
    options.stop_when = Some(vec![step_count_is(5)]);
    options.runtime_context = json!({ "userId": "u", "secret": "s" })
        .as_object()
        .cloned()
        .unwrap();
    options.telemetry = Some(TelemetryOptions {
        is_enabled: Some(true),
        function_id: Some("invoke-chat".into()),
        record_inputs: Some(false),
        include_runtime_context: Some([("userId".to_string(), true)].into_iter().collect()),
        integrations: Some(vec![
            recorder.clone() as Arc<dyn crate::ai::telemetry::Telemetry>
        ]),
        ..Default::default()
    });
    generate_text(options).await.unwrap();
    assert_eq!(
        *recorder.events.lock(),
        vec![
            "start ai.generateText invoke-chat [\"userId\"] true",
            "step 0",
            "call",
            "call end tool-calls",
            "tool echo",
            "tool end c1",
            "step end 0",
            "step 1",
            "call",
            "call end stop",
            "step end 1",
            "end 14",
        ]
    );

    let silent = Arc::new(Recorder {
        events: Mutex::new(Vec::new()),
    });
    let mut options = GenerateTextOptions::new(Scripted::new(vec![Ok(text_response("x"))]));
    options.prompt = Some("go".into());
    options.telemetry = Some(TelemetryOptions {
        is_enabled: Some(false),
        integrations: Some(vec![
            silent.clone() as Arc<dyn crate::ai::telemetry::Telemetry>
        ]),
        ..Default::default()
    });
    generate_text(options).await.unwrap();
    assert!(silent.events.lock().is_empty());
}
