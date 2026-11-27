//! `convertToAnthropicPrompt`: the language model prompt as the Messages API's
//! `system` and `messages`, with the betas the content needs.

use std::collections::HashSet;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};

use super::cache_control::{CacheContext, CacheControlValidator, cacheable};
use super::options::{
    AnthropicFilePartOptions, AnthropicReasoningMetadata, AnthropicSystemMessageOptions,
    parse_provider_options,
};
use crate::ai::json::{base64_to_bytes, js_stringify, secure_json_parse};
use crate::ai::prompt::{detect_image_media_type, is_full_media_type};
use crate::ai::providers::provider_utils::ToolNameMapping;
use crate::ai::{
    DataContent, FileData, LanguageModelV4Message, LanguageModelV4Part, ProviderOptions,
    ProviderReference, ToolResultContentPart, ToolResultOutput, UnsupportedFunctionalityError,
    Warning,
};

/// The Messages API prompt: the top-level `system` blocks and the messages.
pub(super) struct AnthropicPrompt {
    pub system: Option<Vec<Value>>,
    pub messages: Vec<Value>,
}

/// What `convert_to_anthropic_prompt` returns.
pub(super) struct ConvertedPrompt {
    pub prompt: AnthropicPrompt,
    pub betas: IndexSet<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    System,
    Assistant,
    User,
}

struct Block<'a> {
    kind: BlockKind,
    messages: Vec<&'a LanguageModelV4Message>,
}

/// Groups consecutive messages that become one Anthropic message: system messages,
/// assistant messages, and user and tool messages together.
fn group_into_blocks(prompt: &[LanguageModelV4Message]) -> Vec<Block<'_>> {
    let mut blocks: Vec<Block<'_>> = Vec::new();
    for message in prompt {
        let kind = match message {
            LanguageModelV4Message::System { .. } => BlockKind::System,
            LanguageModelV4Message::Assistant { .. } => BlockKind::Assistant,
            LanguageModelV4Message::User { .. } | LanguageModelV4Message::Tool { .. } => {
                BlockKind::User
            }
        };
        match blocks.last_mut() {
            Some(block) if block.kind == kind => block.messages.push(message),
            _ => blocks.push(Block {
                kind,
                messages: vec![message],
            }),
        }
    }
    blocks
}

