//! A Messages API response as the language model result: the content parts, the
//! finish reason, the usage and the provider metadata (`doGenerate`'s mapping,
//! `convertAnthropicUsage`, `mapAnthropicStopReason`).

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::prompt::object;
use super::tools::ToolNameMapping;
use crate::ai::json::js_stringify;
use crate::ai::provider::FinishReason;
use crate::ai::{
    JsonObject, LanguageModelV4Content, LanguageModelV4InputTokens, LanguageModelV4OutputTokens,
    LanguageModelV4Source, LanguageModelV4Usage, ProviderMetadata,
};

/// A tool call's `caller`: a direct call, or one made from code execution.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub(super) enum Caller {
    #[serde(rename = "code_execution_20250825")]
    CodeExecution20250825 { tool_id: String },
    #[serde(rename = "code_execution_20260120")]
    CodeExecution20260120 { tool_id: String },
    #[serde(rename = "direct")]
    Direct,
}

impl Caller {
    /// `getAnthropicCallerInfo`: `{ type, toolId? }`.
    fn info(&self) -> Value {
        match self {
            Self::CodeExecution20250825 { tool_id } => {
                json!({ "type": "code_execution_20250825", "toolId": tool_id })
            }
            Self::CodeExecution20260120 { tool_id } => {
                json!({ "type": "code_execution_20260120", "toolId": tool_id })
            }
            Self::Direct => json!({ "type": "direct" }),
        }
    }
}

/// `getAnthropicCallerMetadata`: `{ anthropic: { caller } }`, or nothing.
fn caller_metadata(caller: &Option<Caller>) -> Option<ProviderMetadata> {
    let caller = caller.as_ref()?;
    let mut anthropic = Map::new();
    anthropic.insert("caller".into(), caller.info());
    Some(anthropic_metadata(anthropic))
}

fn anthropic_metadata(anthropic: JsonObject) -> ProviderMetadata {
    let mut metadata = Map::new();
    metadata.insert("anthropic".into(), Value::Object(anthropic));
    metadata
}

/// A citation the model gave in a text block.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // The API's citation type names.
pub(super) enum Citation {
    WebSearchResultLocation {
        cited_text: String,
        url: String,
        title: Option<String>,
        encrypted_index: String,
    },
    PageLocation {
        cited_text: String,
        document_index: usize,
        document_title: Option<String>,
        start_page_number: f64,
        end_page_number: f64,
    },
    CharLocation {
        cited_text: String,
        document_index: usize,
        document_title: Option<String>,
        start_char_index: f64,
        end_char_index: f64,
    },
    ContentBlockLocation {
        cited_text: String,
        document_index: usize,
        document_title: Option<String>,
        start_block_index: f64,
        end_block_index: f64,
    },
    SearchResultLocation {
        cited_text: String,
        search_result_index: f64,
        source: String,
        title: Option<String>,
        start_block_index: f64,
        end_block_index: f64,
    },
}

