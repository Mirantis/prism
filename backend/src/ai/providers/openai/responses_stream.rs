//! The Responses API's streamed call (`doStream`): the request with `stream: true`,
//! its server-sent events checked as `openaiResponsesChunkSchema` checks them, and
//! the stream parts they give.
//!
//! The port covers the items the runtime's requests produce: messages, reasoning,
//! function and custom tool calls, client tool search and compaction. The events
//! of hosted tools, which the request refuses, give no parts. `fetch` reads the
//! whole body, so the parts are produced once the response has ended.

use std::collections::{BTreeMap, HashMap};

use futures::StreamExt;
use serde_json::{Map, Value};

use super::api::{
    FetchResponse, combine_headers, generate_id, openai_failed_response_error, post_json,
};
use super::responses::{
    OpenAIConfig, PARALLEL_TOOL_NAME, PreparedRequest, annotation_in_schema_order,
    annotation_source, check_usage, convert_usage, expand_parallel_tool_call, invalid, is_array,
    is_bool, is_number, is_object, is_string, is_string_or_null, map_finish_reason, metadata_under,
    optional, prepare_request, required, string, timestamp_of,
};
use super::responses_input::is_truthy;
use crate::ai::errors::{ApiCallError, JsonParseError, TypeValidationError};
use crate::ai::json::{js_stringify, secure_json_parse};
use crate::ai::mcp::EventSourceParser;
use crate::ai::provider::{
    FinishReason, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4FinishReason,
    LanguageModelV4FunctionTool, LanguageModelV4Request, LanguageModelV4Response,
    LanguageModelV4StreamError, LanguageModelV4StreamPart, LanguageModelV4StreamResult,
    LanguageModelV4Tool, ProviderMetadata,
};
use crate::ai::providers::provider_utils::ToolNameMapping;

/// `doStream`.
pub(super) async fn do_stream(
    model_id: &str,
    config: &OpenAIConfig,
    options: LanguageModelV4CallOptions,
) -> anyhow::Result<LanguageModelV4StreamResult> {
    let PreparedRequest {
        args: body,
        warnings,
        tool_name_mapping,
        provider_options_name,
        store,
    } = prepare_request(model_id, config, &options)?;
    let url = (config.url)("/responses", model_id)?;

    let mut streamed_body = body.clone();
    if let Value::Object(fields) = &mut streamed_body {
        fields.insert("stream".to_string(), Value::Bool(true));
    }
    let provider_headers = (config.headers)()?;
    let headers = combine_headers(&[Some(&provider_headers), options.headers.as_ref()]);
    let response = post_json(
        &url,
        &headers,
        &streamed_body,
        options.abort_signal.as_ref(),
        &config.fetch,
        config.provider_utils_version,
    )
    .await?;
    if !response.ok() {
        return Err(openai_failed_response_error(
            &response,
            &url,
            &streamed_body,
        ));
    }

    let chunks = parse_event_stream(&response);
    throw_if_error_before_output(&chunks, &url, &body, &response)?;

    let function_tools: Vec<&LanguageModelV4FunctionTool> = options
        .tools
        .iter()
        .flatten()
        .filter_map(|tool| match tool {
            LanguageModelV4Tool::Function(tool) => Some(tool),
            LanguageModelV4Tool::Provider(_) => None,
        })
        .collect();
    let wants_logprobs = options
        .provider_options
        .as_ref()
        .and_then(|o| o.get(&provider_options_name))
        .and_then(|o| o.get("logprobs"))
        .is_some_and(is_truthy);
    let mut transform = Transform {
        name: &provider_options_name,
        tool_name_mapping: &tool_name_mapping,
        function_tools: &function_tools,
        store: store == Some(true),
        wants_logprobs,
        url: &url,
        body: &body,
        response: &response,
        parts: vec![LanguageModelV4StreamPart::StreamStart { warnings }],
        state: State::default(),
    };
    for chunk in chunks {
        if options.include_raw_chunks == Some(true) {
            transform.parts.push(LanguageModelV4StreamPart::Raw {
                raw_value: chunk.raw.clone(),
            });
        }
        transform.chunk(chunk);
    }
    transform.flush();

    Ok(LanguageModelV4StreamResult {
        stream: futures::stream::iter(transform.parts).boxed(),
        request: Some(LanguageModelV4Request {
            body: Some(body.clone()),
        }),
        response: Some(LanguageModelV4Response {
            headers: Some(response.headers.clone()),
            ..Default::default()
        }),
    })
}

/// One event: its data as parsed JSON (`None` when it is not JSON), and the chunk
/// the schema made of it.
struct Chunk {
    raw: Option<Value>,
    parsed: anyhow::Result<Parsed>,
}

/// A chunk that matched the schema. `kind` is its `type`, or `unknown_chunk` for an
/// event the schema does not model; `value` keeps only the keys the schema reads
/// where the SDK hands the chunk on.
struct Parsed {
    kind: String,
    value: Value,
}

/// `parseJsonEventStream`: each event's data, `[DONE]` left out.
fn parse_event_stream(response: &FetchResponse) -> Vec<Chunk> {
    let mut parser = EventSourceParser::new();
    parser
        .feed(&response.body)
        .into_iter()
        .filter(|event| event.data != "[DONE]")
        .map(|event| match secure_json_parse(&event.data) {
            Err(cause) => Chunk {
                raw: None,
                parsed: Err(JsonParseError::new(event.data, anyhow::Error::new(cause)).into()),
            },
            Ok(value) => {
                let parsed = parse_chunk(&value)
                    .map_err(|cause| TypeValidationError::new(value.clone(), cause, None).into());
                Chunk {
                    raw: Some(value),
                    parsed,
                }
            }
        })
        .collect()
}

/// The chunk types the schema models.
const MODELED_CHUNK_TYPES: &[&str] = &[
    "error",
    "response.apply_patch_call_operation_diff.delta",
    "response.apply_patch_call_operation_diff.done",
    "response.code_interpreter_call_code.delta",
    "response.code_interpreter_call_code.done",
    "response.completed",
    "response.created",
    "response.custom_tool_call_input.delta",
    "response.failed",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.image_generation_call.partial_image",
    "response.in_progress",
    "response.incomplete",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_text.annotation.added",
    "response.output_text.delta",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.delta",
];