/// An object from `(key, value)` pairs, leaving out the `None` ones, as
/// `JSON.stringify` leaves out an `undefined` property.
pub(super) fn object<const N: usize>(entries: [(&str, Option<Value>); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

fn text(value: &str) -> Option<Value> {
    Some(Value::from(value))
}

/// `getTopLevelMediaType`.
fn top_level_media_type(media_type: &str) -> &str {
    match media_type.find('/') {
        Some(index) => &media_type[..index],
        None => media_type,
    }
}

/// The first bytes of inline data, for media type sniffing.
fn data_prefix(data: &DataContent, max_bytes: usize) -> anyhow::Result<Vec<u8>> {
    match data {
        DataContent::Bytes(bytes) => Ok(bytes[..bytes.len().min(max_bytes)].to_vec()),
        DataContent::Base64(text) => {
            let max_chars = max_bytes.div_ceil(3) * 4;
            let cut: String = text.chars().take(max_chars).collect();
            let mut bytes = base64_to_bytes(&cut).map_err(anyhow::Error::msg)?;
            bytes.truncate(max_bytes);
            Ok(bytes)
        }
    }
}

/// `detectMediaType({ data, topLevelType })` for the top-level types a Messages
/// prompt can hold.
fn detect_media_type(data: &DataContent, top_level: &str) -> anyhow::Result<Option<String>> {
    match top_level {
        "image" => Ok(detect_image_media_type(data)?.map(str::to_string)),
        "application" => {
            let prefix = data_prefix(data, 4)?;
            Ok((prefix == b"%PDF").then(|| "application/pdf".to_string()))
        }
        _ => Ok(None),
    }
}

/// `resolveFullMediaType({ part })`: the part's media type when it names a
/// subtype, else the type sniffed from inline bytes.
fn resolve_full_media_type(media_type: &str, data: &FileData) -> anyhow::Result<String> {
    if is_full_media_type(media_type) {
        return Ok(media_type.to_string());
    }
    if let FileData::Data { data } = data {
        if let Some(detected) = detect_media_type(data, top_level_media_type(media_type))? {
            return Ok(detected);
        }
        return Err(UnsupportedFunctionalityError::new(&format!(
            "file of media type \"{media_type}\" must specify subtype since it could not be auto-detected"
        ))
        .into());
    }
    Err(UnsupportedFunctionalityError::new(&format!(
        "file of media type \"{media_type}\" must specify subtype since it is not passed as inline bytes"
    ))
    .into())
}

/// `resolveProviderReference({ reference, provider: 'anthropic' })`.
fn resolve_provider_reference(reference: &ProviderReference) -> anyhow::Result<String> {
    match reference.get("anthropic") {
        Some(id) => Ok(id.clone()),
        None => {
            let available = reference.keys().cloned().collect::<Vec<_>>().join(", ");
            Err(anyhow::anyhow!(
                "No provider reference found for provider 'anthropic'. Available providers: {available}"
            ))
        }
    }
}

/// `new TextDecoder().decode(bytes)`: UTF-8 with replacement characters, without a
/// leading byte order mark.
fn decode_text(data: &DataContent) -> anyhow::Result<String> {
    let bytes = match data {
        DataContent::Bytes(bytes) => bytes.to_vec(),
        DataContent::Base64(text) => base64_to_bytes(text).map_err(anyhow::Error::msg)?,
    };
    let decoded = String::from_utf8_lossy(&bytes).into_owned();
    Ok(match decoded.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => decoded,
    })
}

fn file_options(
    provider_options: Option<&ProviderOptions>,
) -> anyhow::Result<AnthropicFilePartOptions> {
    Ok(
        parse_provider_options::<AnthropicFilePartOptions>("anthropic", provider_options, |_| {
            true
        })?
        .unwrap_or_default(),
    )
}

/// `{ title, context?, citations? }` of a document block.
fn document_extras(
    options: &AnthropicFilePartOptions,
    filename: Option<&String>,
) -> [(&'static str, Option<Value>); 3] {
    let enable_citations = options
        .citations
        .as_ref()
        .is_some_and(|citations| citations.enabled);
    [
        (
            "title",
            options
                .title
                .clone()
                .or_else(|| filename.cloned())
                .map(Value::from),
        ),
        (
            "context",
            options
                .context
                .clone()
                .filter(|context| !context.is_empty())
                .map(Value::from),
        ),
        (
            "citations",
            enable_citations.then(|| json!({ "enabled": true })),
        ),
    ]
}

fn document(
    source: Value,
    options: &AnthropicFilePartOptions,
    filename: Option<&String>,
    cache_control: Option<Value>,
) -> Value {
    let [title, context, citations] = document_extras(options, filename);
    object([
        ("type", text("document")),
        ("source", Some(source)),
        title,
        context,
        citations,
        ("cache_control", cache_control),
    ])
}

fn url_source(url: &str) -> Value {
    json!({ "type": "url", "url": url })
}

/// One file part of a user message as an image, document or container upload.
fn user_file_block(
    filename: Option<&String>,
    data: &FileData,
    media_type: &str,
    provider_options: Option<&ProviderOptions>,
    cache_control: Option<Value>,
    betas: &mut IndexSet<String>,
) -> anyhow::Result<Value> {
    match data {
        FileData::Reference { reference } => {
            let file_id = resolve_provider_reference(reference)?;
            betas.insert("files-api-2025-04-14".to_string());
            if file_options(provider_options)?.container_upload == Some(true) {
                return Ok(json!({ "type": "container_upload", "file_id": file_id }));
            }
            let kind = if top_level_media_type(media_type) == "image" {
                "image"
            } else {
                "document"
            };
            Ok(object([
                ("type", text(kind)),
                (
                    "source",
                    Some(json!({ "type": "file", "file_id": file_id })),
                ),
                ("cache_control", cache_control),
            ]))
        }
        FileData::Text { text: content } => {
            let options = file_options(provider_options)?;
            let source = json!({ "type": "text", "media_type": "text/plain", "data": content });
            Ok(document(source, &options, filename, cache_control))
        }
        FileData::Url { .. } | FileData::Data { .. } => {
            let top_level = top_level_media_type(media_type);
            if top_level == "image" {
                let source = match data {
                    FileData::Url { url, .. } => url_source(url),
                    FileData::Data { data: inline } => json!({
                        "type": "base64",
                        "media_type": resolve_full_media_type(media_type, data)?,
                        "data": inline.to_base64(),
                    }),
                    _ => unreachable!("the outer match takes only url and data"),
                };
                return Ok(object([
                    ("type", text("image")),
                    ("source", Some(source)),
                    ("cache_control", cache_control),
                ]));
            }
            let is_pdf = top_level == "application"
                && match data {
                    FileData::Url { .. } => media_type == "application/pdf",
                    _ => resolve_full_media_type(media_type, data)? == "application/pdf",
                };
            if is_pdf {
                betas.insert("pdfs-2024-09-25".to_string());
                let options = file_options(provider_options)?;
                let source = match data {
                    FileData::Url { url, .. } => url_source(url),
                    FileData::Data { data: inline } => json!({
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": inline.to_base64(),
                    }),
                    _ => unreachable!("the outer match takes only url and data"),
                };
                return Ok(document(source, &options, filename, cache_control));
            }
            if media_type == "text/plain" {
                let options = file_options(provider_options)?;
                let source = match data {
                    FileData::Url { url, .. } => url_source(url),
                    FileData::Data { data: inline } => json!({
                        "type": "text",
                        "media_type": "text/plain",
                        "data": decode_text(inline)?,
                    }),
                    _ => unreachable!("the outer match takes only url and data"),
                };
                return Ok(document(source, &options, filename, cache_control));
            }
            Err(UnsupportedFunctionalityError::new(&format!("media type: {media_type}")).into())
        }
    }
}

/// One item of a `content` tool result, or `None` (with a warning) for an item
/// the API cannot hold.
fn tool_result_content_item(
    part: &ToolResultContentPart,
    warnings: &mut Vec<Warning>,
    betas: &mut IndexSet<String>,
) -> anyhow::Result<Option<Value>> {
    let other = |message: String| Warning::Other { message };
    match part {
        ToolResultContentPart::Text { text: value, .. } => {
            Ok(Some(json!({ "type": "text", "text": value })))
        }
        ToolResultContentPart::File {
            data, media_type, ..
        } => {
            let top_level = top_level_media_type(media_type);
            match data {
                FileData::Url { url, .. } => {
                    let kind = if top_level == "image" {
                        "image"
                    } else {
                        "document"
                    };
                    Ok(Some(json!({ "type": kind, "source": url_source(url) })))
                }
                FileData::Data { data: inline } => {
                    if top_level == "image" {
                        return Ok(Some(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": resolve_full_media_type(media_type, data)?,
                                "data": inline.to_base64(),
                            },
                        })));
                    }
                    if resolve_full_media_type(media_type, data)? == "application/pdf" {
                        betas.insert("pdfs-2024-09-25".to_string());
                        return Ok(Some(json!({
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": inline.to_base64(),
                            },
                        })));
                    }
                    warnings.push(other(format!(
                        "unsupported tool content part type: file with media type: {media_type}"
                    )));
                    Ok(None)
                }
                FileData::Reference { .. } => {
                    warnings.push(other(
                        "unsupported tool content part type: file with data type: reference"
                            .to_string(),
                    ));
                    Ok(None)
                }
                FileData::Text { .. } => {
                    warnings.push(other(
                        "unsupported tool content part type: file with data type: text".to_string(),
                    ));
                    Ok(None)
                }
            }
        }
        ToolResultContentPart::Custom { provider_options } => {
            let anthropic = provider_options
                .as_ref()
                .and_then(|options| options.get("anthropic"));
            if anthropic
                .and_then(|options| options.get("type"))
                .and_then(Value::as_str)
                == Some("tool-reference")
            {
                let tool_name = anthropic
                    .and_then(|options| options.get("toolName"))
                    .filter(|value| !value.is_null())
                    .cloned();
                return Ok(Some(object([
                    ("type", text("tool_reference")),
                    ("tool_name", tool_name),
                ])));
            }
            warnings.push(other("unsupported custom tool content part".to_string()));
            Ok(None)
        }
        other_part => {
            let kind = serde_json::to_value(other_part)
                .ok()
                .and_then(|value| {
                    value
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            warnings.push(other(format!("unsupported tool content part type: {kind}")));
            Ok(None)
        }
    }
}

