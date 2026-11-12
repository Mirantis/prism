//! The prompt as Converse messages (`convertToAmazonBedrockChatMessages`): system
//! blocks, user turns that join every user and tool message between two assistant
//! turns, assistant turns, cache points and documents.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::ai::errors::UnsupportedFunctionalityError;
use crate::ai::json::js_stringify;
use crate::ai::prompt::{detect_image_media_type, is_full_media_type};
use crate::ai::provider::{
    DataContent, FileData, LanguageModelV4Message, LanguageModelV4Part, ProviderOptions,
    ToolResultContentPart, ToolResultOutput,
};
use crate::support::js;

/// The Converse request's `system` and `messages`.
pub struct ConverseMessages {
    pub system: Vec<Value>,
    pub messages: Vec<Value>,
}

/// `BEDROCK_IMAGE_MIME_TYPES`.
const IMAGE_FORMATS: &[(&str, &str)] = &[
    ("image/jpeg", "jpeg"),
    ("image/png", "png"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

/// `BEDROCK_DOCUMENT_MIME_TYPES`.
const DOCUMENT_FORMATS: &[(&str, &str)] = &[
    ("application/pdf", "pdf"),
    ("text/csv", "csv"),
    ("application/msword", "doc"),
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
    ("application/vnd.ms-excel", "xls"),
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    ("text/html", "html"),
    ("text/plain", "txt"),
    ("text/markdown", "md"),
];

/// `BEDROCK_VIDEO_MIME_TYPES`.
const VIDEO_FORMATS: &[(&str, &str)] = &[
    ("video/x-matroska", "mkv"),
    ("video/quicktime", "mov"),
    ("video/mp4", "mp4"),
    ("video/webm", "webm"),
    ("video/x-flv", "flv"),
    ("video/mpeg", "mpeg"),
    ("video/mpg", "mpg"),
    ("video/wmv", "wmv"),
    ("video/x-ms-wmv", "wmv"),
    ("video/3gpp", "three_gp"),
];

fn unsupported(functionality: &str) -> anyhow::Error {
    UnsupportedFunctionalityError::new(functionality).into()
}

fn format_for(
    table: &[(&str, &'static str)],
    kind: &str,
    label: &str,
    media_type: &str,
) -> anyhow::Result<&'static str> {
    if let Some((_, format)) = table.iter().find(|(m, _)| *m == media_type) {
        return Ok(format);
    }
    let expected = table.iter().map(|(m, _)| *m).collect::<Vec<_>>().join(", ");
    Err(UnsupportedFunctionalityError {
        message: format!(
            "Unsupported {label} mime type: {media_type}, expected one of: {expected}"
        ),
        functionality: format!("{kind} mime type: {media_type}"),
    }
    .into())
}

fn image_format(media_type: &str) -> anyhow::Result<&'static str> {
    format_for(IMAGE_FORMATS, "image", "image", media_type)
}

fn document_format(media_type: &str) -> anyhow::Result<&'static str> {
    format_for(DOCUMENT_FORMATS, "file", "file", media_type)
}

fn video_format(media_type: &str) -> anyhow::Result<&'static str> {
    format_for(VIDEO_FORMATS, "video", "video", media_type)
}

/// `getTopLevelMediaType`.
fn top_level_media_type(media_type: &str) -> &str {
    media_type.split('/').next().unwrap_or("")
}

/// `resolveFullMediaType`: the media type when it names a subtype, else the type
/// sniffed from inline bytes.
fn resolve_full_media_type(media_type: &str, data: &FileData) -> anyhow::Result<String> {
    if is_full_media_type(media_type) {
        return Ok(media_type.to_string());
    }
    if let FileData::Data { data } = data {
        let detected = match top_level_media_type(media_type) {
            "image" => detect_image_media_type(data)?,
            _ => None,
        };
        return match detected {
            Some(detected) => Ok(detected.to_string()),
            None => Err(unsupported(&format!(
                "file of media type \"{media_type}\" must specify subtype since it could not be auto-detected"
            ))),
        };
    }
    Err(unsupported(&format!(
        "file of media type \"{media_type}\" must specify subtype since it is not passed as inline bytes"
    )))
}