/// The output item types both output item events model.
const MODELED_ITEM_TYPES: &[&str] = &[
    "apply_patch_call",
    "code_interpreter_call",
    "compaction",
    "computer_call",
    "custom_tool_call",
    "file_search_call",
    "function_call",
    "image_generation_call",
    "local_shell_call",
    "mcp_approval_request",
    "mcp_call",
    "mcp_list_tools",
    "message",
    "program",
    "program_output",
    "reasoning",
    "shell_call",
    "shell_call_output",
    "tool_search_call",
    "tool_search_output",
    "web_search_call",
];

/// `{ key: value }` for each key of `keys` the object has, in that order: what zod
/// returns for an object schema.
fn pick(object: &Map<String, Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = object.get(*key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(out)
}

fn object_of(value: &Value) -> &Map<String, Value> {
    value.as_object().expect("an object")
}

/// `openaiResponsesChunkSchema`.
fn parse_chunk(value: &Value) -> anyhow::Result<Parsed> {
    let Value::Object(chunk) = value else {
        return Err(invalid("the chunk is not an object"));
    };
    let kind = required(chunk, "type", is_string)?
        .as_str()
        .unwrap_or_default();
    if !MODELED_CHUNK_TYPES.contains(&kind) {
        return Ok(unknown());
    }
    let parsed = |value: Value| {
        Ok(Parsed {
            kind: kind.to_string(),
            value,
        })
    };
    match kind {
        "response.output_text.delta" => {
            required(chunk, "item_id", is_string)?;
            optional(chunk, "output_index", true, is_number)?;
            required(chunk, "delta", is_string)?;
            if let Some(logprobs) = optional(chunk, "logprobs", true, is_array)? {
                for logprob in logprobs.as_array().expect("an array") {
                    check_logprob(logprob, true)?;
                }
            }
            parsed(value.clone())
        }
        "response.completed" | "response.incomplete" => {
            let response = required(chunk, "response", is_object)?;
            check_finished_response(object_of(response))?;
            parsed(value.clone())
        }
        "response.failed" => {
            required(chunk, "sequence_number", is_number)?;
            let response = object_of(required(chunk, "response", is_object)?);
            let mut stripped = Map::new();
            if let Some(error) = response.get("error") {
                let error = match error {
                    Value::Null => Value::Null,
                    Value::Object(error) => {
                        optional(error, "code", true, is_string)?;
                        required(error, "message", is_string)?;
                        pick(error, &["code", "message"])
                    }
                    _ => return Err(invalid("invalid error")),
                };
                stripped.insert("error".to_string(), error);
            }
            check_finished_response(response)?;
            for key in ["incomplete_details", "usage", "reasoning", "service_tier"] {
                if let Some(field) = response.get(key) {
                    let field = match (key, field) {
                        ("incomplete_details", Value::Object(details)) => {
                            pick(details, &["reason"])
                        }
                        ("reasoning", Value::Object(reasoning)) => pick(reasoning, &["context"]),
                        _ => field.clone(),
                    };
                    stripped.insert(key.to_string(), field);
                }
            }
            let mut out = Map::new();
            out.insert("type".to_string(), string(kind));
            out.insert(
                "sequence_number".to_string(),
                chunk["sequence_number"].clone(),
            );
            out.insert("response".to_string(), Value::Object(stripped));
            parsed(Value::Object(out))
        }
        "response.created" | "response.in_progress" => {
            let response = object_of(required(chunk, "response", is_object)?);
            required(response, "id", is_string)?;
            required(response, "created_at", is_number)?;
            required(response, "model", is_string)?;
            optional(response, "service_tier", true, is_string)?;
            parsed(value.clone())
        }
        "response.output_item.added" | "response.output_item.done" => {
            let item = chunk.get("item").and_then(Value::as_object);
            let item_type = item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str);
            if let Some(item_type) = item_type
                && !MODELED_ITEM_TYPES.contains(&item_type)
            {
                return Ok(unknown());
            }
            required(chunk, "output_index", is_number)?;
            let (Some(item), Some(item_type)) = (item, item_type) else {
                return Err(invalid("invalid item"));
            };
            check_item(item, item_type, kind == "response.output_item.done")?;
            parsed(value.clone())
        }
        "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" => {
            required(chunk, "item_id", is_string)?;
            required(chunk, "output_index", is_number)?;
            required(chunk, "delta", is_string)?;
            parsed(value.clone())
        }
        "response.function_call_arguments.done" => {
            required(chunk, "item_id", is_string)?;
            required(chunk, "output_index", is_number)?;
            required(chunk, "arguments", is_string)?;
            parsed(value.clone())
        }
        "response.output_text.annotation.added" => {
            let annotation = chunk
                .get("annotation")
                .and_then(annotation_in_schema_order)
                .ok_or_else(|| invalid("invalid annotation"))?;
            let mut out = chunk.clone();
            out.insert("annotation".to_string(), annotation);
            parsed(Value::Object(out))
        }
        "response.reasoning_summary_part.added"
        | "response.reasoning_summary_part.done"
        | "response.reasoning_summary_text.delta" => {
            required(chunk, "item_id", is_string)?;
            optional(chunk, "output_index", true, is_number)?;
            required(chunk, "summary_index", is_number)?;
            if kind == "response.reasoning_summary_text.delta" {
                required(chunk, "delta", is_string)?;
            }
            parsed(value.clone())
        }
        "error" => parsed(parse_error_chunk(chunk)?),
        // The events of hosted tools, which give no parts.
        _ => parsed(value.clone()),
    }
}

fn unknown() -> Parsed {
    Parsed {
        kind: "unknown_chunk".to_string(),
        value: Value::Null,
    }
}

/// A log probability, with its alternatives when `top` is set; `top_logprobs`
/// entries have none.
fn check_logprob(logprob: &Value, top: bool) -> anyhow::Result<()> {
    let Value::Object(logprob) = logprob else {
        return Err(invalid("invalid logprobs"));
    };
    required(logprob, "token", is_string)?;
    required(logprob, "logprob", is_number)?;
    if top {
        for alternative in required(logprob, "top_logprobs", is_array)?
            .as_array()
            .expect("an array")
        {
            check_logprob(alternative, false)?;
        }
    }
    Ok(())
}