fn tool_result_content_part_options(part: &ToolResultContentPart) -> Option<&ProviderOptions> {
    let value = match part {
        ToolResultContentPart::Text {
            provider_options, ..
        }
        | ToolResultContentPart::File {
            provider_options, ..
        }
        | ToolResultContentPart::FileData {
            provider_options, ..
        }
        | ToolResultContentPart::FileUrl {
            provider_options, ..
        }
        | ToolResultContentPart::FileId {
            provider_options, ..
        }
        | ToolResultContentPart::FileReference {
            provider_options, ..
        }
        | ToolResultContentPart::ImageData {
            provider_options, ..
        }
        | ToolResultContentPart::ImageUrl {
            provider_options, ..
        }
        | ToolResultContentPart::ImageFileId {
            provider_options, ..
        }
        | ToolResultContentPart::ImageFileReference {
            provider_options, ..
        }
        | ToolResultContentPart::Custom { provider_options } => provider_options,
    };
    value.as_ref()
}

/// The `providerOptions` of a tool result output: its own, or for a `content`
/// output those of its first item that has some.
fn output_provider_options(output: &ToolResultOutput) -> Option<&ProviderOptions> {
    match output {
        ToolResultOutput::Text {
            provider_options, ..
        }
        | ToolResultOutput::Json {
            provider_options, ..
        }
        | ToolResultOutput::ExecutionDenied {
            provider_options, ..
        }
        | ToolResultOutput::ErrorText {
            provider_options, ..
        }
        | ToolResultOutput::ErrorJson {
            provider_options, ..
        } => provider_options.as_ref(),
        ToolResultOutput::Content { value } => {
            value.iter().find_map(tool_result_content_part_options)
        }
    }
}