/// `getCachePoint`: `{ cachePoint }` from the `amazonBedrock` or `bedrock` options.
fn cache_point(provider_options: Option<&ProviderOptions>) -> Option<Value> {
    let options = provider_options?;
    let config = options
        .get("amazonBedrock")
        .and_then(|o| o.get("cachePoint"))
        .filter(|v| !v.is_null())
        .or_else(|| {
            options
                .get("bedrock")
                .and_then(|o| o.get("cachePoint"))
                .filter(|v| !v.is_null())
        })?;
    if !js::truthy(config) {
        return None;
    }
    Some(json!({ "cachePoint": config }))
}

fn push_cache_point(content: &mut Vec<Value>, provider_options: Option<&ProviderOptions>) {
    if let Some(point) = cache_point(provider_options) {
        content.push(point);
    }
}

/// The `amazonBedrock` options of a part, else its `bedrock` options.
fn part_options(provider_options: Option<&ProviderOptions>) -> Option<&Value> {
    let options = provider_options?;
    options
        .get("amazonBedrock")
        .filter(|v| !v.is_null())
        .or_else(|| options.get("bedrock").filter(|v| !v.is_null()))
}

/// The provider whose options a part reads, for the error text.
fn part_options_key(provider_options: Option<&ProviderOptions>) -> &'static str {
    match provider_options.and_then(|o| o.get("amazonBedrock")) {
        Some(v) if !v.is_null() => "amazonBedrock",
        _ => "bedrock",
    }
}

fn invalid_options(key: &str) -> anyhow::Error {
    crate::ai::errors::InvalidArgumentError {
        message: format!("invalid {key} provider options"),
        parameter: "providerOptions".to_string(),
        value: Value::Null,
    }
    .into()
}

/// `shouldEnableCitations`.
fn should_enable_citations(provider_options: Option<&ProviderOptions>) -> anyhow::Result<bool> {
    let Some(options) = part_options(provider_options) else {
        return Ok(false);
    };
    let key = part_options_key(provider_options);
    let Some(object) = options.as_object() else {
        return Err(invalid_options(key));
    };
    match object.get("citations") {
        None => Ok(false),
        Some(citations) => match citations.get("enabled").and_then(Value::as_bool) {
            Some(enabled) if citations.is_object() => Ok(enabled),
            _ => Err(invalid_options(key)),
        },
    }
}

/// The guard-content options of a text part: `guardContent` and its qualifiers.
fn text_guard_content(
    provider_options: Option<&ProviderOptions>,
) -> anyhow::Result<Option<(bool, Option<Value>)>> {
    let Some(options) = part_options(provider_options) else {
        return Ok(None);
    };
    let key = part_options_key(provider_options);
    let object = options.as_object().ok_or_else(|| invalid_options(key))?;
    let guard = match object.get("guardContent") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid_options(key)),
    };
    let qualifiers = match object.get("guardContentQualifiers") {
        None => None,
        Some(Value::Array(items))
            if items.iter().all(|q| {
                matches!(
                    q.as_str(),
                    Some("grounding_source") | Some("query") | Some("guard_content")
                )
            }) =>
        {
            Some(Value::Array(items.clone()))
        }
        Some(_) => return Err(invalid_options(key)),
    };
    Ok(Some((guard, qualifiers)))
}

/// Whether an image part is guard content.
fn image_guard_content(provider_options: Option<&ProviderOptions>) -> anyhow::Result<bool> {
    let Some(options) = part_options(provider_options) else {
        return Ok(false);
    };
    let key = part_options_key(provider_options);
    let object = options.as_object().ok_or_else(|| invalid_options(key))?;
    match object.get("guardContent") {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(invalid_options(key)),
    }
}

/// `sanitizeToolName`: only letters, digits, `_` and `-`; `_` when nothing is left.
fn sanitize_tool_name(tool_name: &str) -> String {
    let cleaned: String = tool_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "_".to_string()
    } else {
        cleaned
    }
}