/// A log probability as zod returns it: `token`, `logprob` and `top_logprobs`.
fn strip_logprobs(logprobs: &Value) -> Value {
    let strip = |logprob: &Value, keys: &[&str]| pick(object_of(logprob), keys);
    Value::Array(
        logprobs
            .as_array()
            .into_iter()
            .flatten()
            .map(|logprob| {
                let mut stripped = strip(logprob, &["token", "logprob"]);
                let top = logprob["top_logprobs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|alternative| strip(alternative, &["token", "logprob"]))
                    .collect();
                stripped
                    .as_object_mut()
                    .expect("an object")
                    .insert("top_logprobs".to_string(), Value::Array(top));
                stripped
            })
            .collect(),
    )
}

/// The `response` of `response.completed`, `response.incomplete` and
/// `response.failed`, past its `error`.
fn check_finished_response(response: &Map<String, Value>) -> anyhow::Result<()> {
    if let Some(details) = optional(response, "incomplete_details", true, is_object)? {
        required(object_of(details), "reason", is_string)?;
    }
    if let Some(usage) = optional(response, "usage", true, is_object)? {
        check_usage(object_of(usage))?;
    }
    if let Some(reasoning) = optional(response, "reasoning", true, is_object)? {
        optional(object_of(reasoning), "context", true, is_string)?;
    }
    optional(response, "service_tier", true, is_string)?;
    Ok(())
}

/// An output item of a type the runtime's requests produce, as the added (`done`
/// false) or done event's schema checks it. Hosted tools' items pass unchecked.
fn check_item(item: &Map<String, Value>, kind: &str, done: bool) -> anyhow::Result<()> {
    let statuses = |key: &str, allowed: &[&str]| -> anyhow::Result<()> {
        match item.get(key).and_then(Value::as_str) {
            Some(status) if allowed.contains(&status) => Ok(()),
            _ => Err(invalid(&format!("invalid {key}"))),
        }
    };
    match kind {
        "message" => {
            required(item, "id", is_string)?;
            if let Some(phase) = optional(item, "phase", true, is_string)?
                && !matches!(phase.as_str(), Some("commentary" | "final_answer"))
            {
                return Err(invalid("invalid phase"));
            }
        }
        "reasoning" => {
            required(item, "id", is_string)?;
            optional(item, "encrypted_content", true, is_string)?;
        }
        "function_call" => {
            for key in ["id", "call_id", "name", "arguments"] {
                required(item, key, is_string)?;
            }
            optional(item, "async", true, is_bool)?;
            optional(item, "namespace", true, is_string)?;
            if let Some(caller) = optional(item, "caller", true, is_object)? {
                match caller.get("type").and_then(Value::as_str) {
                    Some("direct") => {}
                    Some("program") if caller.get("caller_id").is_some_and(Value::is_string) => {}
                    _ => return Err(invalid("invalid caller")),
                }
            }
            if done {
                statuses("status", &["in_progress", "completed", "incomplete"])?;
            }
        }
        "custom_tool_call" => {
            for key in ["id", "call_id", "name", "input"] {
                required(item, key, is_string)?;
            }
            optional(item, "async", true, is_bool)?;
            if done {
                statuses("status", &["completed"])?;
            }
        }
        "compaction" => {
            required(item, "id", is_string)?;
            if done {
                required(item, "encrypted_content", is_string)?;
            } else {
                optional(item, "encrypted_content", true, is_string)?;
            }
        }
        "tool_search_call" | "tool_search_output" => {
            required(item, "id", is_string)?;
            statuses("execution", &["server", "client"])?;
            required(item, "call_id", is_string_or_null)?;
            statuses("status", &["in_progress", "completed", "incomplete"])?;
            if kind == "tool_search_call" {
                item.get("arguments")
                    .ok_or_else(|| invalid("invalid arguments"))?;
            } else {
                let tools = required(item, "tools", is_array)?
                    .as_array()
                    .expect("an array");
                if !tools.iter().all(Value::is_object) {
                    return Err(invalid("invalid tools"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// `openaiResponsesNestedErrorChunkSchema`, else `openaiResponsesErrorChunkSchema`.
fn parse_error_chunk(chunk: &Map<String, Value>) -> anyhow::Result<Value> {
    required(chunk, "sequence_number", is_number)?;
    let nested = chunk
        .get("error")
        .and_then(Value::as_object)
        .filter(|error| {
            error.get("type").is_some_and(Value::is_string)
                && error.get("message").is_some_and(Value::is_string)
                && optional(error, "code", true, is_string).is_ok()
                && optional(error, "param", true, is_string).is_ok()
        });
    if let Some(error) = nested {
        let mut out = Map::new();
        out.insert("type".to_string(), string("error"));
        out.insert(
            "sequence_number".to_string(),
            chunk["sequence_number"].clone(),
        );
        out.insert(
            "error".to_string(),
            pick(error, &["type", "code", "message", "param"]),
        );
        return Ok(Value::Object(out));
    }
    optional(chunk, "code", true, is_string)?;
    required(chunk, "message", is_string)?;
    optional(chunk, "param", true, is_string)?;
    Ok(pick(
        chunk,
        &["type", "sequence_number", "code", "message", "param"],
    ))
}

/// `isResponseOutputChunk`.
fn is_output_chunk(kind: &str) -> bool {
    !matches!(
        kind,
        "response.created" | "response.in_progress" | "response.failed" | "error" | "unknown_chunk"
    )
}

/// The frame an error chunk gives: an `error` event, or a `response.failed` with an
/// error.
fn error_frame(chunk: &Parsed) -> Option<&Value> {
    let failed = chunk.kind == "response.failed"
        && !chunk.value["response"]
            .get("error")
            .is_none_or(Value::is_null);
    (chunk.kind == "error" || failed).then_some(&chunk.value)
}

/// `throwIfOpenAIStreamErrorBeforeOutput`: an error before the first output is the
/// call's error. The SDK stops looking 50 ms after `response.in_progress`; the
/// whole body is read here, so every event before the first output is looked at.
fn throw_if_error_before_output(
    chunks: &[Chunk],
    url: &str,
    body: &Value,
    response: &FetchResponse,
) -> anyhow::Result<()> {
    for chunk in chunks {
        let Ok(parsed) = &chunk.parsed else {
            return Ok(());
        };
        if let Some(frame) = error_frame(parsed) {
            let stream_error = provider_stream_error(frame);
            let field = |key: &str| stream_error.as_ref().and_then(|e| e.get(key).cloned());
            let status_code = field("statusCode")
                .and_then(|code| code.as_u64())
                .map(|code| code as u16)
                .unwrap_or(500);
            let mut error = ApiCallError::new(
                field("message")
                    .and_then(|m| m.as_str().map(str::to_string))
                    .unwrap_or_else(|| {
                        "OpenAI stream failed before any output was generated".to_string()
                    }),
                url,
                body.clone(),
                Some(status_code),
                Some(response.headers.clone()),
                Some(js_stringify(frame)),
            );
            error.data = Some(frame.clone());
            if let Some(Value::Bool(retryable)) = field("isRetryable") {
                error.is_retryable = retryable;
            }
            return Err(error.into());
        }
        if is_output_chunk(&parsed.kind) {
            return Ok(());
        }
    }
    Ok(())
}

/// `createOpenAIProviderStreamError`: the provider stream error an error frame
/// gives, with the HTTP status its code or type stands for.
fn provider_stream_error(frame: &Value) -> Option<Value> {
    let (message, code, kind) = parse_stream_error(frame)?;
    let status_code = status_code_of(code.as_ref(), kind.as_deref());
    let insufficient_quota = code.as_ref().and_then(Value::as_str) == Some("insufficient_quota")
        || kind.as_deref() == Some("insufficient_quota");
    let is_retryable = !insufficient_quota
        && (status_code == 408 || status_code == 409 || status_code == 429 || status_code >= 500);
    let mut error = Map::new();
    error.insert("message".to_string(), string(message));
    if let Some(kind) = kind {
        error.insert("type".to_string(), string(kind));
    }
    if let Some(code) = code {
        error.insert("code".to_string(), code);
    }
    error.insert("statusCode".to_string(), Value::from(status_code));
    error.insert("isRetryable".to_string(), Value::Bool(is_retryable));
    error.insert("data".to_string(), frame.clone());
    Some(Value::Object(error))
}

/// `parseStreamError`: the message, code and type of an error frame.
fn parse_stream_error(frame: &Value) -> Option<(String, Option<Value>, Option<String>)> {
    let frame = frame.as_object()?;
    let string_or_number =
        |value: Option<&Value>| value.filter(|v| v.is_string() || v.is_number()).cloned();
    if frame.get("type").and_then(Value::as_str) == Some("response.failed") {
        let error = frame.get("response")?.get("error")?.as_object()?;
        let message = error.get("message")?.as_str()?;
        return Some((
            message.to_string(),
            string_or_number(error.get("code")),
            Some("response.failed".to_string()),
        ));
    }
    let nested = frame.get("error").and_then(Value::as_object);
    let error = nested.unwrap_or(frame);
    let message = error.get("message")?.as_str()?;
    let kind = error.get("type").and_then(Value::as_str);
    if nested.is_none()
        && kind.is_none()
        && !error.contains_key("code")
        && !error.contains_key("param")
    {
        return None;
    }
    Some((
        message.to_string(),
        string_or_number(error.get("code")),
        kind.map(str::to_string),
    ))
}

/// `getStatusCode`: the HTTP status a code names, else the one its words suggest.
fn status_code_of(code: Option<&Value>, kind: Option<&str>) -> u16 {
    let explicit = match code {
        Some(Value::String(text))
            if text.len() == 3 && text.bytes().all(|b| b.is_ascii_digit()) =>
        {
            text.parse::<u16>().ok()
        }
        Some(Value::Number(number)) => number.as_u64().and_then(|n| u16::try_from(n).ok()),
        _ => None,
    };
    if let Some(status) = explicit.filter(|status| (400..=599).contains(status)) {
        return status;
    }
    let mut words = Vec::new();
    if let Some(code) = code {
        words.push(match code {
            Value::String(text) => text.clone(),
            other => js_stringify(other),
        });
    }
    if let Some(kind) = kind {
        words.push(kind.to_string());
    }
    let discriminator = words.join(" ").to_lowercase();
    let has = |terms: &[&str]| terms.iter().any(|term| discriminator.contains(term));
    if has(&["insufficient_quota", "rate_limit"]) {
        429
    } else if has(&["authentication"]) {
        401
    } else if has(&["permission"]) {
        403
    } else if has(&["not_found"]) {
        404
    } else if has(&["invalid", "bad_request", "context_length"]) {
        400
    } else if has(&["overload"]) {
        503
    } else if has(&["timeout"]) {
        504
    } else {
        500
    }
}

/// A Chat Completions chunk, which a base URL of a Chat Completions endpoint sends.
fn is_chat_completion_chunk(raw: Option<&Value>) -> bool {
    raw.and_then(Value::as_object).is_some_and(|chunk| {
        chunk.get("choices").is_some_and(Value::is_array)
            && !chunk.get("type").is_some_and(Value::is_string)
    })
}

/// A tool call whose input is still streaming.
struct OngoingToolCall {
    tool_name: String,
    tool_call_id: String,
    /// An undeclared `parallel` wrapper: its input is held back until it is expanded.
    suppress_input_streaming: bool,
    buffered_input_deltas: Vec<String>,
    is_async: Option<Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SummaryPart {
    Active,
    CanConclude,
    Concluded,
}

struct ActiveReasoning {
    encrypted_content: Option<Value>,
    summary_parts: BTreeMap<u64, SummaryPart>,
}

#[derive(Default)]
struct State {
    finish_reason: Option<LanguageModelV4FinishReason>,
    usage: Option<Value>,
    logprobs: Vec<Value>,
    response_id: Option<String>,
    ongoing_tool_calls: BTreeMap<u64, OngoingToolCall>,
    ongoing_annotations: Vec<Value>,
    fallback_annotations: Vec<Value>,
    active_message_phase: Option<Value>,
    has_function_call: bool,
    active_reasoning: HashMap<String, ActiveReasoning>,
    active_output_item_ids: HashMap<u64, String>,
    service_tier: Option<String>,
    reasoning_context: Option<String>,
    hosted_tool_search_call_ids: Vec<String>,
    encountered_stream_error: bool,
}

/// The stream's `TransformStream`: events in, parts out.
struct Transform<'a> {
    name: &'a str,
    tool_name_mapping: &'a ToolNameMapping,
    function_tools: &'a [&'a LanguageModelV4FunctionTool],
    store: bool,
    wants_logprobs: bool,
    url: &'a str,
    body: &'a Value,
    response: &'a FetchResponse,
    parts: Vec<LanguageModelV4StreamPart>,
    state: State,
}

fn index_of(value: &Value) -> Option<u64> {
    value.as_f64().map(|index| index as u64)
}

fn str_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

/// `value` when it is neither absent nor null.
fn present(value: &Value) -> Option<&Value> {
    (!value.is_null()).then_some(value)
}

impl Transform<'_> {
    fn push(&mut self, part: LanguageModelV4StreamPart) {
        self.parts.push(part);
    }

    fn metadata(&self, fields: Map<String, Value>) -> Option<ProviderMetadata> {
        Some(metadata_under(self.name, fields))
    }

    fn item_metadata(&self, item_id: &str) -> Option<ProviderMetadata> {
        let mut fields = Map::new();
        fields.insert("itemId".to_string(), string(item_id));
        self.metadata(fields)
    }

    fn reasoning_metadata(
        &self,
        item_id: &str,
        encrypted: Option<&Value>,
    ) -> Option<ProviderMetadata> {
        let mut fields = Map::new();
        fields.insert("itemId".to_string(), string(item_id));
        fields.insert(
            "reasoningEncryptedContent".to_string(),
            encrypted.cloned().unwrap_or(Value::Null),
        );
        self.metadata(fields)
    }

    /// `resolveOutputItemId`: the id the output item's start event gave.
    fn resolve_item_id(&self, item_id: &Value, output_index: &Value) -> String {
        index_of(output_index)
            .and_then(|index| self.state.active_output_item_ids.get(&index).cloned())
            .unwrap_or_else(|| str_of(item_id))
    }

    fn is_undeclared_parallel_tool_call(&self, tool_name: &str) -> bool {
        tool_name == PARALLEL_TOOL_NAME
            && !self
                .function_tools
                .iter()
                .any(|t| t.name == PARALLEL_TOOL_NAME)
    }

    fn chunk(&mut self, chunk: Chunk) {
        let parsed = match chunk.parsed {
            Ok(parsed) => parsed,
            Err(cause) => {
                let error = if is_chat_completion_chunk(chunk.raw.as_ref()) {
                    self.chat_completions_mismatch(chunk.raw.unwrap_or(Value::Null), cause)
                } else {
                    cause
                };
                self.state.encountered_stream_error = true;
                self.state.finish_reason = Some(LanguageModelV4FinishReason {
                    unified: FinishReason::Error,
                    raw: None,
                });
                self.push(LanguageModelV4StreamPart::Error {
                    error: LanguageModelV4StreamError::Error(error),
                });
                return;
            }
        };
        let value = &parsed.value;
        match parsed.kind.as_str() {
            "response.output_item.added" => self.item_added(&value["item"], &value["output_index"]),
            "response.output_item.done" => self.item_done(&value["item"], &value["output_index"]),
            "response.function_call_arguments.delta" => {
                let delta = str_of(&value["delta"]);
                let Some(call) = index_of(&value["output_index"])
                    .and_then(|index| self.state.ongoing_tool_calls.get_mut(&index))
                else {
                    return;
                };
                if call.suppress_input_streaming {
                    call.buffered_input_deltas.push(delta);
                } else {
                    let id = call.tool_call_id.clone();
                    self.push(LanguageModelV4StreamPart::ToolInputDelta { id, delta });
                }
            }
            "response.custom_tool_call_input.delta" => {
                let Some(call) = index_of(&value["output_index"])
                    .and_then(|index| self.state.ongoing_tool_calls.get(&index))
                else {
                    return;
                };
                let id = call.tool_call_id.clone();
                self.push(LanguageModelV4StreamPart::ToolInputDelta {
                    id,
                    delta: str_of(&value["delta"]),
                });
            }
            "response.created" => {
                let response = &value["response"];
                self.state.response_id = Some(str_of(&response["id"]));
                self.push(LanguageModelV4StreamPart::ResponseMetadata {
                    id: Some(str_of(&response["id"])),
                    timestamp: response["created_at"].as_f64().and_then(timestamp_of),
                    model_id: Some(str_of(&response["model"])),
                });
            }
            "response.output_text.delta" => {
                let id = self.resolve_item_id(&value["item_id"], &value["output_index"]);
                self.push(LanguageModelV4StreamPart::TextDelta {
                    id,
                    delta: str_of(&value["delta"]),
                });
                if self.wants_logprobs
                    && let Some(logprobs) = present(&value["logprobs"])
                {
                    self.state.logprobs.push(strip_logprobs(logprobs));
                }
            }
            "response.reasoning_summary_part.added" => {
                let item_id = self.resolve_item_id(&value["item_id"], &value["output_index"]);
                let summary_index = index_of(&value["summary_index"]).unwrap_or_default();
                if summary_index == 0 {
                    return;
                }
                let Some(active) = self.state.active_reasoning.get_mut(&item_id) else {
                    return;
                };
                active
                    .summary_parts
                    .insert(summary_index, SummaryPart::Active);
                let concluding: Vec<u64> = active
                    .summary_parts
                    .iter()
                    .filter(|(_, status)| **status == SummaryPart::CanConclude)
                    .map(|(index, _)| *index)
                    .collect();
                for index in &concluding {
                    active.summary_parts.insert(*index, SummaryPart::Concluded);
                }
                let encrypted = active.encrypted_content.clone();
                for index in concluding {
                    let provider_metadata = self.item_metadata(&item_id);
                    self.push(LanguageModelV4StreamPart::ReasoningEnd {
                        id: format!("{item_id}:{index}"),
                        provider_metadata,
                    });
                }
                let provider_metadata = self.reasoning_metadata(&item_id, encrypted.as_ref());
                self.push(LanguageModelV4StreamPart::ReasoningStart {
                    id: format!("{item_id}:{summary_index}"),
                    provider_metadata,
                });
            }
            "response.reasoning_summary_text.delta" => {
                let item_id = self.resolve_item_id(&value["item_id"], &value["output_index"]);
                let provider_metadata = self.item_metadata(&item_id);
                self.push(LanguageModelV4StreamPart::ReasoningDelta {
                    id: format!("{item_id}:{}", js_stringify(&value["summary_index"])),
                    delta: str_of(&value["delta"]),
                    provider_metadata,
                });
            }
            "response.reasoning_summary_part.done" => {
                let item_id = self.resolve_item_id(&value["item_id"], &value["output_index"]);
                let summary_index = index_of(&value["summary_index"]).unwrap_or_default();
                let store = self.store;
                let Some(active) = self.state.active_reasoning.get_mut(&item_id) else {
                    return;
                };
                if !store {
                    active
                        .summary_parts
                        .insert(summary_index, SummaryPart::CanConclude);
                    return;
                }
                active
                    .summary_parts
                    .insert(summary_index, SummaryPart::Concluded);
                let provider_metadata = self.item_metadata(&item_id);
                self.push(LanguageModelV4StreamPart::ReasoningEnd {
                    id: format!("{item_id}:{summary_index}"),
                    provider_metadata,
                });
            }
            "response.completed" | "response.incomplete" => {
                let response = &value["response"];
                let reason = response["incomplete_details"]["reason"]
                    .as_str()
                    .map(str::to_string);
                if !self.state.encountered_stream_error {
                    self.state.finish_reason = Some(LanguageModelV4FinishReason {
                        unified: map_finish_reason(reason.as_deref(), self.state.has_function_call),
                        raw: reason,
                    });
                }
                self.finished_response(response);
                if let Some(tier) = response["service_tier"].as_str() {
                    self.state.service_tier = Some(tier.to_string());
                }
            }
            "response.failed" => {
                let response = &value["response"];
                let reason = response["incomplete_details"]["reason"]
                    .as_str()
                    .map(str::to_string);
                self.state.finish_reason = Some(LanguageModelV4FinishReason {
                    unified: match &reason {
                        Some(reason) => {
                            map_finish_reason(Some(reason), self.state.has_function_call)
                        }
                        None => FinishReason::Error,
                    },
                    raw: Some(reason.unwrap_or_else(|| "error".to_string())),
                });
                self.finished_response(response);
                if self.state.encountered_stream_error || response["error"].is_null() {
                    return;
                }
                self.state.encountered_stream_error = true;
                let mut failed = Map::new();
                for key in ["error", "incomplete_details", "service_tier"] {
                    if let Some(field) = response.get(key) {
                        failed.insert(key.to_string(), field.clone());
                    }
                }
                let mut frame = Map::new();
                frame.insert("type".to_string(), string("response.failed"));
                frame.insert(
                    "sequence_number".to_string(),
                    value["sequence_number"].clone(),
                );
                frame.insert("response".to_string(), Value::Object(failed));
                self.push_stream_error(Value::Object(frame));
            }
            "response.output_text.annotation.added" => {
                let annotation = value["annotation"].clone();
                self.state.ongoing_annotations.push(annotation.clone());
                if matches!(
                    annotation["type"].as_str(),
                    Some("url_citation" | "file_citation")
                ) {
                    self.state.fallback_annotations.push(annotation);
                } else {
                    let source = annotation_source(&annotation, self.name, generate_id());
                    self.push(LanguageModelV4StreamPart::Content(
                        LanguageModelV4Content::Source(source),
                    ));
                }
            }
            "error" => {
                self.state.encountered_stream_error = true;
                self.state.finish_reason = Some(LanguageModelV4FinishReason {
                    unified: FinishReason::Error,
                    raw: Some("error".to_string()),
                });
                self.push_stream_error(value.clone());
            }
            _ => {}
        }
    }

    /// The usage and reasoning context of a finished response.
    fn finished_response(&mut self, response: &Value) {
        self.state.usage = present(&response["usage"]).cloned();
        if let Some(context) = response["reasoning"]["context"].as_str() {
            self.state.reasoning_context = Some(context.to_string());
        }
    }

    fn push_stream_error(&mut self, frame: Value) {
        let error = provider_stream_error(&frame).unwrap_or(frame);
        self.push(LanguageModelV4StreamPart::Error {
            error: LanguageModelV4StreamError::Value(error),
        });
    }

    fn chat_completions_mismatch(&self, value: Value, cause: anyhow::Error) -> anyhow::Error {
        let mut error = ApiCallError::new(
            "Received a Chat Completions stream while using the OpenAI Responses API. The default OpenAI provider model uses the Responses API. If your custom baseURL targets a Chat Completions-compatible endpoint, use openai.chat('model-id') or createOpenAI(...).chat('model-id') instead. You can also use @ai-sdk/openai-compatible for OpenAI-compatible providers.",
            self.url,
            self.body.clone(),
            None,
            Some(self.response.headers.clone()),
            Some(js_stringify(&value)),
        );
        error.is_retryable = false;
        error.cause = Some(std::sync::Arc::new(cause));
        error.data = Some(value);
        error.into()
    }

    fn item_added(&mut self, item: &Value, output_index: &Value) {
        let Some(index) = index_of(output_index) else {
            return;
        };
        match item["type"].as_str().unwrap_or_default() {
            "function_call" => {
                let tool_name = str_of(&item["name"]);
                let tool_call_id = str_of(&item["call_id"]);
                let suppress = self.is_undeclared_parallel_tool_call(&tool_name);
                self.state.ongoing_tool_calls.insert(
                    index,
                    OngoingToolCall {
                        tool_name: tool_name.clone(),
                        tool_call_id: tool_call_id.clone(),
                        suppress_input_streaming: suppress,
                        buffered_input_deltas: Vec::new(),
                        is_async: present(&item["async"]).cloned(),
                    },
                );
                if !suppress {
                    self.push(LanguageModelV4StreamPart::ToolInputStart {
                        id: tool_call_id,
                        tool_name,
                        provider_executed: None,
                        input_encoding: None,
                    });
                }
            }
            "custom_tool_call" => {
                let tool_name = self
                    .tool_name_mapping
                    .to_custom_tool_name(&str_of(&item["name"]));
                let tool_call_id = str_of(&item["call_id"]);
                self.state.ongoing_tool_calls.insert(
                    index,
                    OngoingToolCall {
                        tool_name: tool_name.clone(),
                        tool_call_id: tool_call_id.clone(),
                        suppress_input_streaming: false,
                        buffered_input_deltas: Vec::new(),
                        is_async: present(&item["async"]).cloned(),
                    },
                );
                self.push(LanguageModelV4StreamPart::ToolInputStart {
                    id: tool_call_id,
                    tool_name,
                    provider_executed: None,
                    input_encoding: Some("text".to_string()),
                });
            }
            "tool_search_call" => {
                let tool_name = self.tool_name_mapping.to_custom_tool_name("tool_search");
                let tool_call_id = str_of(&item["id"]);
                self.state.ongoing_tool_calls.insert(
                    index,
                    OngoingToolCall {
                        tool_name: tool_name.clone(),
                        tool_call_id: tool_call_id.clone(),
                        suppress_input_streaming: false,
                        buffered_input_deltas: Vec::new(),
                        is_async: None,
                    },
                );
                if item["execution"] == "server" {
                    self.push(LanguageModelV4StreamPart::ToolInputStart {
                        id: tool_call_id,
                        tool_name,
                        provider_executed: Some(true),
                        input_encoding: None,
                    });
                }
            }
            "message" => {
                let id = str_of(&item["id"]);
                self.state.active_output_item_ids.insert(index, id.clone());
                self.state.ongoing_annotations.clear();
                self.state.active_message_phase = present(&item["phase"]).cloned();
                let mut fields = Map::new();
                fields.insert("itemId".to_string(), string(id.clone()));
                if let Some(phase) = present(&item["phase"]) {
                    fields.insert("phase".to_string(), phase.clone());
                }
                let provider_metadata = self.metadata(fields);
                self.push(LanguageModelV4StreamPart::TextStart {
                    id,
                    provider_metadata,
                });
            }
            "reasoning" => {
                let id = str_of(&item["id"]);
                let encrypted = present(&item["encrypted_content"]).cloned();
                self.state.active_output_item_ids.insert(index, id.clone());
                self.state.active_reasoning.insert(
                    id.clone(),
                    ActiveReasoning {
                        encrypted_content: encrypted.clone(),
                        summary_parts: BTreeMap::from([(0, SummaryPart::Active)]),
                    },
                );
                let provider_metadata = self.reasoning_metadata(&id, encrypted.as_ref());
                self.push(LanguageModelV4StreamPart::ReasoningStart {
                    id: format!("{id}:0"),
                    provider_metadata,
                });
            }
            _ => {}
        }
    }

    fn item_done(&mut self, item: &Value, output_index: &Value) {
        let Some(index) = index_of(output_index) else {
            return;
        };
        match item["type"].as_str().unwrap_or_default() {
            "message" => {
                let item_id = self.resolve_item_id(&item["id"], output_index);
                let phase = present(&item["phase"])
                    .cloned()
                    .or_else(|| self.state.active_message_phase.take());
                self.state.active_message_phase = None;
                let mut fields = Map::new();
                fields.insert("itemId".to_string(), string(item_id.clone()));
                if let Some(phase) = phase {
                    fields.insert("phase".to_string(), phase);
                }
                if !self.state.ongoing_annotations.is_empty() {
                    fields.insert(
                        "annotations".to_string(),
                        Value::Array(self.state.ongoing_annotations.clone()),
                    );
                }
                let provider_metadata = self.metadata(fields);
                self.push(LanguageModelV4StreamPart::TextEnd {
                    id: item_id,
                    provider_metadata,
                });
                self.state.active_output_item_ids.remove(&index);
            }
            "function_call" => self.function_call_done(item, index),
            "custom_tool_call" => {
                let ongoing = self.state.ongoing_tool_calls.remove(&index);
                self.state.has_function_call = true;
                let tool_call_id = str_of(&item["call_id"]);
                let mut fields = Map::new();
                fields.insert("itemId".to_string(), item["id"].clone());
                if let Some(is_async) = present(&item["async"])
                    .cloned()
                    .or_else(|| ongoing.and_then(|call| call.is_async))
                {
                    fields.insert("async".to_string(), is_async);
                }
                let provider_metadata = self.metadata(fields);
                self.push(LanguageModelV4StreamPart::ToolInputEnd {
                    id: tool_call_id.clone(),
                    provider_metadata: None,
                });
                self.push(LanguageModelV4StreamPart::Content(
                    LanguageModelV4Content::ToolCall {
                        tool_call_id,
                        tool_name: self
                            .tool_name_mapping
                            .to_custom_tool_name(&str_of(&item["name"])),
                        input: js_stringify(&item["input"]),
                        provider_executed: None,
                        dynamic: None,
                        provider_metadata,
                    },
                ));
            }
            "tool_search_call" => {
                let Some(call) = self.state.ongoing_tool_calls.remove(&index) else {
                    return;
                };
                let is_hosted = item["execution"] == "server";
                let tool_call_id = if is_hosted {
                    call.tool_call_id
                } else {
                    item["call_id"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| str_of(&item["id"]))
                };
                if is_hosted {
                    self.state
                        .hosted_tool_search_call_ids
                        .push(tool_call_id.clone());
                } else {
                    self.push(LanguageModelV4StreamPart::ToolInputStart {
                        id: tool_call_id.clone(),
                        tool_name: call.tool_name.clone(),
                        provider_executed: None,
                        input_encoding: None,
                    });
                }
                self.push(LanguageModelV4StreamPart::ToolInputEnd {
                    id: tool_call_id.clone(),
                    provider_metadata: None,
                });
                let mut input = Map::new();
                input.insert("arguments".to_string(), item["arguments"].clone());
                input.insert(
                    "call_id".to_string(),
                    if is_hosted {
                        Value::Null
                    } else {
                        string(tool_call_id.clone())
                    },
                );
                let provider_metadata = self.item_metadata(&str_of(&item["id"]));
                self.push(LanguageModelV4StreamPart::Content(
                    LanguageModelV4Content::ToolCall {
                        tool_call_id,
                        tool_name: call.tool_name,
                        input: js_stringify(&Value::Object(input)),
                        provider_executed: is_hosted.then_some(true),
                        dynamic: None,
                        provider_metadata,
                    },
                ));
            }
            "tool_search_output" => {
                let tool_call_id = item["call_id"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        (!self.state.hosted_tool_search_call_ids.is_empty())
                            .then(|| self.state.hosted_tool_search_call_ids.remove(0))
                    })
                    .unwrap_or_else(|| str_of(&item["id"]));
                let mut result = Map::new();
                result.insert("tools".to_string(), item["tools"].clone());
                let provider_metadata = self.item_metadata(&str_of(&item["id"]));
                self.push(LanguageModelV4StreamPart::Content(
                    LanguageModelV4Content::ToolResult {
                        tool_call_id,
                        tool_name: self.tool_name_mapping.to_custom_tool_name("tool_search"),
                        result: Value::Object(result),
                        is_error: None,
                        preliminary: None,
                        dynamic: None,
                        provider_metadata,
                    },
                ));
            }
            "reasoning" => {
                let item_id = self.resolve_item_id(&item["id"], output_index);
                if let Some(active) = self.state.active_reasoning.remove(&item_id) {
                    for (summary_index, status) in active.summary_parts {
                        if status == SummaryPart::Concluded {
                            continue;
                        }
                        let provider_metadata =
                            self.reasoning_metadata(&item_id, present(&item["encrypted_content"]));
                        self.push(LanguageModelV4StreamPart::ReasoningEnd {
                            id: format!("{item_id}:{summary_index}"),
                            provider_metadata,
                        });
                    }
                }
                self.state.active_output_item_ids.remove(&index);
            }
            "compaction" => {
                let mut fields = Map::new();
                fields.insert("type".to_string(), string("compaction"));
                fields.insert("itemId".to_string(), item["id"].clone());
                fields.insert(
                    "encryptedContent".to_string(),
                    item["encrypted_content"].clone(),
                );
                let provider_metadata = self.metadata(fields);
                self.push(LanguageModelV4StreamPart::Content(
                    LanguageModelV4Content::Custom {
                        kind: "openai.compaction".to_string(),
                        provider_metadata,
                    },
                ));
            }
            _ => {}
        }
    }

    fn function_call_done(&mut self, item: &Value, index: u64) {
        let ongoing = self.state.ongoing_tool_calls.remove(&index);
        self.state.has_function_call = true;
        let call_id = str_of(&item["call_id"]);
        let tool_name = str_of(&item["name"]);
        let arguments = str_of(&item["arguments"]);
        let suppress = ongoing
            .as_ref()
            .map(|call| call.suppress_input_streaming)
            .unwrap_or_else(|| self.is_undeclared_parallel_tool_call(&tool_name));
        if suppress
            && let Some(expanded) = expand_parallel_tool_call(
                &call_id,
                &tool_name,
                &arguments,
                self.function_tools,
                self.name,
                &str_of(&item["id"]),
            )
        {
            for call in expanded {
                let LanguageModelV4Content::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                    ..
                } = &call
                else {
                    continue;
                };
                self.push(LanguageModelV4StreamPart::ToolInputStart {
                    id: tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    provider_executed: None,
                    input_encoding: None,
                });
                self.push(LanguageModelV4StreamPart::ToolInputDelta {
                    id: tool_call_id.clone(),
                    delta: input.clone(),
                });
                self.push(LanguageModelV4StreamPart::ToolInputEnd {
                    id: tool_call_id.clone(),
                    provider_metadata: None,
                });
                self.push(LanguageModelV4StreamPart::Content(call));
            }
            return;
        }

        if suppress {
            self.push(LanguageModelV4StreamPart::ToolInputStart {
                id: call_id.clone(),
                tool_name: tool_name.clone(),
                provider_executed: None,
                input_encoding: None,
            });
            let buffered = ongoing
                .as_ref()
                .map(|call| call.buffered_input_deltas.clone())
                .unwrap_or_default();
            let deltas = if buffered.is_empty() && !arguments.is_empty() {
                vec![arguments.clone()]
            } else {
                buffered
            };
            for delta in deltas {
                self.push(LanguageModelV4StreamPart::ToolInputDelta {
                    id: call_id.clone(),
                    delta,
                });
            }
        }
        let namespace = present(&item["namespace"]).cloned();
        let end_metadata = namespace.clone().and_then(|namespace| {
            let mut fields = Map::new();
            fields.insert("namespace".to_string(), namespace);
            self.metadata(fields)
        });
        self.push(LanguageModelV4StreamPart::ToolInputEnd {
            id: call_id.clone(),
            provider_metadata: end_metadata,
        });
        let mut fields = Map::new();
        fields.insert("itemId".to_string(), item["id"].clone());
        if let Some(is_async) = present(&item["async"])
            .cloned()
            .or_else(|| ongoing.and_then(|call| call.is_async))
        {
            fields.insert("async".to_string(), is_async);
        }
        if let Some(namespace) = namespace {
            fields.insert("namespace".to_string(), namespace);
        }
        if let Some(caller) = present(&item["caller"]) {
            let mut mapped = Map::new();
            mapped.insert("type".to_string(), caller["type"].clone());
            if caller["type"] == "program" {
                mapped.insert("callerId".to_string(), caller["caller_id"].clone());
            }
            fields.insert("caller".to_string(), Value::Object(mapped));
        }
        let provider_metadata = self.metadata(fields);
        self.push(LanguageModelV4StreamPart::Content(
            LanguageModelV4Content::ToolCall {
                tool_call_id: call_id,
                tool_name,
                input: arguments,
                provider_executed: None,
                dynamic: None,
                provider_metadata,
            },
        ));
    }

    /// `flush`: the citations no retrieval data stood in for, the held-back input of
    /// unfinished `parallel` wrappers, and the finish part.
    fn flush(&mut self) {
        for annotation in std::mem::take(&mut self.state.fallback_annotations) {
            let source = annotation_source(&annotation, self.name, generate_id());
            self.push(LanguageModelV4StreamPart::Content(
                LanguageModelV4Content::Source(source),
            ));
        }
        let ongoing = std::mem::take(&mut self.state.ongoing_tool_calls);
        for call in ongoing.into_values() {
            if !call.suppress_input_streaming {
                continue;
            }
            self.push(LanguageModelV4StreamPart::ToolInputStart {
                id: call.tool_call_id.clone(),
                tool_name: call.tool_name,
                provider_executed: None,
                input_encoding: None,
            });
            for delta in call.buffered_input_deltas {
                self.push(LanguageModelV4StreamPart::ToolInputDelta {
                    id: call.tool_call_id.clone(),
                    delta,
                });
            }
        }
        let mut fields = Map::new();
        fields.insert(
            "responseId".to_string(),
            self.state
                .response_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        if !self.state.logprobs.is_empty() {
            fields.insert(
                "logprobs".to_string(),
                Value::Array(std::mem::take(&mut self.state.logprobs)),
            );
        }
        if let Some(tier) = &self.state.service_tier {
            fields.insert("serviceTier".to_string(), string(tier.clone()));
        }
        if let Some(context) = &self.state.reasoning_context {
            fields.insert("reasoningContext".to_string(), string(context.clone()));
        }
        let provider_metadata = self.metadata(fields);
        let finish_reason =
            self.state
                .finish_reason
                .take()
                .unwrap_or(LanguageModelV4FinishReason {
                    unified: FinishReason::Other,
                    raw: None,
                });
        let usage = convert_usage(self.state.usage.as_ref());
        self.push(LanguageModelV4StreamPart::Finish {
            finish_reason,
            usage,
            provider_metadata,
        });
    }
}

#[cfg(test)]
#[path = "responses_stream_tests.rs"]
mod tests;