/// The Anthropic `toolset_name` of a tool call or result: from the request's
/// toolset tools, else from the `toolsetName` metadata of an earlier response.
fn get_anthropic_toolset_name(
    tool_name: &str,
    provider_options: Option<&ProviderOptions>,
    toolset_names: &IndexMap<String, String>,
) -> Option<String> {
    if let Some(name) = toolset_names.get(tool_name) {
        return Some(name.clone());
    }
    provider_options
        .and_then(|options| options.get("anthropic"))
        .and_then(|options| options.get("toolsetName"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The `caller` an earlier response gave a tool call, in the API's form.
fn get_anthropic_caller(provider_options: Option<&ProviderOptions>) -> Option<Value> {
    let caller = provider_options
        .and_then(|options| options.get("anthropic"))
        .and_then(|options| options.get("caller"))?;
    let kind = caller.get("type").and_then(Value::as_str);
    if matches!(
        kind,
        Some("code_execution_20250825") | Some("code_execution_20260120")
    ) && let Some(tool_id) = caller
        .get("toolId")
        .filter(|id| super::cache_control::is_truthy(id))
    {
        return Some(json!({ "type": kind, "tool_id": tool_id }));
    }
    (kind == Some("direct")).then(|| json!({ "type": "direct" }))
}

/// Anthropic requires a tool input to be an object; any other value is wrapped.
fn to_anthropic_tool_input(input: &Value) -> Value {
    match input {
        Value::Object(_) => input.clone(),
        other => json!({ "rawInvalidInput": other }),
    }
}

/// `extractErrorValue`: the `errorCode` of a provider tool's error result.
fn extract_error_code(value: &Value) -> Option<String> {
    let parsed = match value {
        Value::String(text) => match secure_json_parse(text) {
            Ok(parsed) => parsed,
            Err(_) => return Some("unavailable".to_string()),
        },
        other => other.clone(),
    };
    parsed
        .get("errorCode")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn with_caller(mut block: Value, caller: &Option<Value>, cache_control: Option<Value>) -> Value {
    if let Value::Object(map) = &mut block {
        if let Some(caller) = caller {
            map.insert("caller".into(), caller.clone());
        }
        if let Some(cache_control) = cache_control {
            map.insert("cache_control".into(), cache_control);
        }
    }
    block
}

/// `convertToAnthropicPrompt`.
pub(super) fn convert_to_anthropic_prompt(
    prompt: &[LanguageModelV4Message],
    send_reasoning: bool,
    warnings: &mut Vec<Warning>,
    validator: &mut CacheControlValidator,
    tool_name_mapping: &ToolNameMapping,
    toolset_names: &IndexMap<String, String>,
) -> anyhow::Result<ConvertedPrompt> {
    let mut betas: IndexSet<String> = IndexSet::new();
    let blocks = group_into_blocks(prompt);
    let mut system: Option<Vec<Value>> = None;
    let mut messages: Vec<Value> = Vec::new();
    let mut last_user_message_index: Option<usize> = None;

    for (i, block) in blocks.iter().enumerate() {
        let is_last_block = i == blocks.len() - 1;
        match block.kind {
            BlockKind::System => convert_system_block(
                block,
                i,
                &mut system,
                &mut messages,
                &mut betas,
                warnings,
                validator,
                tool_name_mapping,
            )?,
            BlockKind::User => {
                let mut content: Vec<Value> = Vec::new();
                for message in &block.messages {
                    match message {
                        LanguageModelV4Message::User {
                            content: parts,
                            provider_options: message_options,
                        } => {
                            if !parts.is_empty() {
                                last_user_message_index = Some(messages.len());
                            }
                            for (j, part) in parts.iter().enumerate() {
                                let is_last_part = j == parts.len() - 1;
                                let cache_control = validator
                                    .get_cache_control(
                                        part.provider_options(),
                                        cacheable("user message part"),
                                    )
                                    .or_else(|| {
                                        if is_last_part {
                                            validator.get_cache_control(
                                                message_options.as_ref(),
                                                cacheable("user message"),
                                            )
                                        } else {
                                            None
                                        }
                                    });
                                match part {
                                    LanguageModelV4Part::Text { text: value, .. } => {
                                        content.push(object([
                                            ("type", text("text")),
                                            ("text", text(value)),
                                            ("cache_control", cache_control),
                                        ]));
                                    }
                                    LanguageModelV4Part::File {
                                        filename,
                                        data,
                                        media_type,
                                        provider_options,
                                    } => {
                                        content.push(user_file_block(
                                            filename.as_ref(),
                                            data,
                                            media_type,
                                            provider_options.as_ref(),
                                            cache_control,
                                            &mut betas,
                                        )?);
                                    }
                                    _ => {}
                                }
                            }
                        }
                        LanguageModelV4Message::Tool {
                            content: parts,
                            provider_options: message_options,
                        } => {
                            for (j, part) in parts.iter().enumerate() {
                                let LanguageModelV4Part::ToolResult {
                                    tool_call_id,
                                    tool_name,
                                    output,
                                    provider_options,
                                } = part
                                else {
                                    continue;
                                };
                                let is_last_part = j == parts.len() - 1;
                                let cache_control = validator
                                    .get_cache_control(
                                        provider_options.as_ref(),
                                        cacheable("tool result part"),
                                    )
                                    .or_else(|| {
                                        validator.get_cache_control(
                                            output_provider_options(output),
                                            cacheable("tool result output"),
                                        )
                                    })
                                    .or_else(|| {
                                        if is_last_part {
                                            validator.get_cache_control(
                                                message_options.as_ref(),
                                                cacheable("tool result message"),
                                            )
                                        } else {
                                            None
                                        }
                                    });

                                let content_value = match output {
                                    ToolResultOutput::Content { value } => {
                                        let mut items = Vec::new();
                                        for item in value {
                                            if let Some(item) = tool_result_content_item(
                                                item, warnings, &mut betas,
                                            )? {
                                                items.push(item);
                                            }
                                        }
                                        Value::Array(items)
                                    }
                                    ToolResultOutput::Text { value, .. }
                                    | ToolResultOutput::ErrorText { value, .. } => {
                                        Value::from(value.clone())
                                    }
                                    ToolResultOutput::ExecutionDenied { reason, .. } => {
                                        Value::from(reason.clone().unwrap_or_else(|| {
                                            "Tool call execution denied.".to_string()
                                        }))
                                    }
                                    ToolResultOutput::Json { value, .. }
                                    | ToolResultOutput::ErrorJson { value, .. } => {
                                        Value::from(js_stringify(value))
                                    }
                                };
                                let toolset_name = get_anthropic_toolset_name(
                                    tool_name,
                                    provider_options.as_ref(),
                                    toolset_names,
                                );
                                let is_error = matches!(
                                    output,
                                    ToolResultOutput::ErrorText { .. }
                                        | ToolResultOutput::ErrorJson { .. }
                                );
                                content.push(object([
                                    ("type", text("tool_result")),
                                    ("tool_use_id", text(tool_call_id)),
                                    ("toolset_name", toolset_name.map(Value::from)),
                                    ("content", Some(content_value)),
                                    ("is_error", is_error.then_some(Value::Bool(true))),
                                    ("cache_control", cache_control),
                                ]));
                            }
                        }
                        _ => unreachable!("a user block holds user and tool messages"),
                    }
                }
                messages.push(json!({ "role": "user", "content": content }));
            }
            BlockKind::Assistant => {
                let content = convert_assistant_block(
                    block,
                    is_last_block,
                    send_reasoning,
                    &mut betas,
                    warnings,
                    validator,
                    tool_name_mapping,
                    toolset_names,
                )?;
                if !content.is_empty() {
                    messages.push(json!({
                        "role": "assistant",
                        "content": move_tool_use_blocks_to_end(content),
                    }));
                }
            }
        }
    }

    omit_orphan_callers(&mut messages, last_user_message_index, warnings);

    Ok(ConvertedPrompt {
        prompt: AnthropicPrompt { system, messages },
        betas,
    })
}

struct ConvertedSystemMessage {
    content: Vec<Value>,
    clear_at: bool,
    effort: Option<&'static str>,
    tool_change_count: usize,
}

#[allow(clippy::too_many_arguments)]
fn convert_system_block(
    block: &Block<'_>,
    index: usize,
    system: &mut Option<Vec<Value>>,
    messages: &mut Vec<Value>,
    betas: &mut IndexSet<String>,
    warnings: &mut Vec<Warning>,
    validator: &mut CacheControlValidator,
    tool_name_mapping: &ToolNameMapping,
) -> anyhow::Result<()> {
    let mut converted: Vec<ConvertedSystemMessage> = Vec::new();
    for message in &block.messages {
        let LanguageModelV4Message::System {
            content: message_text,
            provider_options,
        } = message
        else {
            unreachable!("a system block holds system messages");
        };
        let options = parse_provider_options::<AnthropicSystemMessageOptions>(
            "anthropic",
            provider_options.as_ref(),
            |_| true,
        )?
        .unwrap_or_default();
        let tool_changes = options.tool_changes.clone().unwrap_or_default();
        let mut content: Vec<Value> = Vec::new();

        // A system message that only has message-level controls may have empty text;
        // it gets no empty text block.
        if !message_text.is_empty()
            || (tool_changes.is_empty() && options.clear_at.is_none() && options.effort.is_none())
        {
            let cache_control =
                validator.get_cache_control(provider_options.as_ref(), cacheable("system message"));
            content.push(object([
                ("type", text("text")),
                ("text", text(message_text)),
                ("cache_control", cache_control),
            ]));
        }
        for change in &tool_changes {
            content.push(json!({
                "type": change.kind.as_str(),
                "tool": {
                    "type": "tool_reference",
                    "name": tool_name_mapping.to_provider_tool_name(&change.tool_name),
                },
            }));
        }
        converted.push(ConvertedSystemMessage {
            content,
            clear_at: options.clear_at.is_some(),
            effort: options.effort.map(|effort| effort.as_str()),
            tool_change_count: tool_changes.len(),
        });
    }

    let tool_change_count: usize = converted.iter().map(|m| m.tool_change_count).sum();
    let has_inline_system_options = converted.iter().any(|m| m.clear_at || m.effort.is_some());
    if index == 0 || (system.is_none() && tool_change_count == 0 && !has_inline_system_options) {
        if tool_change_count > 0 {
            warnings.push(Warning::Other {
                message: "tool changes on the initial system message are not supported by Anthropic. Configure the initial tool set via the tools option instead. The tool changes have been ignored.".to_string(),
            });
        }
        // Initial instruction text goes in the top-level system field. Effort-only
        // messages stay in the messages array.
        for message in &converted {
            if message.content.is_empty() && !message.clear_at && message.effort.is_some() {
                messages.push(json!({
                    "role": "system",
                    "content": [],
                    "output_config": { "effort": message.effort },
                }));
                betas.insert("mid-conversation-output-config-2026-07-01".to_string());
            } else if message.clear_at || message.effort.is_some() {
                warnings.push(Warning::Other {
                    message: "clearAt and effort on this initial system message are not supported by Anthropic. Use a separate effort-only system message with empty content to set effort. These options have been ignored.".to_string(),
                });
            }
        }
        *system = Some(
            converted
                .iter()
                .flat_map(|message| message.content.iter())
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .cloned()
                .collect(),
        );
    } else {
        betas.insert("mid-conversation-system-2026-04-07".to_string());
        for message in converted {
            messages.push(object([
                ("role", text("system")),
                ("content", Some(Value::Array(message.content))),
                (
                    "clear_at",
                    message.clear_at.then(|| Value::from("next_user_message")),
                ),
                (
                    "output_config",
                    message.effort.map(|effort| json!({ "effort": effort })),
                ),
            ]));
            if message.tool_change_count > 0 {
                betas.insert("mid-conversation-tool-changes-2026-07-01".to_string());
            }
            if message.clear_at {
                betas.insert("mid-conversation-system-clear-at-2026-08-21".to_string());
            }
            if message.effort.is_some() {
                betas.insert("mid-conversation-output-config-2026-07-01".to_string());
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn convert_assistant_block(
    block: &Block<'_>,
    is_last_block: bool,
    send_reasoning: bool,
    betas: &mut IndexSet<String>,
    warnings: &mut Vec<Warning>,
    validator: &mut CacheControlValidator,
    tool_name_mapping: &ToolNameMapping,
    toolset_names: &IndexMap<String, String>,
) -> anyhow::Result<Vec<Value>> {
    let mut content: Vec<Value> = Vec::new();
    let mut mcp_tool_use_ids: HashSet<String> = HashSet::new();
    let other = |message: String| Warning::Other { message };

    for (j, message) in block.messages.iter().enumerate() {
        let is_last_message = j == block.messages.len() - 1;
        let LanguageModelV4Message::Assistant {
            content: parts,
            provider_options: message_options,
        } = message
        else {
            unreachable!("an assistant block holds assistant messages");
        };
        for (k, part) in parts.iter().enumerate() {
            let is_last_content_part = k == parts.len() - 1;
            let cache_control = validator
                .get_cache_control(part.provider_options(), cacheable("assistant message part"))
                .or_else(|| {
                    if is_last_content_part {
                        validator.get_cache_control(
                            message_options.as_ref(),
                            cacheable("assistant message"),
                        )
                    } else {
                        None
                    }
                });

            match part {
                LanguageModelV4Part::Text {
                    text: value,
                    provider_options,
                } => {
                    let metadata = provider_options
                        .as_ref()
                        .and_then(|options| options.get("anthropic"));
                    if metadata.and_then(|m| m.get("type")).and_then(Value::as_str)
                        == Some("compaction")
                    {
                        if value.is_empty() {
                            continue;
                        }
                        let signature = metadata
                            .and_then(|m| m.get("signature"))
                            .filter(|s| s.is_string())
                            .cloned();
                        if signature.is_some() {
                            betas.insert("compact-2026-09-04".to_string());
                        }
                        content.push(object([
                            ("type", text("compaction")),
                            ("content", text(value)),
                            ("signature", signature),
                            ("cache_control", cache_control),
                        ]));
                    } else {
                        let sent = if is_last_block && is_last_message && is_last_content_part {
                            crate::support::js::trim(value)
                        } else {
                            value.as_str()
                        };
                        let citations = metadata
                            .and_then(|m| m.get("citations"))
                            .filter(|c| !c.is_null())
                            .cloned();
                        content.push(object([
                            ("type", text("text")),
                            ("text", text(sent)),
                            ("citations", citations),
                            ("cache_control", cache_control),
                        ]));
                    }
                }

                LanguageModelV4Part::Reasoning {
                    text: value,
                    provider_options,
                } => {
                    if !send_reasoning {
                        warnings.push(other(
                            "sending reasoning content is disabled for this model".to_string(),
                        ));
                        continue;
                    }
                    let metadata = parse_provider_options::<AnthropicReasoningMetadata>(
                        "anthropic",
                        provider_options.as_ref(),
                        |_| true,
                    )?;
                    match metadata {
                        Some(AnthropicReasoningMetadata {
                            signature: Some(signature),
                            ..
                        }) => {
                            // Thinking blocks are cached implicitly in earlier turns and
                            // take no breakpoint of their own.
                            validator.get_cache_control(
                                provider_options.as_ref(),
                                CacheContext {
                                    kind: "thinking block",
                                    can_cache: false,
                                },
                            );
                            content.push(json!({
                                "type": "thinking",
                                "thinking": value,
                                "signature": signature,
                            }));
                        }
                        Some(AnthropicReasoningMetadata {
                            redacted_data: Some(data),
                            ..
                        }) => {
                            validator.get_cache_control(
                                provider_options.as_ref(),
                                CacheContext {
                                    kind: "redacted thinking block",
                                    can_cache: false,
                                },
                            );
                            content.push(json!({ "type": "redacted_thinking", "data": data }));
                        }
                        _ => warnings.push(other("unsupported reasoning metadata".to_string())),
                    }
                }

                LanguageModelV4Part::Custom {
                    kind,
                    provider_options,
                } => {
                    if kind != "anthropic.fallback" {
                        continue;
                    }
                    let fallback = provider_options
                        .as_ref()
                        .and_then(|options| options.get("anthropic"))
                        .and_then(fallback_content);
                    let Some((from, to)) = fallback else {
                        warnings.push(other(
                            "anthropic fallback metadata must include from.model and to.model"
                                .to_string(),
                        ));
                        continue;
                    };
                    betas.insert("server-side-fallback-2026-06-01".to_string());
                    content.push(json!({
                        "type": "fallback",
                        "from": { "model": from },
                        "to": { "model": to },
                    }));
                }

                LanguageModelV4Part::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                    provider_executed,
                    provider_options,
                } => {
                    let caller = get_anthropic_caller(provider_options.as_ref());
                    if provider_executed == &Some(true) {
                        if let Some(block) = provider_executed_tool_call(
                            tool_call_id,
                            tool_name,
                            input,
                            provider_options.as_ref(),
                            &caller,
                            cache_control,
                            tool_name_mapping,
                            &mut mcp_tool_use_ids,
                            warnings,
                        ) {
                            content.push(block);
                        }
                        continue;
                    }

                    let toolset_name = get_anthropic_toolset_name(
                        tool_name,
                        provider_options.as_ref(),
                        toolset_names,
                    );
                    if let Some(toolset_name) = toolset_name {
                        // A toolset member call: the `action` is the member tool's name.
                        let raw_input = to_anthropic_tool_input(input);
                        let action = raw_input
                            .get("action")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if action.is_none() {
                            warnings.push(other(format!(
                                "toolset tool call for tool {tool_name} is missing the action"
                            )));
                        }
                        content.push(object([
                            ("type", text("tool_use")),
                            ("id", text(tool_call_id)),
                            (
                                "name",
                                Some(Value::from(action.unwrap_or_else(|| toolset_name.clone()))),
                            ),
                            ("toolset_name", Some(Value::from(toolset_name))),
                            ("input", Some(raw_input)),
                            ("caller", caller),
                            ("cache_control", cache_control),
                        ]));
                        continue;
                    }

                    content.push(object([
                        ("type", text("tool_use")),
                        ("id", text(tool_call_id)),
                        ("name", text(tool_name)),
                        ("input", Some(to_anthropic_tool_input(input))),
                        ("caller", caller),
                        ("cache_control", cache_control),
                    ]));
                }

                LanguageModelV4Part::ToolResult {
                    tool_call_id,
                    tool_name,
                    output,
                    provider_options,
                } => {
                    let caller = get_anthropic_caller(provider_options.as_ref());
                    if let Some(block) = provider_executed_tool_result(
                        tool_call_id,
                        tool_name,
                        output,
                        &caller,
                        cache_control,
                        tool_name_mapping,
                        &mcp_tool_use_ids,
                        warnings,
                    )? {
                        content.push(block);
                    }
                }

                _ => {}
            }
        }
    }
    Ok(content)
}

/// `anthropicFallbackContentSchema`: the two model names.
fn fallback_content(value: &Value) -> Option<(String, String)> {
    if value.get("type")?.as_str()? != "fallback" {
        return None;
    }
    let from = value.get("from")?.get("model")?.as_str()?.to_string();
    let to = value.get("to")?.get("model")?.as_str()?.to_string();
    Some((from, to))
}

/// A tool call the provider ran, as the server tool use the API expects back.
#[allow(clippy::too_many_arguments)]
fn provider_executed_tool_call(
    tool_call_id: &str,
    tool_name: &str,
    input: &Value,
    provider_options: Option<&ProviderOptions>,
    caller: &Option<Value>,
    cache_control: Option<Value>,
    tool_name_mapping: &ToolNameMapping,
    mcp_tool_use_ids: &mut HashSet<String>,
    warnings: &mut Vec<Warning>,
) -> Option<Value> {
    let provider_tool_name = tool_name_mapping.to_provider_tool_name(tool_name);
    let anthropic = provider_options.and_then(|options| options.get("anthropic"));
    if anthropic
        .and_then(|a| a.get("type"))
        .and_then(Value::as_str)
        == Some("mcp-tool-use")
    {
        mcp_tool_use_ids.insert(tool_call_id.to_string());
        let Some(server_name) = anthropic
            .and_then(|a| a.get("serverName"))
            .and_then(Value::as_str)
        else {
            warnings.push(Warning::Other {
                message: "mcp tool use server name is required and must be a string".to_string(),
            });
            return None;
        };
        return Some(object([
            ("type", text("mcp_tool_use")),
            ("id", text(tool_call_id)),
            ("name", text(tool_name)),
            ("input", Some(input.clone())),
            ("server_name", text(server_name)),
            ("cache_control", cache_control),
        ]));
    }

    let input_type = input.get("type").and_then(Value::as_str);
    let without_type = || {
        let mut map = input.as_object().cloned().unwrap_or_default();
        map.shift_remove("type");
        Value::Object(map)
    };
    let server_tool_use = |name: &str, input: Value| {
        with_caller(
            json!({ "type": "server_tool_use", "id": tool_call_id, "name": name, "input": input }),
            caller,
            cache_control.clone(),
        )
    };
    if provider_tool_name == "code_execution"
        && input.is_object()
        && matches!(
            input_type,
            Some("bash_code_execution") | Some("text_editor_code_execution")
        )
    {
        return Some(server_tool_use(
            input_type.unwrap_or_default(),
            without_type(),
        ));
    }
    if provider_tool_name == "code_execution"
        && input.is_object()
        && input_type == Some("programmatic-tool-call")
    {
        return Some(server_tool_use("code_execution", without_type()));
    }
    match provider_tool_name.as_str() {
        "code_execution"
        | "web_fetch"
        | "web_search"
        | "tool_search_tool_regex"
        | "tool_search_tool_bm25" => Some(server_tool_use(&provider_tool_name, input.clone())),
        // The advisor's server_tool_use input is always {}.
        "advisor" => Some(server_tool_use("advisor", json!({}))),
        _ => {
            warnings.push(Warning::Other {
                message: format!(
                    "provider executed tool call for tool {tool_name} is not supported"
                ),
            });
            None
        }
    }
}

fn pick(value: &Value, keys: &[(&str, &str)]) -> Value {
    let mut map = Map::new();
    for (from, to) in keys {
        if let Some(field) = value.get(*from) {
            map.insert(to.to_string(), field.clone());
        }
    }
    Value::Object(map)
}

/// A result of a tool the provider ran, as the result block the API expects back.
#[allow(clippy::too_many_arguments)]
fn provider_executed_tool_result(
    tool_call_id: &str,
    tool_name: &str,
    output: &ToolResultOutput,
    caller: &Option<Value>,
    cache_control: Option<Value>,
    tool_name_mapping: &ToolNameMapping,
    mcp_tool_use_ids: &HashSet<String>,
    warnings: &mut Vec<Warning>,
) -> anyhow::Result<Option<Value>> {
    let provider_tool_name = tool_name_mapping.to_provider_tool_name(tool_name);
    let unsupported_output = |warnings: &mut Vec<Warning>| {
        warnings.push(Warning::Other {
            message: format!(
                "provider executed tool result output type {} for tool {tool_name} is not supported",
                output.type_name()
            ),
        });
    };
    let block = |kind: &str, content: Value, cache_control: Option<Value>| {
        object([
            ("type", text(kind)),
            ("tool_use_id", text(tool_call_id)),
            ("content", Some(content)),
            ("cache_control", cache_control),
        ])
    };

    if mcp_tool_use_ids.contains(tool_call_id) {
        let (value, is_error) = match output {
            ToolResultOutput::Json { value, .. } => (value, false),
            ToolResultOutput::ErrorJson { value, .. } => (value, true),
            _ => {
                unsupported_output(warnings);
                return Ok(None);
            }
        };
        return Ok(Some(object([
            ("type", text("mcp_tool_result")),
            ("tool_use_id", text(tool_call_id)),
            ("is_error", Some(Value::Bool(is_error))),
            ("content", Some(value.clone())),
            ("cache_control", cache_control),
        ])));
    }

    if provider_tool_name == "code_execution" {
        if let ToolResultOutput::ErrorText { value: error, .. } = output {
            return Ok(Some(code_execution_error(
                &Value::from(error.clone()),
                tool_call_id,
                cache_control,
            )));
        }
        if let ToolResultOutput::ErrorJson { value: error, .. } = output {
            return Ok(Some(code_execution_error(
                error,
                tool_call_id,
                cache_control,
            )));
        }
        let ToolResultOutput::Json { value, .. } = output else {
            unsupported_output(warnings);
            return Ok(None);
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            warnings.push(Warning::Other {
                message: format!(
                    "provider executed tool result output value is not a valid code execution result for tool {tool_name}"
                ),
            });
            return Ok(None);
        };
        let content_list = || value.get("content").cloned().unwrap_or_else(|| json!([]));
        let result = match kind {
            "code_execution_result" => block(
                "code_execution_tool_result",
                json!({
                    "type": kind,
                    "stdout": value.get("stdout"),
                    "stderr": value.get("stderr"),
                    "return_code": value.get("return_code"),
                    "content": content_list(),
                }),
                cache_control,
            ),
            "encrypted_code_execution_result" => block(
                "code_execution_tool_result",
                json!({
                    "type": kind,
                    "encrypted_stdout": value.get("encrypted_stdout"),
                    "stderr": value.get("stderr"),
                    "return_code": value.get("return_code"),
                    "content": content_list(),
                }),
                cache_control,
            ),
            "bash_code_execution_result" => object([
                ("type", text("bash_code_execution_tool_result")),
                ("tool_use_id", text(tool_call_id)),
                ("cache_control", cache_control),
                (
                    "content",
                    Some(pick(
                        value,
                        &[
                            ("type", "type"),
                            ("stdout", "stdout"),
                            ("stderr", "stderr"),
                            ("return_code", "return_code"),
                            ("content", "content"),
                        ],
                    )),
                ),
            ]),
            "bash_code_execution_tool_result_error" => object([
                ("type", text("bash_code_execution_tool_result")),
                ("tool_use_id", text(tool_call_id)),
                ("cache_control", cache_control),
                ("content", Some(value.clone())),
            ]),
            _ => object([
                ("type", text("text_editor_code_execution_tool_result")),
                ("tool_use_id", text(tool_call_id)),
                ("cache_control", cache_control),
                ("content", Some(value.clone())),
            ]),
        };
        return Ok(Some(result));
    }

    if provider_tool_name == "web_fetch" || provider_tool_name == "web_search" {
        let result_kind = format!("{provider_tool_name}_tool_result");
        if let ToolResultOutput::ErrorJson { value, .. } = output {
            let error_code = extract_error_code(value).unwrap_or_else(|| "unavailable".to_string());
            return Ok(Some(with_caller(
                json!({
                    "type": result_kind,
                    "tool_use_id": tool_call_id,
                    "content": {
                        "type": format!("{provider_tool_name}_tool_result_error"),
                        "error_code": error_code,
                    },
                }),
                caller,
                cache_control,
            )));
        }
        let ToolResultOutput::Json { value, .. } = output else {
            unsupported_output(warnings);
            return Ok(None);
        };
        let content = if provider_tool_name == "web_fetch" {
            let document = value.get("content").cloned().unwrap_or(Value::Null);
            let source = document.get("source").cloned().unwrap_or(Value::Null);
            json!({
                "type": "web_fetch_result",
                "url": value.get("url"),
                "retrieved_at": value.get("retrievedAt"),
                "content": {
                    "type": "document",
                    "title": document.get("title"),
                    "citations": document.get("citations"),
                    "source": {
                        "type": source.get("type"),
                        "media_type": source.get("mediaType"),
                        "data": source.get("data"),
                    },
                },
            })
        } else {
            Value::Array(
                value
                    .as_array()
                    .map(|results| {
                        results
                            .iter()
                            .map(|result| {
                                pick(
                                    result,
                                    &[
                                        ("url", "url"),
                                        ("title", "title"),
                                        ("pageAge", "page_age"),
                                        ("encryptedContent", "encrypted_content"),
                                        ("type", "type"),
                                    ],
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        };
        return Ok(Some(with_caller(
            json!({ "type": result_kind, "tool_use_id": tool_call_id, "content": content }),
            caller,
            cache_control,
        )));
    }

    if provider_tool_name == "tool_search_tool_regex"
        || provider_tool_name == "tool_search_tool_bm25"
    {
        let ToolResultOutput::Json { value, .. } = output else {
            unsupported_output(warnings);
            return Ok(None);
        };
        let references: Vec<Value> = value
            .as_array()
            .map(|refs| {
                refs.iter()
                    .map(|r| json!({ "type": "tool_reference", "tool_name": r.get("toolName") }))
                    .collect()
            })
            .unwrap_or_default();
        return Ok(Some(block(
            "tool_search_tool_result",
            json!({ "type": "tool_search_tool_search_result", "tool_references": references }),
            cache_control,
        )));
    }

    if provider_tool_name == "advisor" {
        let value = match output {
            ToolResultOutput::Json { value, .. } | ToolResultOutput::ErrorJson { value, .. } => {
                value
            }
            _ => {
                unsupported_output(warnings);
                return Ok(None);
            }
        };
        let stop_reason = value.get("stopReason").filter(|v| !v.is_null()).cloned();
        let content = match value.get("type").and_then(Value::as_str) {
            Some("advisor_result") => object([
                ("type", text("advisor_result")),
                ("text", value.get("text").cloned()),
                ("stop_reason", stop_reason),
            ]),
            Some("advisor_redacted_result") => object([
                ("type", text("advisor_redacted_result")),
                ("encrypted_content", value.get("encryptedContent").cloned()),
                ("stop_reason", stop_reason),
            ]),
            _ => {
                json!({ "type": "advisor_tool_result_error", "error_code": value.get("errorCode") })
            }
        };
        return Ok(Some(block("advisor_tool_result", content, cache_control)));
    }

    warnings.push(Warning::Other {
        message: format!("provider executed tool result for tool {tool_name} is not supported"),
    });
    Ok(None)
}

/// A code execution error result, as the block of the tool version that made it.
fn code_execution_error(error: &Value, tool_call_id: &str, cache_control: Option<Value>) -> Value {
    let info = match error {
        Value::String(text) => secure_json_parse(text).unwrap_or(Value::Null),
        Value::Object(_) => error.clone(),
        _ => Value::Null,
    };
    let error_code = info
        .get("errorCode")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    if info.get("type").and_then(Value::as_str) == Some("code_execution_tool_result_error") {
        return object([
            ("type", text("code_execution_tool_result")),
            ("tool_use_id", text(tool_call_id)),
            (
                "content",
                Some(
                    json!({ "type": "code_execution_tool_result_error", "error_code": error_code }),
                ),
            ),
            ("cache_control", cache_control),
        ]);
    }
    object([
        ("type", text("bash_code_execution_tool_result")),
        ("tool_use_id", text(tool_call_id)),
        ("cache_control", cache_control),
        (
            "content",
            Some(
                json!({ "type": "bash_code_execution_tool_result_error", "error_code": error_code }),
            ),
        ),
    ])
}

/// Within each run of content between thinking blocks, the `tool_use` blocks go
/// after the others.
fn move_tool_use_blocks_to_end(content: Vec<Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    let mut segment: Vec<Value> = Vec::new();
    let is_tool_use = |part: &Value| part.get("type").and_then(Value::as_str) == Some("tool_use");
    let flush = |segment: &mut Vec<Value>, result: &mut Vec<Value>| {
        let (tool_uses, others): (Vec<Value>, Vec<Value>) =
            segment.drain(..).partition(|part| is_tool_use(part));
        result.extend(others);
        result.extend(tool_uses);
    };
    for part in content {
        let kind = part.get("type").and_then(Value::as_str);
        if matches!(
            kind,
            Some("thinking") | Some("redacted_thinking") | Some("fallback")
        ) {
            flush(&mut segment, &mut result);
            result.push(part);
        } else {
            segment.push(part);
        }
    }
    flush(&mut segment, &mut result);
    result
}

/// History before the last user message keeps a tool call's `caller` only when the
/// code execution call it names is still in the conversation.
fn omit_orphan_callers(
    messages: &mut [Value],
    last_user_message_index: Option<usize>,
    warnings: &mut Vec<Warning>,
) {
    let mut code_execution_tool_call_ids: HashSet<String> = HashSet::new();
    for message in messages.iter() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        for part in message["content"].as_array().into_iter().flatten() {
            if part.get("type").and_then(Value::as_str) == Some("server_tool_use")
                && part.get("name").and_then(Value::as_str) == Some("code_execution")
                && let Some(id) = part.get("id").and_then(Value::as_str)
            {
                code_execution_tool_call_ids.insert(id.to_string());
            }
        }
    }

    let Some(last_user_message_index) = last_user_message_index else {
        return;
    };
    let mut warned: HashSet<String> = HashSet::new();
    for message in messages.iter_mut().take(last_user_message_index) {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts.iter_mut() {
            let Some(map) = part.as_object_mut() else {
                continue;
            };
            let Some(caller) = map.get("caller") else {
                continue;
            };
            if caller.is_null() || caller.get("type").and_then(Value::as_str) == Some("direct") {
                continue;
            }
            let source_id = caller
                .get("tool_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if code_execution_tool_call_ids.contains(&source_id) {
                continue;
            }
            let tool_call_id = map
                .get("id")
                .or_else(|| map.get("tool_use_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            map.shift_remove("caller");
            if warned.insert(tool_call_id.clone()) {
                warnings.push(Warning::Other {
                    message: format!(
                        "Omitted caller metadata for tool {tool_call_id} because source code execution tool {source_id} is missing from the conversation history."
                    ),
                });
            }
        }
    }
}