/// `sanitizeDocumentName`.
fn sanitize_document_name(filename: &str) -> String {
    static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("valid regex"));
    let stem = match filename.find('.') {
        Some(index) => &filename[..index],
        None => filename,
    };
    let collapsed = WHITESPACE.replace_all(stem, " ");
    let kept: String = collapsed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '(' | ')' | '[' | ']' | '-'))
        .collect();
    let trimmed = js::trim(&kept);
    let cut = js::slice16(trimmed, 0, 200.min(js::len16(trimmed)));
    js::trim(&cut).to_string()
}

/// `getAmazonBedrockMediaSource`: inline bytes as base64, or an `s3://` location.
fn media_source(data: &FileData, functionality: &str) -> anyhow::Result<Value> {
    match data {
        FileData::Data { data } => Ok(json!({ "bytes": data.to_base64() })),
        FileData::Url { url, .. } => {
            if !url.starts_with("s3:") {
                return Err(unsupported(functionality));
            }
            Ok(json!({ "s3Location": { "uri": url } }))
        }
        _ => Err(unsupported(functionality)),
    }
}

fn base64_of(data: &DataContent) -> String {
    data.to_base64()
}

/// Names documents the way the SDK does: the sanitized filename, else
/// `document-<n>` from a counter shared by the whole prompt.
struct DocumentNames {
    counter: usize,
}

impl DocumentNames {
    fn name(&mut self, filename: Option<&str>) -> String {
        if let Some(name) = filename
            .map(sanitize_document_name)
            .filter(|n| !n.is_empty())
        {
            return name;
        }
        self.counter += 1;
        format!("document-{}", self.counter)
    }
}

/// `normalizeToolCallId`: Mistral takes only 9 alphanumeric characters, so any
/// other id becomes a 9-character base-62 FNV-1a hash of its UTF-16 code units.
pub fn normalize_tool_call_id(tool_call_id: &str, is_mistral: bool) -> String {
    if !is_mistral {
        return tool_call_id.to_string();
    }
    if tool_call_id.len() == 9 && tool_call_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return tool_call_id.to_string();
    }
    const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut hash: u64 = 14695981039346656037;
    for unit in tool_call_id.encode_utf16() {
        hash ^= u64::from(unit);
        hash = hash.wrapping_mul(1099511628211);
    }
    let space = 62u64.pow(9);
    let mut value = hash % space;
    let mut result = Vec::with_capacity(9);
    for _ in 0..9 {
        result.push(BASE62[(value % 62) as usize]);
        value /= 62;
    }
    result.reverse();
    String::from_utf8(result).expect("ASCII")
}

/// `isMistralModel`.
pub fn is_mistral_model(model_id: &str) -> bool {
    model_id.contains("mistral.")
}

/// `toBedrockToolInput`: Bedrock takes an object, so anything else is wrapped.
fn to_bedrock_tool_input(input: &Value) -> Value {
    if input.is_object() {
        input.clone()
    } else {
        json!({ "rawInvalidInput": input })
    }
}