/// One content block of a response, with the fields the mapping reads.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ResponseContent {
    Text {
        text: String,
        #[serde(default)]
        citations: Option<Vec<Citation>>,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    Compaction {
        #[serde(default)]
        content: Option<String>,
        #[serde(default)]
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        caller: Option<Caller>,
        #[serde(default)]
        toolset_name: Option<String>,
    },
    ServerToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Option<Map<String, Value>>,
        #[serde(default)]
        caller: Option<Caller>,
    },
    McpToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        server_name: String,
    },
    McpToolResult {
        tool_use_id: String,
        is_error: bool,
        content: Value,
    },
    WebFetchToolResult {
        tool_use_id: String,
        #[serde(default)]
        caller: Option<Caller>,
        content: Value,
    },
    WebSearchToolResult {
        tool_use_id: String,
        #[serde(default)]
        caller: Option<Caller>,
        content: Value,
    },
    CodeExecutionToolResult {
        tool_use_id: String,
        content: Value,
    },
    BashCodeExecutionToolResult {
        tool_use_id: String,
        content: Value,
    },
    TextEditorCodeExecutionToolResult {
        tool_use_id: String,
        content: Value,
    },
    ToolSearchToolResult {
        tool_use_id: String,
        content: Value,
    },
    ContainerUpload {
        file_id: String,
    },
    AdvisorToolResult {
        tool_use_id: String,
        content: Value,
    },
    Fallback {
        from: ModelRef,
        to: ModelRef,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ModelRef {
    pub model: String,
}

/// The parts of a response body the mapping reads (`anthropicResponseSchema`).
#[derive(Debug, Clone, Deserialize)]
pub(super) struct AnthropicResponse {
    #[serde(rename = "type")]
    pub kind: MessageLiteral,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub content: Vec<ResponseContent>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_sequence: Option<String>,
    #[serde(default)]
    pub stop_details: Option<StopDetails>,
    #[serde(default)]
    pub input_transformations: Option<Vec<InputTransformation>>,
    #[serde(default)]
    pub safeguard_results: Option<Vec<Value>>,
    pub usage: Map<String, Value>,
    #[serde(default)]
    pub container: Option<Container>,
    #[serde(default)]
    pub context_management: Option<ContextManagement>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum MessageLiteral {
    Message,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct StopDetails {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub recommended_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct InputTransformation {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ContainerSkill {
    #[serde(rename = "type")]
    pub kind: String,
    pub skill_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Container {
    pub expires_at: String,
    pub id: String,
    #[serde(default)]
    pub skills: Option<Vec<ContainerSkill>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub(super) enum AppliedEdit {
    #[serde(rename = "clear_tool_uses_20250919")]
    ClearToolUses {
        cleared_tool_uses: f64,
        cleared_input_tokens: f64,
    },
    #[serde(rename = "clear_thinking_20251015")]
    ClearThinking {
        cleared_thinking_turns: f64,
        cleared_input_tokens: f64,
    },
    #[serde(rename = "compact_20260112")]
    Compact,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ContextManagement {
    pub applied_edits: Vec<AppliedEdit>,
}

/// Parses a response body; the error is the reason it does not match the schema.
pub(super) fn parse_response(value: &Value) -> anyhow::Result<(AnthropicResponse, JsonObject)> {
    let response: AnthropicResponse = serde_json::from_value(value.clone())?;
    let usage = parse_usage(&response.usage)?;
    if let Some(results) = &response.safeguard_results {
        for result in results {
            parse_safeguard_result(result)?;
        }
    }
    Ok((response, usage))
}

fn number_field(map: &Map<String, Value>, key: &str, required: bool) -> anyhow::Result<()> {
    match map.get(key) {
        Some(Value::Number(_)) => Ok(()),
        Some(Value::Null) | None if !required => Ok(()),
        _ => anyhow::bail!("usage.{key} is not a number"),
    }
}

/// The usage object as the schema parses it: its known keys in the schema's order,
/// `output_tokens_details` and `iterations` reduced to their known keys, and every
/// other key after them as given.
fn parse_usage(usage: &Map<String, Value>) -> anyhow::Result<JsonObject> {
    number_field(usage, "input_tokens", true)?;
    number_field(usage, "output_tokens", true)?;
    number_field(usage, "cache_creation_input_tokens", false)?;
    number_field(usage, "cache_read_input_tokens", false)?;

    let mut parsed = Map::new();
    let known = [
        "input_tokens",
        "output_tokens",
        "output_tokens_details",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "iterations",
    ];
    for key in known {
        let Some(value) = usage.get(key) else {
            continue;
        };
        let value = match key {
            "output_tokens_details" => match value {
                Value::Null => Value::Null,
                Value::Object(details) => {
                    number_field(details, "thinking_tokens", false)?;
                    let mut out = Map::new();
                    if let Some(tokens) = details.get("thinking_tokens") {
                        out.insert("thinking_tokens".into(), tokens.clone());
                    }
                    Value::Object(out)
                }
                _ => anyhow::bail!("usage.output_tokens_details is not an object"),
            },
            "iterations" => match value {
                Value::Null => Value::Null,
                Value::Array(items) => {
                    let mut out = Vec::new();
                    for item in items {
                        out.push(parse_iteration(item)?);
                    }
                    Value::Array(out)
                }
                _ => anyhow::bail!("usage.iterations is not an array"),
            },
            _ => value.clone(),
        };
        parsed.insert(key.to_string(), value);
    }
    for (key, value) in usage {
        if !known.contains(&key.as_str()) {
            parsed.insert(key.clone(), value.clone());
        }
    }
    Ok(parsed)
}

fn parse_iteration(item: &Value) -> anyhow::Result<Value> {
    let Value::Object(item) = item else {
        anyhow::bail!("usage.iterations entry is not an object");
    };
    let kind = item.get("type").and_then(Value::as_str);
    if !matches!(
        kind,
        Some("compaction") | Some("message") | Some("advisor_message") | Some("fallback_message")
    ) {
        anyhow::bail!("usage.iterations entry has an unknown type");
    }
    match item.get("model") {
        None | Some(Value::Null) | Some(Value::String(_)) => {}
        _ => anyhow::bail!("usage.iterations entry model is not a string"),
    }
    number_field(item, "input_tokens", true)?;
    number_field(item, "output_tokens", true)?;
    number_field(item, "cache_creation_input_tokens", false)?;
    number_field(item, "cache_read_input_tokens", false)?;
    let mut out = Map::new();
    for key in [
        "type",
        "model",
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ] {
        if let Some(value) = item.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    Ok(Value::Object(out))
}

/// One safeguard result as the schema parses it.
fn parse_safeguard_result(value: &Value) -> anyhow::Result<Value> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("safeguard result type"))?;
    let status = value
        .get("status")
        .ok_or_else(|| anyhow::anyhow!("safeguard result status"))?;
    let status_kind = status
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("safeguard status type"))?;
    let mut status_out = Map::new();
    status_out.insert("type".into(), Value::from(status_kind));
    match status.get("tool_uses") {
        None => {}
        Some(Value::Null) => {
            status_out.insert("tool_uses".into(), Value::Null);
        }
        Some(Value::Object(uses)) => {
            let mut out = Map::new();
            for (id, entry) in uses {
                let entry_kind = entry
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("safeguard tool use type"))?;
                let mut parsed = Map::new();
                parsed.insert("type".into(), Value::from(entry_kind));
                for key in ["outcome", "explanation"] {
                    match entry.get(key) {
                        None => {}
                        Some(field @ (Value::Null | Value::String(_))) => {
                            parsed.insert(key.into(), field.clone());
                        }
                        _ => anyhow::bail!("safeguard tool use {key}"),
                    }
                }
                out.insert(id.clone(), Value::Object(parsed));
            }
            status_out.insert("tool_uses".into(), Value::Object(out));
        }
        _ => anyhow::bail!("safeguard tool uses"),
    }
    Ok(json!({ "type": kind, "status": status_out }))
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_f64).map(|f| f as i64)
}

/// `convertAnthropicUsage`: with iterations (compaction, the advisor), the
/// executor iterations' sums, unless a server-side fallback served the turn.
pub(super) fn convert_anthropic_usage(usage: &JsonObject) -> LanguageModelV4Usage {
    let cache_creation_tokens = as_i64(usage.get("cache_creation_input_tokens")).unwrap_or(0);
    let cache_read_tokens = as_i64(usage.get("cache_read_input_tokens")).unwrap_or(0);
    let reasoning_tokens = as_i64(
        usage
            .get("output_tokens_details")
            .and_then(|details| details.get("thinking_tokens")),
    );
    let top_input = as_i64(usage.get("input_tokens")).unwrap_or(0);
    let top_output = as_i64(usage.get("output_tokens")).unwrap_or(0);

    let iterations = usage.get("iterations").and_then(Value::as_array);
    let served_by_fallback = iterations.is_some_and(|items| {
        items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("fallback_message"))
    });
    let (input_tokens, output_tokens) = match iterations {
        Some(items) if !items.is_empty() && !served_by_fallback => {
            let executor: Vec<&Value> = items
                .iter()
                .filter(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("compaction") | Some("message")
                    )
                })
                .collect();
            if executor.is_empty() {
                (top_input, top_output)
            } else {
                executor.iter().fold((0, 0), |(input, output), item| {
                    (
                        input + as_i64(item.get("input_tokens")).unwrap_or(0),
                        output + as_i64(item.get("output_tokens")).unwrap_or(0),
                    )
                })
            }
        }
        _ => (top_input, top_output),
    };

    LanguageModelV4Usage {
        input_tokens: LanguageModelV4InputTokens {
            total: Some(input_tokens + cache_creation_tokens + cache_read_tokens),
            no_cache: Some(input_tokens),
            cache_read: Some(cache_read_tokens),
            cache_write: Some(cache_creation_tokens),
        },
        output_tokens: LanguageModelV4OutputTokens {
            total: Some(output_tokens),
            text: reasoning_tokens.map(|reasoning| output_tokens - reasoning),
            reasoning: reasoning_tokens,
        },
        raw: Some(usage.clone()),
    }
}

/// `mapAnthropicStopReason`.
pub(super) fn map_anthropic_stop_reason(
    finish_reason: Option<&str>,
    is_json_response_from_tool: bool,
) -> FinishReason {
    match finish_reason {
        Some("pause_turn") | Some("end_turn") | Some("stop_sequence") => FinishReason::Stop,
        Some("refusal") => FinishReason::ContentFilter,
        Some("tool_use") => {
            if is_json_response_from_tool {
                FinishReason::Stop
            } else {
                FinishReason::ToolCalls
            }
        }
        Some("max_tokens") | Some("model_context_window_exceeded") => FinishReason::Length,
        _ => FinishReason::Other,
    }
}

/// A document the prompt sent with citations on, which a citation can name.
#[derive(Debug, Clone)]
pub(super) struct CitationDocument {
    pub title: String,
    pub filename: Option<String>,
    pub media_type: String,
}

/// `createCitationSource`.
fn create_citation_source(
    citation: &Citation,
    documents: &[CitationDocument],
    generate_id: &dyn Fn() -> String,
) -> Option<LanguageModelV4Content> {
    match citation {
        Citation::WebSearchResultLocation {
            cited_text,
            url,
            title,
            encrypted_index,
        } => Some(LanguageModelV4Content::Source(LanguageModelV4Source::Url {
            id: generate_id(),
            url: url.clone(),
            title: title.clone(),
            provider_metadata: Some(anthropic_metadata(
                json!({ "citedText": cited_text, "encryptedIndex": encrypted_index })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            )),
        })),
        Citation::PageLocation {
            cited_text,
            document_index,
            document_title,
            start_page_number,
            end_page_number,
        } => {
            let document = documents.get(*document_index)?;
            Some(document_source(
                document,
                document_title,
                generate_id,
                json!({
                    "citedText": cited_text,
                    "startPageNumber": crate::support::js::number(*start_page_number),
                    "endPageNumber": crate::support::js::number(*end_page_number),
                }),
            ))
        }
        Citation::CharLocation {
            cited_text,
            document_index,
            document_title,
            start_char_index,
            end_char_index,
        } => {
            let document = documents.get(*document_index)?;
            Some(document_source(
                document,
                document_title,
                generate_id,
                json!({
                    "citedText": cited_text,
                    "startCharIndex": crate::support::js::number(*start_char_index),
                    "endCharIndex": crate::support::js::number(*end_char_index),
                }),
            ))
        }
        _ => None,
    }
}

fn document_source(
    document: &CitationDocument,
    document_title: &Option<String>,
    generate_id: &dyn Fn() -> String,
    metadata: Value,
) -> LanguageModelV4Content {
    LanguageModelV4Content::Source(LanguageModelV4Source::Document {
        id: generate_id(),
        media_type: document.media_type.clone(),
        title: document_title
            .clone()
            .unwrap_or_else(|| document.title.clone()),
        filename: document.filename.clone(),
        provider_metadata: Some(anthropic_metadata(
            metadata.as_object().cloned().unwrap_or_default(),
        )),
    })
}

/// A web search citation as the response's text metadata holds it.
fn web_search_citation_json(citation: &Citation) -> Option<Value> {
    let Citation::WebSearchResultLocation {
        cited_text,
        url,
        title,
        encrypted_index,
    } = citation
    else {
        return None;
    };
    Some(json!({
        "type": "web_search_result_location",
        "cited_text": cited_text,
        "url": url,
        "title": title,
        "encrypted_index": encrypted_index,
    }))
}

/// What the content mapping needs to know about the request.
pub(super) struct ContentContext<'a> {
    pub uses_json_response_tool: bool,
    pub tool_name_mapping: &'a ToolNameMapping,
    pub mark_code_execution_dynamic: bool,
    pub generate_id: &'a dyn Fn() -> String,
}

