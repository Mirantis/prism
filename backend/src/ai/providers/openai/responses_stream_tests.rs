//! The stream against `testdata/openai_stream_sdk.json`: the parts `@ai-sdk/openai`
//! streamed for the same events and call options (written by
//! `testdata/openai_stream_sdk.mjs`).

use std::sync::Arc;

use bytes::Bytes;
use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::super::api::{EnvLookup, FetchFunction, FetchResponse};
use super::super::{OpenAIProviderSettings, create_openai_with_env};
use crate::ai::errors::{ApiCallError, error_name};
use crate::ai::json::js_stringify;
use crate::ai::mcp::EventSourceParser;
use crate::ai::provider::{
    LanguageModelV4CallOptions, LanguageModelV4StreamError, LanguageModelV4StreamPart,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../testdata/openai_stream_sdk.json")).unwrap()
}

/// The recorded responses the fixture names.
fn recorded(name: &str) -> &'static str {
    match name {
        "tool-call-stream.sse" => {
            include_str!("../../../lib/llm_providers/chatgpt/fixtures/tool-call-stream.sse")
        }
        "reasoning-tool-call-stream.sse" => include_str!(
            "../../../lib/llm_providers/chatgpt/fixtures/reasoning-tool-call-stream.sse"
        ),
        "reasoning-answer-stream.sse" => {
            include_str!("../../../lib/llm_providers/chatgpt/fixtures/reasoning-answer-stream.sse")
        }
        other => panic!("no recorded response {other}"),
    }
}

/// A `fetch` that records the request body and answers with the event stream.
fn fake_fetch(body: &str) -> (FetchFunction, Arc<Mutex<Option<String>>>) {
    let sent = Arc::new(Mutex::new(None));
    let sink = sent.clone();
    let body = Bytes::from(body.to_string());
    let fetch: FetchFunction = Arc::new(move |request| {
        *sink.lock() = Some(request.body);
        let response = FetchResponse {
            status: 200,
            status_text: "OK".to_string(),
            headers: [
                ("content-type", "text/event-stream"),
                ("x-request-id", "req_1"),
            ]
            .into_iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect(),
            body: body.clone(),
        };
        Box::pin(async move { Ok(response) })
    });
    (fetch, sent)
}

fn no_env() -> EnvLookup {
    Arc::new(|_| None)
}

/// The data of each event, parsed where it is JSON.
fn event_data(body: &str) -> Vec<Option<Value>> {
    EventSourceParser::new()
        .feed(body.as_bytes())
        .into_iter()
        .filter(|event| event.data != "[DONE]")
        .map(|event| serde_json::from_str(&event.data).ok())
        .collect()
}

fn error_json(err: &anyhow::Error) -> Value {
    let mut out = Map::new();
    out.insert("name".to_string(), json!(error_name(err)));
    out.insert("message".to_string(), json!(err.to_string()));
    if let Some(api) = err.downcast_ref::<ApiCallError>() {
        if let Some(status) = api.status_code {
            out.insert("statusCode".to_string(), json!(status));
        }
        out.insert("isRetryable".to_string(), json!(api.is_retryable));
        out.insert("url".to_string(), json!(api.url));
        if let Some(body) = &api.response_body {
            out.insert("responseBody".to_string(), json!(body));
        }
        if let Some(data) = &api.data {
            out.insert("data".to_string(), data.clone());
        }
    }
    Value::Object(out)
}

/// Each key with a value, in order: an object literal whose `undefined` keys
/// `JSON.stringify` leaves out.
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key.to_string(), value)))
            .collect(),
    )
}