/// `convertToolResultOutput`.
fn convert_tool_result_output(
    output: &ToolResultOutput,
    names: &mut DocumentNames,
) -> anyhow::Result<Vec<Value>> {
    match output {
        ToolResultOutput::Content { value } => {
            let mut out = Vec::with_capacity(value.len());
            for part in value {
                out.push(match part {
                    ToolResultContentPart::Text { text, .. } => json!({ "text": text }),
                    ToolResultContentPart::File {
                        filename,
                        data,
                        media_type,
                        provider_options,
                    } => {
                        let data_type = match data {
                            FileData::Data { .. } => "data",
                            FileData::Url { .. } => "url",
                            FileData::Reference { .. } => "reference",
                            FileData::Text { .. } => "text",
                        };
                        let functionality =
                            format!("tool result file data of type \"{data_type}\"");
                        let s3 =
                            matches!(data, FileData::Url { url, .. } if url.starts_with("s3:"));
                        if data_type != "data" && !s3 {
                            return Err(unsupported(&functionality));
                        }
                        let full = resolve_full_media_type(media_type, data)?;
                        match top_level_media_type(&full) {
                            "image" => json!({ "image": {
                                "format": image_format(&full)?,
                                "source": media_source(data, &functionality)?,
                            } }),
                            "video" => json!({ "video": {
                                "format": video_format(&full)?,
                                "source": media_source(data, &functionality)?,
                            } }),
                            _ => {
                                let FileData::Data { data } = data else {
                                    return Err(unsupported(&functionality));
                                };
                                let citations = should_enable_citations(provider_options.as_ref())?;
                                let mut document = Map::new();
                                document.insert("format".into(), json!(document_format(&full)?));
                                document
                                    .insert("name".into(), json!(names.name(filename.as_deref())));
                                document
                                    .insert("source".into(), json!({ "bytes": base64_of(data) }));
                                if citations {
                                    document.insert("citations".into(), json!({ "enabled": true }));
                                }
                                json!({ "document": document })
                            }
                        }
                    }
                    other => {
                        let kind = serde_json::to_value(other)
                            .ok()
                            .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_string))
                            .unwrap_or_default();
                        return Err(unsupported(&format!(
                            "unsupported tool content part type: {kind}"
                        )));
                    }
                });
            }
            Ok(out)
        }
        ToolResultOutput::Text { value, .. } | ToolResultOutput::ErrorText { value, .. } => {
            Ok(vec![json!({ "text": value })])
        }
        ToolResultOutput::ExecutionDenied { reason, .. } => Ok(vec![json!({
            "text": reason.clone().unwrap_or_else(|| "Tool call execution denied.".to_string())
        })]),
        ToolResultOutput::Json { value, .. } | ToolResultOutput::ErrorJson { value, .. } => {
            Ok(vec![json!({ "text": js_stringify(value) })])
        }
    }
}