fn tool_call(
    id: &str,
    name: String,
    input: &Value,
    provider_executed: Option<bool>,
    dynamic: Option<bool>,
    provider_metadata: Option<ProviderMetadata>,
) -> LanguageModelV4Content {
    LanguageModelV4Content::ToolCall {
        tool_call_id: id.to_string(),
        tool_name: name,
        input: js_stringify(input),
        provider_executed,
        dynamic,
        provider_metadata,
    }
}

fn tool_result(
    tool_use_id: &str,
    name: String,
    result: Value,
    is_error: Option<bool>,
    provider_metadata: Option<ProviderMetadata>,
) -> LanguageModelV4Content {
    LanguageModelV4Content::ToolResult {
        tool_call_id: tool_use_id.to_string(),
        tool_name: name,
        result,
        is_error,
        preliminary: None,
        dynamic: None,
        provider_metadata,
    }
}

/// The response's content blocks as language model content, and whether the
/// JSON response tool answered.
pub(super) fn map_content(
    content: &[ResponseContent],
    citation_documents: &mut Vec<CitationDocument>,
    context: &ContentContext<'_>,
) -> (Vec<LanguageModelV4Content>, bool) {
    let mapping = context.tool_name_mapping;
    let mut out: Vec<LanguageModelV4Content> = Vec::new();
    let mut mcp_tool_calls: HashMap<String, (String, Option<ProviderMetadata>)> = HashMap::new();
    let mut server_tool_calls: HashMap<String, String> = HashMap::new();
    let mut is_json_response_from_tool = false;

    for part in content {
        match part {
            ResponseContent::Text { text, citations } => {
                if context.uses_json_response_tool {
                    continue;
                }
                let web_search: Vec<Value> = citations
                    .iter()
                    .flatten()
                    .filter_map(web_search_citation_json)
                    .collect();
                out.push(LanguageModelV4Content::Text {
                    text: text.clone(),
                    provider_metadata: (!web_search.is_empty()).then(|| {
                        anthropic_metadata(
                            json!({ "citations": web_search })
                                .as_object()
                                .cloned()
                                .unwrap_or_default(),
                        )
                    }),
                });
                for citation in citations.iter().flatten() {
                    if let Some(source) =
                        create_citation_source(citation, citation_documents, context.generate_id)
                    {
                        out.push(source);
                    }
                }
            }
            ResponseContent::Thinking {
                thinking,
                signature,
            } => {
                let mut anthropic = Map::new();
                anthropic.insert("signature".into(), Value::from(signature.clone()));
                out.push(LanguageModelV4Content::Reasoning {
                    text: thinking.clone(),
                    provider_metadata: Some(anthropic_metadata(anthropic)),
                });
            }
            ResponseContent::RedactedThinking { data } => {
                let mut anthropic = Map::new();
                anthropic.insert("redactedData".into(), Value::from(data.clone()));
                out.push(LanguageModelV4Content::Reasoning {
                    text: String::new(),
                    provider_metadata: Some(anthropic_metadata(anthropic)),
                });
            }
            ResponseContent::ContainerUpload { file_id } => {
                let mut anthropic = Map::new();
                anthropic.insert("fileId".into(), Value::from(file_id.clone()));
                out.push(LanguageModelV4Content::Custom {
                    kind: "anthropic.container_upload".to_string(),
                    provider_metadata: Some(anthropic_metadata(anthropic)),
                });
            }
            ResponseContent::Compaction { content, signature } => {
                let Some(text) = content.as_ref().filter(|text| !text.is_empty()) else {
                    continue;
                };
                let mut anthropic = Map::new();
                anthropic.insert("type".into(), Value::from("compaction"));
                if let Some(signature) = signature {
                    anthropic.insert("signature".into(), Value::from(signature.clone()));
                }
                out.push(LanguageModelV4Content::Text {
                    text: text.clone(),
                    provider_metadata: Some(anthropic_metadata(anthropic)),
                });
            }
            ResponseContent::ToolUse {
                id,
                name,
                input,
                caller,
                toolset_name,
            } => {
                if context.uses_json_response_tool && name == "json" {
                    is_json_response_from_tool = true;
                    // The JSON response tool's call is the answer's text.
                    out.push(LanguageModelV4Content::Text {
                        text: js_stringify(input),
                        provider_metadata: None,
                    });
                } else if let Some(toolset_name) = toolset_name {
                    // A toolset member call is a call of the toolset tool, with the
                    // member's name as the `action`.
                    let mut member_input = Map::new();
                    member_input.insert("action".into(), Value::from(name.clone()));
                    if let Value::Object(fields) = input {
                        for (key, value) in fields {
                            member_input.insert(key.clone(), value.clone());
                        }
                    }
                    let mut anthropic = Map::new();
                    anthropic.insert("toolsetName".into(), Value::from(toolset_name.clone()));
                    if let Some(caller) = caller {
                        anthropic.insert("caller".into(), caller.info());
                    }
                    out.push(tool_call(
                        id,
                        mapping.to_custom_tool_name(toolset_name),
                        &Value::Object(member_input),
                        None,
                        None,
                        Some(anthropic_metadata(anthropic)),
                    ));
                } else {
                    out.push(tool_call(
                        id,
                        name.clone(),
                        input,
                        None,
                        None,
                        caller_metadata(caller),
                    ));
                }
            }
            ResponseContent::ServerToolUse {
                id,
                name,
                input,
                caller,
            } => {
                let input_value = input
                    .as_ref()
                    .map(|map| Value::Object(map.clone()))
                    .unwrap_or(Value::Null);
                match name.as_str() {
                    "text_editor_code_execution" | "bash_code_execution" => {
                        let mut typed = Map::new();
                        typed.insert("type".into(), Value::from(name.clone()));
                        for (key, value) in input.iter().flatten() {
                            typed.insert(key.clone(), value.clone());
                        }
                        out.push(tool_call(
                            id,
                            mapping.to_custom_tool_name("code_execution"),
                            &Value::Object(typed),
                            Some(true),
                            context.mark_code_execution_dynamic.then_some(true),
                            caller_metadata(caller),
                        ));
                    }
                    "web_search" | "code_execution" | "web_fetch" => {
                        let serialized = match input {
                            Some(fields)
                                if name == "code_execution"
                                    && fields.contains_key("code")
                                    && !fields.contains_key("type") =>
                            {
                                let mut typed = Map::new();
                                typed.insert("type".into(), Value::from("programmatic-tool-call"));
                                for (key, value) in fields {
                                    typed.insert(key.clone(), value.clone());
                                }
                                Value::Object(typed)
                            }
                            _ => input_value,
                        };
                        out.push(tool_call(
                            id,
                            mapping.to_custom_tool_name(name),
                            &serialized,
                            Some(true),
                            (context.mark_code_execution_dynamic && name == "code_execution")
                                .then_some(true),
                            caller_metadata(caller),
                        ));
                    }
                    "tool_search_tool_regex" | "tool_search_tool_bm25" => {
                        server_tool_calls.insert(id.clone(), name.clone());
                        out.push(tool_call(
                            id,
                            mapping.to_custom_tool_name(name),
                            &input_value,
                            Some(true),
                            None,
                            caller_metadata(caller),
                        ));
                    }
                    "advisor" => {
                        out.push(tool_call(
                            id,
                            mapping.to_custom_tool_name("advisor"),
                            &input_value,
                            Some(true),
                            None,
                            caller_metadata(caller),
                        ));
                    }
                    _ => {}
                }
            }
            ResponseContent::McpToolUse {
                id,
                name,
                input,
                server_name,
            } => {
                let mut anthropic = Map::new();
                anthropic.insert("type".into(), Value::from("mcp-tool-use"));
                anthropic.insert("serverName".into(), Value::from(server_name.clone()));
                let metadata = anthropic_metadata(anthropic);
                mcp_tool_calls.insert(id.clone(), (name.clone(), Some(metadata.clone())));
                out.push(tool_call(
                    id,
                    name.clone(),
                    input,
                    Some(true),
                    Some(true),
                    Some(metadata),
                ));
            }
            ResponseContent::McpToolResult {
                tool_use_id,
                is_error,
                content,
            } => {
                let (name, metadata) = mcp_tool_calls.get(tool_use_id).cloned().unwrap_or_default();
                out.push(LanguageModelV4Content::ToolResult {
                    tool_call_id: tool_use_id.clone(),
                    tool_name: name,
                    result: content.clone(),
                    is_error: Some(*is_error),
                    preliminary: None,
                    dynamic: Some(true),
                    provider_metadata: metadata,
                });
            }
            ResponseContent::WebFetchToolResult {
                tool_use_id,
                caller,
                content,
            } => {
                let name = mapping.to_custom_tool_name("web_fetch");
                match content.get("type").and_then(Value::as_str) {
                    Some("web_fetch_result") => {
                        let document = &content["content"];
                        let source = &document["source"];
                        citation_documents.push(CitationDocument {
                            title: document
                                .get("title")
                                .and_then(Value::as_str)
                                .or_else(|| content.get("url").and_then(Value::as_str))
                                .unwrap_or_default()
                                .to_string(),
                            filename: None,
                            media_type: source
                                .get("media_type")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        });
                        let result = json!({
                            "type": "web_fetch_result",
                            "url": content.get("url"),
                            "retrievedAt": content.get("retrieved_at"),
                            "content": object([
                                ("type", document.get("type").cloned()),
                                ("title", document.get("title").cloned()),
                                ("citations", document.get("citations").cloned()),
                                (
                                    "source",
                                    Some(json!({
                                        "type": source.get("type"),
                                        "mediaType": source.get("media_type"),
                                        "data": source.get("data"),
                                    })),
                                ),
                            ]),
                        });
                        out.push(tool_result(
                            tool_use_id,
                            name,
                            result,
                            None,
                            caller_metadata(caller),
                        ));
                    }
                    Some("web_fetch_tool_result_error") => {
                        out.push(tool_result(
                            tool_use_id,
                            name,
                            json!({
                                "type": "web_fetch_tool_result_error",
                                "errorCode": content.get("error_code"),
                            }),
                            Some(true),
                            caller_metadata(caller),
                        ));
                    }
                    _ => {}
                }
            }
            ResponseContent::WebSearchToolResult {
                tool_use_id,
                caller,
                content,
            } => {
                let name = mapping.to_custom_tool_name("web_search");
                if let Value::Array(results) = content {
                    let mapped: Vec<Value> = results
                        .iter()
                        .map(|result| {
                            object([
                                ("url", result.get("url").cloned()),
                                (
                                    "title",
                                    result.get("title").filter(|t| !t.is_null()).cloned(),
                                ),
                                (
                                    "pageAge",
                                    Some(result.get("page_age").cloned().unwrap_or(Value::Null)),
                                ),
                                ("encryptedContent", result.get("encrypted_content").cloned()),
                                ("type", result.get("type").cloned()),
                            ])
                        })
                        .collect();
                    out.push(tool_result(
                        tool_use_id,
                        name,
                        Value::Array(mapped),
                        None,
                        caller_metadata(caller),
                    ));
                    for result in results {
                        let mut anthropic = Map::new();
                        anthropic.insert(
                            "pageAge".into(),
                            result.get("page_age").cloned().unwrap_or(Value::Null),
                        );
                        out.push(LanguageModelV4Content::Source(LanguageModelV4Source::Url {
                            id: (context.generate_id)(),
                            url: result
                                .get("url")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            title: result
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            provider_metadata: Some(anthropic_metadata(anthropic)),
                        }));
                    }
                } else {
                    out.push(tool_result(
                        tool_use_id,
                        name,
                        json!({
                            "type": "web_search_tool_result_error",
                            "errorCode": content.get("error_code"),
                        }),
                        Some(true),
                        caller_metadata(caller),
                    ));
                }
            }
            ResponseContent::CodeExecutionToolResult {
                tool_use_id,
                content,
            } => {
                let name = mapping.to_custom_tool_name("code_execution");
                let output_list = || content.get("content").cloned().unwrap_or_else(|| json!([]));
                match content.get("type").and_then(Value::as_str) {
                    Some("code_execution_result") => out.push(tool_result(
                        tool_use_id,
                        name,
                        json!({
                            "type": "code_execution_result",
                            "stdout": content.get("stdout"),
                            "stderr": content.get("stderr"),
                            "return_code": content.get("return_code"),
                            "content": output_list(),
                        }),
                        None,
                        None,
                    )),
                    Some("encrypted_code_execution_result") => out.push(tool_result(
                        tool_use_id,
                        name,
                        json!({
                            "type": "encrypted_code_execution_result",
                            "encrypted_stdout": content.get("encrypted_stdout"),
                            "stderr": content.get("stderr"),
                            "return_code": content.get("return_code"),
                            "content": output_list(),
                        }),
                        None,
                        None,
                    )),
                    Some("code_execution_tool_result_error") => out.push(tool_result(
                        tool_use_id,
                        name,
                        json!({
                            "type": "code_execution_tool_result_error",
                            "errorCode": content.get("error_code"),
                        }),
                        Some(true),
                        None,
                    )),
                    _ => {}
                }
            }
            ResponseContent::BashCodeExecutionToolResult {
                tool_use_id,
                content,
            }
            | ResponseContent::TextEditorCodeExecutionToolResult {
                tool_use_id,
                content,
            } => {
                out.push(tool_result(
                    tool_use_id,
                    mapping.to_custom_tool_name("code_execution"),
                    content.clone(),
                    None,
                    None,
                ));
            }
            ResponseContent::ToolSearchToolResult {
                tool_use_id,
                content,
            } => {
                let provider_tool_name = server_tool_calls
                    .get(tool_use_id)
                    .cloned()
                    .unwrap_or_else(|| {
                        if mapping.to_custom_tool_name("tool_search_tool_bm25")
                            != "tool_search_tool_bm25"
                        {
                            "tool_search_tool_bm25".to_string()
                        } else {
                            "tool_search_tool_regex".to_string()
                        }
                    });
                let name = mapping.to_custom_tool_name(&provider_tool_name);
                if content.get("type").and_then(Value::as_str)
                    == Some("tool_search_tool_search_result")
                {
                    let references: Vec<Value> = content
                        .get("tool_references")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|reference| {
                            json!({ "type": reference.get("type"), "toolName": reference.get("tool_name") })
                        })
                        .collect();
                    out.push(tool_result(
                        tool_use_id,
                        name,
                        Value::Array(references),
                        None,
                        None,
                    ));
                } else {
                    out.push(tool_result(
                        tool_use_id,
                        name,
                        json!({
                            "type": "tool_search_tool_result_error",
                            "errorCode": content.get("error_code"),
                        }),
                        Some(true),
                        None,
                    ));
                }
            }
            ResponseContent::AdvisorToolResult {
                tool_use_id,
                content,
            } => {
                let name = mapping.to_custom_tool_name("advisor");
                let stop_reason = content.get("stop_reason").filter(|v| !v.is_null()).cloned();
                match content.get("type").and_then(Value::as_str) {
                    Some("advisor_result") => out.push(tool_result(
                        tool_use_id,
                        name,
                        object([
                            ("type", Some(Value::from("advisor_result"))),
                            ("text", content.get("text").cloned()),
                            ("stopReason", stop_reason),
                        ]),
                        None,
                        None,
                    )),
                    Some("advisor_redacted_result") => out.push(tool_result(
                        tool_use_id,
                        name,
                        object([
                            ("type", Some(Value::from("advisor_redacted_result"))),
                            (
                                "encryptedContent",
                                content.get("encrypted_content").cloned(),
                            ),
                            ("stopReason", stop_reason),
                        ]),
                        None,
                        None,
                    )),
                    _ => out.push(tool_result(
                        tool_use_id,
                        name,
                        json!({
                            "type": "advisor_tool_result_error",
                            "errorCode": content.get("error_code"),
                        }),
                        Some(true),
                        None,
                    )),
                }
            }
            ResponseContent::Fallback { from, to } => {
                let mut anthropic = Map::new();
                anthropic.insert("type".into(), Value::from("fallback"));
                anthropic.insert("from".into(), json!({ "model": from.model }));
                anthropic.insert("to".into(), json!({ "model": to.model }));
                out.push(LanguageModelV4Content::Custom {
                    kind: "anthropic.fallback".to_string(),
                    provider_metadata: Some(anthropic_metadata(anthropic)),
                });
            }
        }
    }
    (out, is_json_response_from_tool)
}