/// A part as the SDK's fixture writes it.
fn part_json(
    part: LanguageModelV4StreamPart,
    events: &[Option<Value>],
    raw_seen: &mut usize,
) -> Value {
    use LanguageModelV4StreamPart as P;
    let some = |value: Value| Some(value);
    let metadata = |value: Option<crate::ai::provider::ProviderMetadata>| {
        value.map(|m| serde_json::to_value(m).unwrap())
    };
    match part {
        P::StreamStart { warnings } => object(vec![
            ("type", some(json!("stream-start"))),
            ("warnings", some(serde_json::to_value(warnings).unwrap())),
        ]),
        P::ResponseMetadata {
            id,
            timestamp,
            model_id,
        } => object(vec![
            ("type", some(json!("response-metadata"))),
            ("id", id.map(Value::String)),
            (
                "timestamp",
                timestamp.map(|t| json!(t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())),
            ),
            ("modelId", model_id.map(Value::String)),
        ]),
        P::TextStart {
            id,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("text-start"))),
            ("id", some(json!(id))),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::TextDelta { id, delta } => object(vec![
            ("type", some(json!("text-delta"))),
            ("id", some(json!(id))),
            ("delta", some(json!(delta))),
        ]),
        P::TextEnd {
            id,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("text-end"))),
            ("id", some(json!(id))),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::ReasoningStart {
            id,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("reasoning-start"))),
            ("id", some(json!(id))),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::ReasoningDelta {
            id,
            delta,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("reasoning-delta"))),
            ("id", some(json!(id))),
            ("delta", some(json!(delta))),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::ReasoningEnd {
            id,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("reasoning-end"))),
            ("id", some(json!(id))),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::ToolInputStart {
            id,
            tool_name,
            provider_executed,
            input_encoding,
        } => object(vec![
            ("type", some(json!("tool-input-start"))),
            ("id", some(json!(id))),
            ("toolName", some(json!(tool_name))),
            ("providerExecuted", provider_executed.map(Value::Bool)),
            ("inputEncoding", input_encoding.map(Value::String)),
        ]),
        P::ToolInputDelta { id, delta } => object(vec![
            ("type", some(json!("tool-input-delta"))),
            ("id", some(json!(id))),
            ("delta", some(json!(delta))),
        ]),
        P::ToolInputEnd {
            id,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("tool-input-end"))),
            ("id", some(json!(id))),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::Content(content) => serde_json::to_value(content).unwrap(),
        P::Finish {
            finish_reason,
            usage,
            provider_metadata,
        } => object(vec![
            ("type", some(json!("finish"))),
            (
                "finishReason",
                some(serde_json::to_value(finish_reason).unwrap()),
            ),
            ("usage", some(serde_json::to_value(usage).unwrap())),
            ("providerMetadata", metadata(provider_metadata)),
        ]),
        P::Raw { raw_value } => {
            let as_js = |value: &Option<Value>| value.as_ref().map(js_stringify);
            let is_event_data = events.get(*raw_seen).map(as_js) == Some(as_js(&raw_value));
            *raw_seen += 1;
            json!({ "type": "raw", "isEventData": is_event_data })
        }
        P::Error { error } => json!({
            "type": "error",
            "error": match error {
                LanguageModelV4StreamError::Value(value) => value,
                LanguageModelV4StreamError::Error(err) => error_json(&err),
            },
        }),
    }
}

/// A part as the comparison reads it: sources without their random ids, text ends
/// without the citations nothing here reads, and a parse error's message without
/// the cause that zod or V8 words.
fn comparable(mut part: Value) -> Value {
    let Value::Object(fields) = &mut part else {
        return part;
    };
    fields.shift_remove("citations");
    if fields.get("type") == Some(&json!("source")) {
        fields.insert("id".to_string(), json!("<id>"));
    }
    if let Some(Value::Object(error)) = fields.get_mut("error")
        && matches!(
            error.get("name").and_then(Value::as_str),
            Some("AI_TypeValidationError" | "AI_JSONParseError")
        )
        && let Some(Value::String(message)) = error.get_mut("message")
        && let Some(at) = message.find("\nError message:")
    {
        message.truncate(at);
    }
    part
}

#[tokio::test]
async fn streams_match_the_sdk() {
    for case in fixture().as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let body = match case["fixture"].as_str() {
            Some(file) => recorded(file).to_string(),
            None => case["body"].as_str().unwrap().to_string(),
        };
        let mut options = json!({
            "prompt": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }],
            "includeRawChunks": true,
        });
        for (key, value) in case["options"].as_object().unwrap() {
            options[key] = value.clone();
        }
        let options: LanguageModelV4CallOptions = serde_json::from_value(options).unwrap();
        let (fetch, sent) = fake_fetch(&body);
        let model = create_openai_with_env(
            OpenAIProviderSettings {
                api_key: Some("sk-test".to_string()),
                base_url: Some("https://api.example.com/v1".to_string()),
                fetch: Some(fetch),
                ..Default::default()
            },
            no_env(),
        )
        .language_model("gpt-6.2-sol");

        let result = model.do_stream(options).await;
        let sent = sent.lock().clone().expect("a request was sent");
        assert_eq!(sent, js_stringify(&case["sent"]), "{name}: request");
        let result = match (result, case.get("thrown")) {
            (Err(err), Some(thrown)) => {
                assert_eq!(error_json(&err), *thrown, "{name}: thrown");
                continue;
            }
            (Err(err), None) => panic!("{name}: {err}"),
            (Ok(_), Some(_)) => panic!("{name}: the SDK threw"),
            (Ok(result), None) => result,
        };
        assert_eq!(
            serde_json::to_value(result.request.unwrap()).unwrap(),
            case["request"],
            "{name}: request body"
        );
        assert_eq!(
            serde_json::to_value(result.response.unwrap().headers.unwrap()).unwrap(),
            case["responseHeaders"],
            "{name}: response headers"
        );
        let events = event_data(&body);
        let mut raw_seen = 0;
        let parts: Vec<Value> = result
            .stream
            .map(|part| comparable(part_json(part, &events, &mut raw_seen)))
            .collect()
            .await;
        let expected: Vec<Value> = case["parts"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(comparable)
            .collect();
        assert_eq!(parts.len(), expected.len(), "{name}: part count");
        for (index, (part, expected)) in parts.iter().zip(&expected).enumerate() {
            assert_eq!(part, expected, "{name}: part {index}");
        }
    }
}