/// A trailing tool result and the user content after it share one user message,
/// so the roles keep alternating.
fn append_to_user_message(messages: &mut Vec<Value>, content: Vec<Value>) {
    if let Some(last) = messages.last_mut()
        && last["role"] == "user"
        && last["content"]
            .as_array()
            .is_some_and(|c| c.iter().any(|b| b.get("toolResult").is_some()))
        && let Some(existing) = last["content"].as_array_mut()
    {
        existing.extend(content);
        return;
    }
    messages.push(json!({ "role": "user", "content": content }));
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockType {
    System,
    Assistant,
    User,
}

/// `groupIntoBlocks`: runs of system, assistant, or user-and-tool messages.
fn group_into_blocks(
    prompt: &[LanguageModelV4Message],
) -> Vec<(BlockType, Vec<&LanguageModelV4Message>)> {
    let mut blocks: Vec<(BlockType, Vec<&LanguageModelV4Message>)> = Vec::new();
    for message in prompt {
        let block_type = match message {
            LanguageModelV4Message::System { .. } => BlockType::System,
            LanguageModelV4Message::Assistant { .. } => BlockType::Assistant,
            LanguageModelV4Message::User { .. } | LanguageModelV4Message::Tool { .. } => {
                BlockType::User
            }
        };
        match blocks.last_mut() {
            Some((current, messages)) if *current == block_type => messages.push(message),
            _ => blocks.push((block_type, vec![message])),
        }
    }
    blocks
}

/// `convertToAmazonBedrockChatMessages`.
pub fn convert_to_amazon_bedrock_chat_messages(
    prompt: &[LanguageModelV4Message],
    is_mistral: bool,
) -> anyhow::Result<ConverseMessages> {
    let blocks = group_into_blocks(prompt);
    let mut system: Vec<Value> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    let mut names = DocumentNames { counter: 0 };

    for (index, (block_type, block)) in blocks.iter().enumerate() {
        let is_last_block = index == blocks.len() - 1;
        match block_type {
            BlockType::System => {
                if !messages.is_empty() {
                    return Err(unsupported(
                        "Multiple system messages that are separated by user/assistant messages",
                    ));
                }
                for message in block {
                    if let LanguageModelV4Message::System {
                        content,
                        provider_options,
                    } = message
                    {
                        system.push(json!({ "text": content }));
                        if let Some(point) = cache_point(provider_options.as_ref()) {
                            system.push(point);
                        }
                    }
                }
            }
            BlockType::User => {
                let mut content: Vec<Value> = Vec::new();
                for message in block {
                    match message {
                        LanguageModelV4Message::User {
                            content: parts,
                            provider_options,
                        } => {
                            for part in parts {
                                convert_user_part(part, &mut content, &mut names)?;
                                push_cache_point(&mut content, part.provider_options());
                            }
                            push_cache_point(&mut content, provider_options.as_ref());
                        }
                        LanguageModelV4Message::Tool {
                            content: parts,
                            provider_options,
                        } => {
                            for part in parts {
                                let LanguageModelV4Part::ToolResult {
                                    tool_call_id,
                                    output,
                                    provider_options: part_options,
                                    ..
                                } = part
                                else {
                                    continue;
                                };
                                content.push(json!({ "toolResult": {
                                    "toolUseId": normalize_tool_call_id(tool_call_id, is_mistral),
                                    "content": convert_tool_result_output(output, &mut names)?,
                                } }));
                                push_cache_point(&mut content, part_options.as_ref());
                            }
                            push_cache_point(&mut content, provider_options.as_ref());
                        }
                        _ => {}
                    }
                }
                append_to_user_message(&mut messages, content);
            }
            BlockType::Assistant => {
                convert_assistant_block(
                    block,
                    is_last_block,
                    is_mistral,
                    &mut messages,
                    &mut names,
                )?;
            }
        }
    }

    Ok(ConverseMessages { system, messages })
}

fn convert_user_part(
    part: &LanguageModelV4Part,
    content: &mut Vec<Value>,
    names: &mut DocumentNames,
) -> anyhow::Result<()> {
    match part {
        LanguageModelV4Part::Text {
            text,
            provider_options,
        } => match text_guard_content(provider_options.as_ref())? {
            Some((true, qualifiers)) => {
                let mut guarded = Map::new();
                guarded.insert("text".into(), json!(text));
                if let Some(qualifiers) = qualifiers {
                    guarded.insert("qualifiers".into(), qualifiers);
                }
                content.push(json!({ "guardContent": { "text": guarded } }));
            }
            _ => content.push(json!({ "text": text })),
        },
        LanguageModelV4Part::File {
            filename,
            data,
            media_type,
            provider_options,
        } => match data {
            FileData::Reference { .. } => {
                return Err(unsupported("file parts with provider references"));
            }
            FileData::Url { url, .. } => {
                if !url.starts_with("s3:") {
                    return Err(unsupported("File URL data"));
                }
                let full = resolve_full_media_type(media_type, data)?;
                match top_level_media_type(&full) {
                    "image" => content.push(json!({ "image": {
                        "format": image_format(&full)?,
                        "source": media_source(data, "File URL data")?,
                    } })),
                    "video" => content.push(json!({ "video": {
                        "format": video_format(&full)?,
                        "source": media_source(data, "File URL data")?,
                    } })),
                    _ => return Err(unsupported("File URL data")),
                }
            }
            FileData::Text { text } => {
                let media_type = if is_full_media_type(media_type) {
                    media_type.as_str()
                } else {
                    "text/plain"
                };
                let citations = should_enable_citations(provider_options.as_ref())?;
                let mut document = Map::new();
                document.insert("format".into(), json!(document_format(media_type)?));
                document.insert("name".into(), json!(names.name(filename.as_deref())));
                document.insert(
                    "source".into(),
                    json!({ "bytes": crate::ai::json::bytes_to_base64(text.as_bytes()) }),
                );
                if citations {
                    document.insert("citations".into(), json!({ "enabled": true }));
                }
                content.push(json!({ "document": document }));
            }
            FileData::Data { data: bytes } => {
                let full = resolve_full_media_type(media_type, data)?;
                match top_level_media_type(&full) {
                    "image" => {
                        let guard = image_guard_content(provider_options.as_ref())?;
                        let block = json!({ "image": {
                            "format": image_format(&full)?,
                            "source": media_source(data, "File URL data")?,
                        } });
                        if guard {
                            content.push(json!({ "guardContent": block }));
                        } else {
                            content.push(block);
                        }
                    }
                    "video" => content.push(json!({ "video": {
                        "format": video_format(&full)?,
                        "source": media_source(data, "File URL data")?,
                    } })),
                    _ => {
                        let citations = should_enable_citations(provider_options.as_ref())?;
                        let mut document = Map::new();
                        document.insert("format".into(), json!(document_format(&full)?));
                        document.insert("name".into(), json!(names.name(filename.as_deref())));
                        document.insert("source".into(), json!({ "bytes": base64_of(bytes) }));
                        if citations {
                            document.insert("citations".into(), json!({ "enabled": true }));
                        }
                        content.push(json!({ "document": document }));
                    }
                }
            }
        },
        _ => {}
    }
    Ok(())
}

/// The `amazonBedrock` (else `bedrock`) reasoning metadata of a reasoning part.
fn reasoning_metadata(
    provider_options: Option<&ProviderOptions>,
) -> anyhow::Result<Option<Map<String, Value>>> {
    let Some(options) = part_options(provider_options) else {
        return Ok(None);
    };
    let key = part_options_key(provider_options);
    let object = options.as_object().ok_or_else(|| invalid_options(key))?;
    for field in ["signature", "redactedData", "redactedContent"] {
        if let Some(value) = object.get(field)
            && !value.is_string()
        {
            return Err(invalid_options(key));
        }
    }
    Ok(Some(object.clone()))
}

fn convert_assistant_block(
    block: &[&LanguageModelV4Message],
    is_last_block: bool,
    is_mistral: bool,
    messages: &mut Vec<Value>,
    names: &mut DocumentNames,
) -> anyhow::Result<()> {
    let mut assistant_content: Vec<Value> = Vec::new();
    let mut tool_result_content: Vec<Value> = Vec::new();

    fn flush_assistant(messages: &mut Vec<Value>, assistant_content: &mut Vec<Value>) {
        if assistant_content
            .iter()
            .any(|b| b.get("cachePoint").is_none())
        {
            messages.push(json!({
                "role": "assistant",
                "content": std::mem::take(assistant_content),
            }));
        }
        assistant_content.clear();
    }

    fn flush_tool_results(messages: &mut Vec<Value>, tool_result_content: &mut Vec<Value>) {
        if !tool_result_content.is_empty() {
            append_to_user_message(messages, std::mem::take(tool_result_content));
        }
    }

    for (j, message) in block.iter().enumerate() {
        let is_last_message = j == block.len() - 1;
        let LanguageModelV4Message::Assistant {
            content,
            provider_options: message_options,
        } = message
        else {
            continue;
        };
        let has_reasoning = content
            .iter()
            .any(|p| matches!(p, LanguageModelV4Part::Reasoning { .. }));

        for (k, part) in content.iter().enumerate() {
            let is_last_part = k == content.len() - 1;
            let is_tool_result = matches!(part, LanguageModelV4Part::ToolResult { .. });
            if !is_tool_result {
                flush_tool_results(messages, &mut tool_result_content);
            }

            match part {
                LanguageModelV4Part::Text { text, .. } => {
                    if js::trim(text).is_empty() && !has_reasoning {
                        // Bedrock refuses an empty text block.
                    } else {
                        let text = if is_last_block && is_last_message && is_last_part {
                            js::trim(text).to_string()
                        } else {
                            text.clone()
                        };
                        assistant_content.push(json!({ "text": text }));
                    }
                }
                LanguageModelV4Part::Reasoning {
                    text,
                    provider_options,
                } => {
                    let metadata = reasoning_metadata(provider_options.as_ref())?;
                    let field = |name: &str| {
                        metadata
                            .as_ref()
                            .and_then(|m| m.get(name))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    };
                    if let Some(signature) = field("signature") {
                        // The signature covers the exact original text, so it is not trimmed.
                        assistant_content.push(json!({ "reasoningContent": {
                            "reasoningText": { "text": text, "signature": signature }
                        } }));
                    } else if let Some(redacted) = field("redactedContent") {
                        assistant_content.push(json!({ "reasoningContent": {
                            "redactedContent": redacted
                        } }));
                    } else if let Some(data) = field("redactedData") {
                        assistant_content.push(json!({ "reasoningContent": {
                            "redactedReasoning": { "data": data }
                        } }));
                    }
                    // Unsigned reasoning is not replayed: some models return it without
                    // a signature, and sending it back can leak it into the reply.
                }
                LanguageModelV4Part::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                    ..
                } => {
                    assistant_content.push(json!({ "toolUse": {
                        "toolUseId": normalize_tool_call_id(tool_call_id, is_mistral),
                        "name": sanitize_tool_name(tool_name),
                        "input": to_bedrock_tool_input(input),
                    } }));
                }
                LanguageModelV4Part::ToolResult {
                    tool_call_id,
                    output,
                    ..
                } => {
                    flush_assistant(messages, &mut assistant_content);
                    tool_result_content.push(json!({ "toolResult": {
                        "toolUseId": normalize_tool_call_id(tool_call_id, is_mistral),
                        "content": convert_tool_result_output(output, names)?,
                    } }));
                }
                _ => {}
            }

            if is_tool_result {
                push_cache_point(&mut tool_result_content, part.provider_options());
            } else {
                push_cache_point(&mut assistant_content, part.provider_options());
            }
        }

        let ends_on_tool_result =
            matches!(content.last(), Some(LanguageModelV4Part::ToolResult { .. }));
        if ends_on_tool_result {
            push_cache_point(&mut tool_result_content, message_options.as_ref());
        } else {
            push_cache_point(&mut assistant_content, message_options.as_ref());
        }
    }

    flush_tool_results(messages, &mut tool_result_content);
    flush_assistant(messages, &mut assistant_content);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mistral_tool_call_ids_as_the_sdk_does() {
        assert_eq!(
            normalize_tool_call_id("tooluse_bpe71yCfRu2b5i-nKGDr5g", true),
            "8eHypBDcw"
        );
        assert_eq!(
            normalize_tool_call_id("tooluse_abc-def_ghi", true),
            "UIYxxmnTu"
        );
        assert_eq!(normalize_tool_call_id("abcDEF123", true), "abcDEF123");
        assert_eq!(normalize_tool_call_id("tooluse_x", false), "tooluse_x");
    }

    #[test]
    fn sanitizes_document_names() {
        assert_eq!(
            sanitize_document_name("Quarterly Report (Q3) — final!.pdf"),
            "Quarterly Report (Q3)  final"
        );
        assert_eq!(sanitize_document_name("archive.tar.gz"), "archive");
        assert_eq!(sanitize_document_name("!!!"), "");
    }

    #[test]
    fn sanitizes_tool_names() {
        assert_eq!(sanitize_tool_name("my.tool name"), "mytoolname");
        assert_eq!(sanitize_tool_name("..."), "_");
    }

    #[test]
    fn refuses_system_messages_after_the_conversation_starts() {
        let prompt: Vec<LanguageModelV4Message> = serde_json::from_value(json!([
            { "role": "system", "content": "a" },
            { "role": "user", "content": [{ "type": "text", "text": "b" }] },
            { "role": "system", "content": "c" }
        ]))
        .unwrap();
        let err = convert_to_amazon_bedrock_chat_messages(&prompt, false)
            .err()
            .unwrap();
        assert_eq!(
            err.to_string(),
            "'Multiple system messages that are separated by user/assistant messages' functionality not supported."
        );
    }

    #[test]
    fn names_an_unsupported_image_type() {
        let prompt: Vec<LanguageModelV4Message> = serde_json::from_value(json!([
            { "role": "user", "content": [
                { "type": "file", "mediaType": "image/bmp", "data": { "type": "data", "data": "AAAA" } }
            ] }
        ]))
        .unwrap();
        let err = convert_to_amazon_bedrock_chat_messages(&prompt, false)
            .err()
            .unwrap();
        assert_eq!(
            err.to_string(),
            "Unsupported image mime type: image/bmp, expected one of: image/jpeg, image/png, image/gif, image/webp"
        );
    }
}