/// The `anthropic` provider metadata of a response.
pub(super) fn response_metadata(response: &AnthropicResponse, usage: &JsonObject) -> JsonObject {
    let mut metadata = Map::new();
    metadata.insert("usage".into(), Value::Object(usage.clone()));
    metadata.insert(
        "stopSequence".into(),
        response
            .stop_sequence
            .clone()
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    if let Some(details) = &response.stop_details {
        metadata.insert(
            "stopDetails".into(),
            object([
                ("type", Some(Value::from(details.kind.clone()))),
                ("category", details.category.clone().map(Value::from)),
                ("explanation", details.explanation.clone().map(Value::from)),
                (
                    "recommendedModel",
                    details.recommended_model.clone().map(Value::from),
                ),
            ]),
        );
    }
    if let Some(transformations) = &response.input_transformations {
        metadata.insert(
            "inputTransformations".into(),
            Value::Array(
                transformations
                    .iter()
                    .map(|t| json!({ "type": t.kind, "path": t.path, "reason": t.reason }))
                    .collect(),
            ),
        );
    }
    if let Some(results) = &response.safeguard_results {
        metadata.insert(
            "safeguardResults".into(),
            Value::Array(
                results
                    .iter()
                    .filter_map(|result| parse_safeguard_result(result).ok())
                    .collect(),
            ),
        );
    }
    let iterations = match usage.get("iterations") {
        Some(Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|item| {
                    let truthy_number = |key: &str| {
                        item.get(key)
                            .filter(|value| value.as_f64().is_some_and(|n| n != 0.0))
                            .cloned()
                    };
                    object([
                        ("type", item.get("type").cloned()),
                        ("model", item.get("model").filter(|m| !m.is_null()).cloned()),
                        ("inputTokens", item.get("input_tokens").cloned()),
                        ("outputTokens", item.get("output_tokens").cloned()),
                        (
                            "cacheCreationInputTokens",
                            truthy_number("cache_creation_input_tokens"),
                        ),
                        (
                            "cacheReadInputTokens",
                            truthy_number("cache_read_input_tokens"),
                        ),
                    ])
                })
                .collect(),
        ),
        _ => Value::Null,
    };
    metadata.insert("iterations".into(), iterations);
    metadata.insert(
        "container".into(),
        match &response.container {
            Some(container) => json!({
                "expiresAt": container.expires_at,
                "id": container.id,
                "skills": container.skills.as_ref().map(|skills| {
                    skills
                        .iter()
                        .map(|skill| json!({
                            "type": skill.kind,
                            "skillId": skill.skill_id,
                            "version": skill.version,
                        }))
                        .collect::<Vec<_>>()
                }),
            }),
            None => Value::Null,
        },
    );
    metadata.insert(
        "contextManagement".into(),
        match &response.context_management {
            Some(management) => json!({
                "appliedEdits": management
                    .applied_edits
                    .iter()
                    .map(|edit| match edit {
                        AppliedEdit::ClearToolUses { cleared_tool_uses, cleared_input_tokens } => json!({
                            "type": "clear_tool_uses_20250919",
                            "clearedToolUses": crate::support::js::number(*cleared_tool_uses),
                            "clearedInputTokens": crate::support::js::number(*cleared_input_tokens),
                        }),
                        AppliedEdit::ClearThinking { cleared_thinking_turns, cleared_input_tokens } => json!({
                            "type": "clear_thinking_20251015",
                            "clearedThinkingTurns": crate::support::js::number(*cleared_thinking_turns),
                            "clearedInputTokens": crate::support::js::number(*cleared_input_tokens),
                        }),
                        AppliedEdit::Compact => json!({ "type": "compact_20260112" }),
                    })
                    .collect::<Vec<_>>(),
            }),
            None => Value::Null,
        },
    );
    metadata
}
