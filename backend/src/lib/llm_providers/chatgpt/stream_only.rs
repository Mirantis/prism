//! Serves a non-streaming call from the model's stream, for an endpoint that
//! answers only streamed requests. The parts are collected into the result the
//! call would have returned, so callers keep using `generate_text`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;

use crate::ai::json::js_stringify;
use crate::ai::{
    ApiCallError, LanguageModel, LanguageModelMiddleware, LanguageModelV4CallOptions,
    LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4Response,
    LanguageModelV4StreamError, LanguageModelV4StreamPart, LanguageModelV4StreamResult,
    ProviderMetadata,
};

/// The Responses API events that end a response. A stream that closes before one
/// of them is a truncated answer, though the provider still ends it with a finish
/// part.
const TERMINAL_EVENTS: &[&str] = &[
    "response.completed",
    "response.incomplete",
    "response.failed",
];

/// `url` names the endpoint in the errors a failed stream raises.
pub struct StreamOnly {
    pub url: String,
}

#[async_trait]
impl LanguageModelMiddleware for StreamOnly {
    async fn wrap_generate(
        &self,
        mut params: LanguageModelV4CallOptions,
        model: &Arc<dyn LanguageModel>,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        params.include_raw_chunks = Some(true);
        collect_stream(model.do_stream(params).await?, &self.url).await
    }
}

/// Which content part a text or reasoning part's id names while it streams.
fn open_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

async fn collect_stream(
    streamed: LanguageModelV4StreamResult,
    url: &str,
) -> anyhow::Result<LanguageModelV4GenerateResult> {
    let LanguageModelV4StreamResult {
        mut stream,
        request,
        response,
    } = streamed;
    let request_body = request
        .as_ref()
        .and_then(|request| request.body.clone())
        .unwrap_or(Value::Null);
    let response_headers = response
        .as_ref()
        .and_then(|response| response.headers.clone());

    let mut content: Vec<LanguageModelV4Content> = Vec::new();
    let mut open: HashMap<String, usize> = HashMap::new();
    let mut finish = None;
    let mut warnings = Vec::new();
    let mut metadata = LanguageModelV4Response::default();
    let mut finished = false;

    // A part's metadata grows as it streams: the end event has the final item id and
    // the encrypted reasoning, so it replaces what the start event had.
    let begin = |content: &mut Vec<LanguageModelV4Content>,
                 open: &mut HashMap<String, usize>,
                 key: String,
                 part: LanguageModelV4Content| {
        open.insert(key, content.len());
        content.push(part);
    };
    let append = |content: &mut [LanguageModelV4Content], index: Option<&usize>, delta: &str| {
        if let Some(
            LanguageModelV4Content::Text { text, .. }
            | LanguageModelV4Content::Reasoning { text, .. },
        ) = index.and_then(|index| content.get_mut(*index))
        {
            text.push_str(delta);
        }
    };
    let end = |content: &mut [LanguageModelV4Content],
               index: Option<usize>,
               metadata: Option<ProviderMetadata>| {
        let Some(metadata) = metadata else {
            return;
        };
        if let Some(
            LanguageModelV4Content::Text {
                provider_metadata, ..
            }
            | LanguageModelV4Content::Reasoning {
                provider_metadata, ..
            },
        ) = index.and_then(|index| content.get_mut(index))
        {
            *provider_metadata = Some(metadata);
        }
    };

    while let Some(part) = stream.next().await {
        match part {
            LanguageModelV4StreamPart::StreamStart { warnings: started } => warnings = started,
            LanguageModelV4StreamPart::ResponseMetadata {
                id,
                timestamp,
                model_id,
            } => {
                metadata.id = id;
                metadata.timestamp = timestamp;
                metadata.model_id = model_id;
            }
            LanguageModelV4StreamPart::TextStart {
                id,
                provider_metadata,
            } => begin(
                &mut content,
                &mut open,
                open_key("text", &id),
                LanguageModelV4Content::Text {
                    text: String::new(),
                    provider_metadata,
                },
            ),
            LanguageModelV4StreamPart::TextDelta { id, delta } => {
                append(&mut content, open.get(&open_key("text", &id)), &delta)
            }
            LanguageModelV4StreamPart::TextEnd {
                id,
                provider_metadata,
            } => end(
                &mut content,
                open.remove(&open_key("text", &id)),
                provider_metadata,
            ),
            LanguageModelV4StreamPart::ReasoningStart {
                id,
                provider_metadata,
            } => begin(
                &mut content,
                &mut open,
                open_key("reasoning", &id),
                LanguageModelV4Content::Reasoning {
                    text: String::new(),
                    provider_metadata,
                },
            ),
            LanguageModelV4StreamPart::ReasoningDelta { id, delta, .. } => {
                append(&mut content, open.get(&open_key("reasoning", &id)), &delta)
            }
            LanguageModelV4StreamPart::ReasoningEnd {
                id,
                provider_metadata,
            } => end(
                &mut content,
                open.remove(&open_key("reasoning", &id)),
                provider_metadata,
            ),
            LanguageModelV4StreamPart::Raw { raw_value } => {
                let event = raw_value
                    .as_ref()
                    .and_then(|raw| raw.get("type"))
                    .and_then(Value::as_str);
                finished |= event.is_some_and(|event| TERMINAL_EVENTS.contains(&event));
            }
            // Tool input streams in pieces; the tool call part that follows is whole.
            LanguageModelV4StreamPart::ToolInputStart { .. }
            | LanguageModelV4StreamPart::ToolInputDelta { .. }
            | LanguageModelV4StreamPart::ToolInputEnd { .. } => {}
            LanguageModelV4StreamPart::Finish {
                finish_reason,
                usage,
                provider_metadata,
            } => finish = Some((finish_reason, usage, provider_metadata)),
            LanguageModelV4StreamPart::Error { error } => {
                return Err(as_call_error(
                    error,
                    url,
                    &request_body,
                    response_headers.clone(),
                ));
            }
            LanguageModelV4StreamPart::Content(part) => content.push(part),
        }
    }

    let (Some((finish_reason, usage, provider_metadata)), true) = (finish, finished) else {
        let mut error = ApiCallError::new(
            "The model stream closed before the response finished.",
            url,
            request_body,
            None,
            response_headers,
            None,
        );
        error.is_retryable = true;
        return Err(error.into());
    };
    metadata.headers = response_headers;
    Ok(LanguageModelV4GenerateResult {
        content,
        finish_reason,
        usage,
        provider_metadata,
        request,
        response: Some(metadata),
        warnings,
    })
}

/// An error after output started arrives as a plain object. As an `ApiCallError`
/// it keeps its status and retryability, so `generate_text` retries it as it would
/// a failed non-streaming call.
fn as_call_error(
    error: LanguageModelV4StreamError,
    url: &str,
    request_body: &Value,
    response_headers: Option<crate::ai::Headers>,
) -> anyhow::Error {
    let value = match error {
        LanguageModelV4StreamError::Error(error) => return error,
        LanguageModelV4StreamError::Value(value) => value,
    };
    let message = match value.get("message") {
        Some(Value::String(message)) => message.clone(),
        _ => js_stringify(&value),
    };
    let status_code = value
        .get("statusCode")
        .and_then(Value::as_u64)
        .and_then(|code| u16::try_from(code).ok());
    let mut call_error = ApiCallError::new(
        message,
        url,
        request_body.clone(),
        status_code,
        response_headers,
        None,
    );
    call_error.is_retryable = value.get("isRetryable") == Some(&Value::Bool(true));
    call_error.data = Some(value);
    call_error.into()
}
