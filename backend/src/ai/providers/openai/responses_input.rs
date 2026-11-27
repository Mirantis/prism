//! A prompt as the Responses API `input` (`convertToOpenAIResponsesInput`).
//!
//! The port covers the items the runtime's prompts produce. Calls and results of
//! hosted tools that need their provider tool declared (local shell, shell, apply
//! patch, computer, custom tools, programmatic tool calling) are not built, since
//! the request refuses those tools.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde_json::{Map, Value};

use super::capabilities::SystemMessageMode;
use super::responses_options::{
    ReasoningEffortUpdate, ReasoningPartOptions, SystemMessageOptions, ToolResultOptions,
    parse_provider_options,
};
use super::tools::tool_search_input_schema;
use crate::ai::errors::{TypeValidationError, UnsupportedFunctionalityError};
use crate::ai::json::{bytes_to_base64, js_stringify, parse_json};
use crate::ai::prompt::{detect_image_media_type, is_full_media_type};
use crate::ai::provider::{
    DataContent, FileData, LanguageModelV4Message, LanguageModelV4Part, ProviderOptions,
    ProviderReference, ToolResultContentPart, ToolResultOutput, Warning,
};
use crate::ai::providers::provider_utils::ToolNameMapping;
use crate::ai::tool::{safe_validate_types, zod_schema};

/// The settings of one conversion.
pub struct ConvertInputOptions<'a> {
    pub tool_name_mapping: &'a ToolNameMapping,
    pub system_message_mode: SystemMessageMode,
    pub provider_options_name: &'a str,
    pub explicit_message_item_type: bool,
    /// Soft-deprecated: string file data starting with one of these is a file id.
    pub file_id_prefixes: Option<&'a [String]>,
    pub pass_through_unsupported_files: bool,
    pub store: bool,
    /// Stored assistant messages are only referenced together with their reasoning.
    pub is_reasoning_model: bool,
    /// Skip assistant items that already have item ids.
    pub has_conversation: bool,
    /// Skip reasoning and function-call items already in the previous response chain.
    pub has_previous_response_id: bool,
    pub tool_search_tool_name: Option<&'a str>,
    pub output_schema_tool_names: &'a HashSet<String>,
    pub configuration_update_unsupported_reason: Option<&'a str>,
}

/// A provider reference without an id for this provider.
#[derive(Debug, Clone)]
pub struct NoSuchProviderReferenceError {
    pub message: String,
}

impl NoSuchProviderReferenceError {
    pub const NAME: &'static str = "AI_NoSuchProviderReferenceError";
}

impl fmt::Display for NoSuchProviderReferenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NoSuchProviderReferenceError {}

/// `resolveProviderReference`.
fn resolve_provider_reference(
    reference: &ProviderReference,
    provider: &str,
) -> Result<String, NoSuchProviderReferenceError> {
    reference
        .get(provider)
        .cloned()
        .ok_or_else(|| NoSuchProviderReferenceError {
            message: format!(
                "No provider reference found for provider '{provider}'. Available providers: {}",
                reference.keys().cloned().collect::<Vec<_>>().join(", ")
            ),
        })
}

fn unsupported(functionality: &str) -> anyhow::Error {
    UnsupportedFunctionalityError::new(functionality).into()
}

/// The options under the provider's name.
fn named<'a>(options: Option<&'a ProviderOptions>, name: &str) -> Option<&'a Map<String, Value>> {
    options.and_then(|o| o.get(name)).and_then(Value::as_object)
}

/// `options?.[name]?.[key]` when it is not null.
fn named_value<'a>(
    options: Option<&'a ProviderOptions>,
    name: &str,
    key: &str,
) -> Option<&'a Value> {
    named(options, name)
        .and_then(|o| o.get(key))
        .filter(|v| !v.is_null())
}

/// `options?.[name]?.[key]` as a string.
fn named_str<'a>(options: Option<&'a ProviderOptions>, name: &str, key: &str) -> Option<&'a str> {
    named_value(options, name, key).and_then(Value::as_str)
}

/// `getPromptCacheBreakpoint`.
fn prompt_cache_breakpoint(options: Option<&ProviderOptions>, name: &str) -> Option<Value> {
    named_value(options, name, "promptCacheBreakpoint").cloned()
}

/// An object from its entries, leaving out the absent ones as `JSON.stringify`
/// leaves out `undefined`.
fn object(entries: Vec<(&str, Option<Value>)>) -> Value {
    let mut out = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            out.insert(key.to_string(), value);
        }
    }
    Value::Object(out)
}

fn text(value: impl Into<String>) -> Option<Value> {
    Some(Value::String(value.into()))
}

fn item_reference(id: &str) -> Value {
    object(vec![("type", text("item_reference")), ("id", text(id))])
}

/// `{ type: 'message' }` when the provider needs it on message items.
fn message_type(explicit: bool) -> Option<Value> {
    explicit.then(|| Value::String("message".to_string()))
}

/// `getTopLevelMediaType`.
fn top_level_media_type(media_type: &str) -> &str {
    media_type
        .split_once('/')
        .map_or(media_type, |(top, _)| top)
}

/// `detectMediaType({ data, topLevelType })` for the image and document signature
/// tables.
fn detect_media_type(data: &DataContent, top_level_type: &str) -> anyhow::Result<Option<String>> {
    match top_level_type {
        "image" => Ok(detect_image_media_type(data)?.map(str::to_string)),
        "application" => {
            let bytes = match data {
                DataContent::Bytes(bytes) => bytes.slice(..bytes.len().min(4)).to_vec(),
                DataContent::Base64(text) => {
                    let cut: String = text.chars().take(8).collect();
                    crate::ai::json::base64_to_bytes(&cut).map_err(anyhow::Error::msg)?
                }
            };
            Ok(bytes
                .starts_with(&[0x25, 0x50, 0x44, 0x46])
                .then(|| "application/pdf".to_string()))
        }
        _ => Ok(None),
    }
}

/// `resolveFullMediaType`: the media type with its subtype, sniffed from inline
/// bytes when the part names only the top level.
fn resolve_full_media_type(media_type: &str, data: &FileData) -> anyhow::Result<String> {
    if is_full_media_type(media_type) {
        return Ok(media_type.to_string());
    }
    if let FileData::Data { data } = data {
        if let Some(detected) = detect_media_type(data, top_level_media_type(media_type))? {
            return Ok(detected);
        }
        return Err(unsupported(&format!(
            "file of media type \"{media_type}\" must specify subtype since it could not be auto-detected"
        )));
    }
    Err(unsupported(&format!(
        "file of media type \"{media_type}\" must specify subtype since it is not passed as inline bytes"
    )))
}

fn data_uri(media_type: &str, data: &DataContent) -> String {
    let base64 = match data {
        DataContent::Base64(text) => text.clone(),
        DataContent::Bytes(bytes) => bytes_to_base64(bytes),
    };
    format!("data:{media_type};base64,{base64}")
}

/// Soft-deprecated: whether string file data is an uploaded file's id.
fn is_file_id(data: &DataContent, prefixes: Option<&[String]>) -> Option<String> {
    let (DataContent::Base64(text), Some(prefixes)) = (data, prefixes) else {
        return None;
    };
    prefixes
        .iter()
        .any(|prefix| text.starts_with(prefix.as_str()))
        .then(|| text.clone())
}

/// `{ arguments?, call_id? }` of a tool search call.
fn parse_tool_search_input(input: &Value) -> anyhow::Result<Value> {
    let schema = zod_schema(tool_search_input_schema());
    let value = match input {
        Value::String(text) => parse_json(text)?,
        other => other.clone(),
    };
    Ok(safe_validate_types(&value, &schema)?)
}

/// The `tools` of a tool search output (`toolSearchOutputSchema`).
fn tool_search_output_tools(value: &Value) -> anyhow::Result<Value> {
    match value.get("tools") {
        Some(Value::Array(tools)) if tools.iter().all(Value::is_object) => {
            Ok(Value::Array(tools.clone()))
        }
        _ => Err(TypeValidationError::new(
            value.clone(),
            anyhow::anyhow!("tools must be an array of objects"),
            None,
        )
        .into()),
    }
}

/// `ParallelToolCallMetadata`: the wrapper call a tool call or result came from.
#[derive(Debug, Clone, PartialEq)]
struct ParallelToolCallMetadata {
    item_id: String,
    tool_call_id: String,
    tool_name: String,
    input: String,
    index: usize,
    count: usize,
}

/// `getParallelToolCallMetadata`.
fn parallel_tool_call_metadata(
    options: Option<&ProviderOptions>,
    name: &str,
) -> Option<ParallelToolCallMetadata> {
    let metadata = named_value(options, name, "parallelToolCall")?.as_object()?;
    let integer = |key: &str| -> Option<f64> {
        let n = metadata.get(key)?.as_f64()?;
        (n.fract() == 0.0).then_some(n)
    };
    let index = integer("index")?;
    let count = integer("count")?;
    if index < 0.0 || count <= index {
        return None;
    }
    Some(ParallelToolCallMetadata {
        item_id: metadata.get("itemId")?.as_str()?.to_string(),
        tool_call_id: metadata.get("toolCallId")?.as_str()?.to_string(),
        tool_name: metadata.get("toolName")?.as_str()?.to_string(),
        input: metadata.get("input")?.as_str()?.to_string(),
        index: index as usize,
        count: count as usize,
    })
}

/// A wrapper call's results, complete and in order.
struct ParallelToolResultGroup<'a> {
    metadata: ParallelToolCallMetadata,
    results: Vec<&'a LanguageModelV4Part>,
}

/// `collectCompleteParallelToolResultGroups`.
fn collect_complete_parallel_tool_result_groups<'a>(
    prompt: &'a [LanguageModelV4Message],
    name: &str,
) -> HashMap<String, ParallelToolResultGroup<'a>> {
    struct Pending<'a> {
        metadata: ParallelToolCallMetadata,
        results: HashMap<usize, &'a LanguageModelV4Part>,
        invalid: bool,
    }
    let mut pending: Vec<(String, Pending<'a>)> = Vec::new();
    for message in prompt {
        let LanguageModelV4Message::Tool { content, .. } = message else {
            continue;
        };
        for part in content {
            if !matches!(part, LanguageModelV4Part::ToolResult { .. }) {
                continue;
            }
            let Some(metadata) = parallel_tool_call_metadata(part.provider_options(), name) else {
                continue;
            };
            match pending
                .iter_mut()
                .find(|(id, _)| *id == metadata.tool_call_id)
            {
                None => {
                    let mut results = HashMap::new();
                    results.insert(metadata.index, part);
                    pending.push((
                        metadata.tool_call_id.clone(),
                        Pending {
                            metadata,
                            results,
                            invalid: false,
                        },
                    ));
                }
                Some((_, existing)) => {
                    if !has_same_parallel_tool_call(&existing.metadata, &metadata)
                        || existing.results.contains_key(&metadata.index)
                    {
                        existing.invalid = true;
                        continue;
                    }
                    existing.results.insert(metadata.index, part);
                }
            }
        }
    }
    let mut complete = HashMap::new();
    for (tool_call_id, group) in pending {
        if group.invalid || group.results.len() != group.metadata.count {
            continue;
        }
        let results: Option<Vec<_>> = (0..group.metadata.count)
            .map(|index| group.results.get(&index).copied())
            .collect();
        if let Some(results) = results {
            complete.insert(
                tool_call_id,
                ParallelToolResultGroup {
                    metadata: group.metadata,
                    results,
                },
            );
        }
    }
    complete
}

fn has_same_parallel_tool_call(
    first: &ParallelToolCallMetadata,
    second: &ParallelToolCallMetadata,
) -> bool {
    first.item_id == second.item_id
        && first.tool_call_id == second.tool_call_id
        && first.tool_name == second.tool_name
        && first.input == second.input
        && first.count == second.count
}

/// `mapToolCaller`: `{ type: 'program', callerId }` becomes `caller_id`.
fn map_tool_caller(caller: Option<&Value>) -> Option<Value> {
    let caller = caller?;
    if caller.get("type").and_then(Value::as_str) == Some("program") {
        return Some(object(vec![
            ("type", text("program")),
            ("caller_id", caller.get("callerId").cloned()),
        ]));
    }
    Some(caller.clone())
}

/// The output of a tool result that is not `content`, with a breakpoint: the
/// breakpoint from the output, else from the result part.
fn scalar_tool_result_breakpoint(
    output: &ToolResultOutput,
    part_options: Option<&ProviderOptions>,
    name: &str,
) -> Option<Value> {
    let output_options = match output {
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
        ToolResultOutput::Content { .. } => return None,
    };
    prompt_cache_breakpoint(output_options, name)
        .or_else(|| prompt_cache_breakpoint(part_options, name))
}

/// `convertFunctionToolResultOutput`: a function call's output as a string, or as
/// input items.
fn convert_function_tool_result_output(
    output: &ToolResultOutput,
    tool_name: &str,
    output_schema_tool_names: &HashSet<String>,
    breakpoint: Option<Value>,
    name: &str,
    warnings: &mut Vec<Warning>,
) -> anyhow::Result<Value> {
    // `output` is always a string, but for functions with output_schema OpenAI
    // parses the contents of that string as JSON, so text-like results become JSON
    // string literals.
    let has_output_schema = output_schema_tool_names.contains(tool_name);
    let scalar = |value: String| -> Value {
        match &breakpoint {
            None => Value::String(value),
            Some(breakpoint) => Value::Array(vec![object(vec![
                ("type", text("input_text")),
                ("text", Some(Value::String(value))),
                ("prompt_cache_breakpoint", Some(breakpoint.clone())),
            ])]),
        }
    };
    let stringify_text = |value: &str| -> String {
        if has_output_schema {
            js_stringify(&Value::String(value.to_string()))
        } else {
            value.to_string()
        }
    };
    let error_json = |value: &Value| -> String {
        let mut wrapper = Map::new();
        wrapper.insert("error".to_string(), value.clone());
        js_stringify(&Value::Object(wrapper))
    };
    Ok(match output {
        ToolResultOutput::Text { value, .. } => scalar(stringify_text(value)),
        ToolResultOutput::ErrorText { value, .. } => {
            scalar(error_json(&Value::String(value.clone())))
        }
        ToolResultOutput::ErrorJson { value, .. } => scalar(error_json(value)),
        ToolResultOutput::ExecutionDenied { reason, .. } => scalar(stringify_text(
            reason.as_deref().unwrap_or("Tool call execution denied."),
        )),
        ToolResultOutput::Json { value, .. } => scalar(js_stringify(value)),
        ToolResultOutput::Content { value } => {
            let mut items = Vec::new();
            for item in value {
                if let Some(item) = convert_tool_content_item(item, name, warnings)? {
                    items.push(item);
                }
            }
            Value::Array(items)
        }
    })
}

/// One item of a `content` tool result as an input item; `None` with a warning for
/// one the API does not take.
fn convert_tool_content_item(
    item: &ToolResultContentPart,
    name: &str,
    warnings: &mut Vec<Warning>,
) -> anyhow::Result<Option<Value>> {
    match item {
        ToolResultContentPart::Text {
            text: value,
            provider_options,
        } => {
            let breakpoint = prompt_cache_breakpoint(provider_options.as_ref(), name);
            Ok(Some(object(vec![
                ("type", text("input_text")),
                ("text", text(value.clone())),
                ("prompt_cache_breakpoint", breakpoint),
            ])))
        }
        ToolResultContentPart::File {
            filename,
            data,
            media_type,
            provider_options,
        } => {
            let options = provider_options.as_ref();
            let breakpoint = prompt_cache_breakpoint(options, name);
            let is_image = top_level_media_type(media_type) == "image";
            let detail = named(options, name)
                .and_then(|o| o.get("imageDetail"))
                .cloned();
            match data {
                FileData::Reference { reference } => {
                    let file_id = resolve_provider_reference(reference, name)?;
                    if is_image {
                        return Ok(Some(object(vec![
                            ("type", text("input_image")),
                            ("file_id", text(file_id)),
                            ("detail", detail),
                            ("prompt_cache_breakpoint", breakpoint),
                        ])));
                    }
                    Ok(Some(object(vec![
                        ("type", text("input_file")),
                        ("file_id", text(file_id)),
                        ("prompt_cache_breakpoint", breakpoint),
                    ])))
                }
                FileData::Data { data: bytes } => {
                    let full_media_type = resolve_full_media_type(media_type, data)?;
                    if is_image {
                        return Ok(Some(object(vec![
                            ("type", text("input_image")),
                            ("image_url", text(data_uri(&full_media_type, bytes))),
                            ("detail", detail),
                            ("prompt_cache_breakpoint", breakpoint),
                        ])));
                    }
                    Ok(Some(object(vec![
                        ("type", text("input_file")),
                        (
                            "filename",
                            text(filename.clone().unwrap_or_else(|| "data".to_string())),
                        ),
                        ("file_data", text(data_uri(&full_media_type, bytes))),
                        ("prompt_cache_breakpoint", breakpoint),
                    ])))
                }
                FileData::Url { url, .. } => {
                    if is_image {
                        return Ok(Some(object(vec![
                            ("type", text("input_image")),
                            ("image_url", text(url.clone())),
                            ("detail", detail),
                            ("prompt_cache_breakpoint", breakpoint),
                        ])));
                    }
                    Ok(Some(object(vec![
                        ("type", text("input_file")),
                        ("file_url", text(url.clone())),
                        ("prompt_cache_breakpoint", breakpoint),
                    ])))
                }
                FileData::Text { .. } => {
                    warnings.push(Warning::Other {
                        message: "unsupported tool content part type: file with data type: text"
                            .to_string(),
                    });
                    Ok(None)
                }
            }
        }
        other => {
            let type_name = serde_json::to_value(other)
                .ok()
                .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            warnings.push(Warning::Other {
                message: format!("unsupported tool content part type: {type_name}"),
            });
            Ok(None)
        }
    }
}

/// One user part as an input content item.
fn convert_user_part(
    part: &LanguageModelV4Part,
    index: usize,
    options: &ConvertInputOptions<'_>,
) -> anyhow::Result<Option<Value>> {
    let name = options.provider_options_name;
    match part {
        LanguageModelV4Part::Text {
            text: value,
            provider_options,
        } => Ok(Some(object(vec![
            ("type", text("input_text")),
            ("text", text(value.clone())),
            (
                "prompt_cache_breakpoint",
                prompt_cache_breakpoint(provider_options.as_ref(), name),
            ),
        ]))),
        LanguageModelV4Part::File {
            filename,
            data,
            media_type,
            provider_options,
        } => {
            let part_options = provider_options.as_ref();
            let breakpoint = prompt_cache_breakpoint(part_options, name);
            let detail = named(part_options, name)
                .and_then(|o| o.get("imageDetail"))
                .cloned();
            let is_image = top_level_media_type(media_type) == "image";
            match data {
                FileData::Reference { reference } => {
                    let file_id = resolve_provider_reference(reference, name)?;
                    if is_image {
                        return Ok(Some(object(vec![
                            ("type", text("input_image")),
                            ("file_id", text(file_id)),
                            ("detail", detail),
                            ("prompt_cache_breakpoint", breakpoint),
                        ])));
                    }
                    Ok(Some(object(vec![
                        ("type", text("input_file")),
                        ("file_id", text(file_id)),
                        ("prompt_cache_breakpoint", breakpoint),
                    ])))
                }
                FileData::Text { .. } => Err(unsupported("text file parts")),
                FileData::Url { url, .. } => {
                    if is_image {
                        return Ok(Some(object(vec![
                            ("type", text("input_image")),
                            ("image_url", text(url.clone())),
                            ("detail", detail),
                            ("prompt_cache_breakpoint", breakpoint),
                        ])));
                    }
                    Ok(Some(object(vec![
                        ("type", text("input_file")),
                        ("file_url", text(url.clone())),
                        ("prompt_cache_breakpoint", breakpoint),
                    ])))
                }
                FileData::Data { data: bytes } => {
                    if is_image {
                        let source = match is_file_id(bytes, options.file_id_prefixes) {
                            Some(file_id) => ("file_id", text(file_id)),
                            None => {
                                let full_media_type = resolve_full_media_type(media_type, data)?;
                                ("image_url", text(data_uri(&full_media_type, bytes)))
                            }
                        };
                        return Ok(Some(object(vec![
                            ("type", text("input_image")),
                            source,
                            ("detail", detail),
                            ("prompt_cache_breakpoint", breakpoint),
                        ])));
                    }
                    let full_media_type = resolve_full_media_type(media_type, data)?;
                    if full_media_type != "application/pdf"
                        && !options.pass_through_unsupported_files
                    {
                        return Err(unsupported(&format!(
                            "file part media type {full_media_type}"
                        )));
                    }
                    let mut entries = vec![("type", text("input_file"))];
                    match is_file_id(bytes, options.file_id_prefixes) {
                        Some(file_id) => entries.push(("file_id", text(file_id))),
                        None => {
                            let filename = filename.clone().unwrap_or_else(|| {
                                if full_media_type == "application/pdf" {
                                    format!("part-{index}.pdf")
                                } else {
                                    format!("part-{index}")
                                }
                            });
                            entries.push(("filename", text(filename)));
                            entries.push(("file_data", text(data_uri(&full_media_type, bytes))));
                        }
                    }
                    entries.push(("prompt_cache_breakpoint", breakpoint));
                    Ok(Some(object(entries)))
                }
            }
        }
        // A user message holds text and files only.
        _ => Ok(None),
    }
}

pub(crate) fn effort_text(effort: ReasoningEffortUpdate) -> &'static str {
    match effort {
        ReasoningEffortUpdate::None => "none",
        ReasoningEffortUpdate::Low => "low",
        ReasoningEffortUpdate::Medium => "medium",
        ReasoningEffortUpdate::High => "high",
        ReasoningEffortUpdate::Xhigh => "xhigh",
        ReasoningEffortUpdate::Max => "max",
    }
}

/// `convertToOpenAIResponsesInput`.
pub fn convert_to_openai_responses_input(
    prompt: &[LanguageModelV4Message],
    options: &ConvertInputOptions<'_>,
) -> anyhow::Result<(Vec<Value>, Vec<Warning>)> {
    let name = options.provider_options_name;
    let store = options.store;
    let mut input: Vec<Value> = Vec::new();
    let mut warnings: Vec<Warning> = Vec::new();
    let mut processed_approval_ids: HashSet<String> = HashSet::new();
    let mut programmatic_tool_call_ids: HashSet<String> = HashSet::new();
    let parallel_groups = if options.has_conversation || options.has_previous_response_id {
        collect_complete_parallel_tool_result_groups(prompt, name)
    } else {
        HashMap::new()
    };
    let mut emitted_parallel_tool_calls: HashSet<String> = HashSet::new();
    let mut emitted_parallel_tool_results: HashSet<String> = HashSet::new();

    for message in prompt {
        match message {
            LanguageModelV4Message::System {
                content,
                provider_options,
            } => {
                // Keep effort updates at their original positions so they apply to the
                // same parts of the conversation when the history is sent again.
                let mut system_options: Option<SystemMessageOptions> =
                    parse_provider_options(name, provider_options.as_ref())?;
                if system_options.is_none() && name != "openai" {
                    system_options = parse_provider_options("openai", provider_options.as_ref())?;
                }
                if let Some(effort) = system_options.and_then(|o| o.reasoning_effort_update) {
                    let unsupported_reason = if !content.is_empty() {
                        Some(
                            "Message-level reasoningEffortUpdate requires empty system message content.",
                        )
                    } else {
                        options.configuration_update_unsupported_reason
                    };
                    if let Some(reason) = unsupported_reason {
                        return Err(UnsupportedFunctionalityError::with_message(
                            "Message-level reasoningEffortUpdate",
                            reason,
                        )
                        .into());
                    }
                    input.push(configuration_update(effort_text(effort)));
                    // The control is independent of systemMessageMode's text handling.
                    continue;
                }

                let role = match options.system_message_mode {
                    SystemMessageMode::System => "system",
                    SystemMessageMode::Developer => "developer",
                    SystemMessageMode::Remove => {
                        warnings.push(Warning::Other {
                            message: "system messages are removed for this model".to_string(),
                        });
                        continue;
                    }
                };
                let breakpoint = prompt_cache_breakpoint(provider_options.as_ref(), name);
                let content = match breakpoint {
                    None => Value::String(content.clone()),
                    Some(breakpoint) => Value::Array(vec![object(vec![
                        ("type", text("input_text")),
                        ("text", text(content.clone())),
                        ("prompt_cache_breakpoint", Some(breakpoint)),
                    ])]),
                };
                input.push(object(vec![
                    ("type", message_type(options.explicit_message_item_type)),
                    ("role", text(role)),
                    ("content", Some(content)),
                ]));
            }

            LanguageModelV4Message::User { content, .. } => {
                let mut parts = Vec::new();
                for (index, part) in content.iter().enumerate() {
                    if let Some(item) = convert_user_part(part, index, options)? {
                        parts.push(item);
                    }
                }
                input.push(object(vec![
                    ("type", message_type(options.explicit_message_item_type)),
                    ("role", text("user")),
                    ("content", Some(Value::Array(parts))),
                ]));
            }

            LanguageModelV4Message::Assistant { content, .. } => {
                // Reasoning item id → its index in `input`, or `None` for one sent
                // as a reference.
                let mut reasoning_messages: HashMap<String, Option<usize>> = HashMap::new();
                let mut emitted_text_item_ids: HashSet<String> = HashSet::new();
                // Stored messages of reasoning models are bound to the reasoning item
                // that produced them. When the reasoning has been removed, referencing
                // the message fails, so it is sent with its content instead.
                let mut has_preceding_reasoning = false;

                for part in content {
                    match part {
                        LanguageModelV4Part::Text {
                            text: value,
                            provider_options,
                        } => {
                            let part_options = provider_options.as_ref();
                            let id = named_str(part_options, name, "itemId");
                            let phase = named_value(part_options, name, "phase").cloned();

                            // With a conversation, skip items that already exist in
                            // it to avoid "Duplicate item found" errors.
                            if options.has_conversation && id.is_some() {
                                continue;
                            }
                            // Item references reduce the payload size.
                            if let Some(id) = id
                                && store
                                && (!options.is_reasoning_model || has_preceding_reasoning)
                            {
                                if emitted_text_item_ids.insert(id.to_string()) {
                                    input.push(item_reference(id));
                                }
                                continue;
                            }
                            input.push(object(vec![
                                ("type", message_type(options.explicit_message_item_type)),
                                ("role", text("assistant")),
                                ("content", text(value.clone())),
                                ("phase", phase),
                            ]));
                        }

                        LanguageModelV4Part::ToolCall {
                            tool_call_id,
                            tool_name,
                            input: tool_input,
                            provider_executed,
                            provider_options,
                        } => {
                            let part_options = provider_options.as_ref();
                            let parallel = parallel_tool_call_metadata(part_options, name);
                            if let Some(metadata) = &parallel
                                && let Some(group) = parallel_groups.get(&metadata.tool_call_id)
                                && has_same_parallel_tool_call(&group.metadata, metadata)
                            {
                                if emitted_parallel_tool_calls.insert(group.metadata.tool_call_id.clone())
                                    // Conversations already contain the original
                                    // wrapper item; previousResponseId chains need
                                    // plain client function calls in full.
                                    && !options.has_conversation
                                {
                                    input.push(object(vec![
                                        ("type", text("function_call")),
                                        ("call_id", text(group.metadata.tool_call_id.clone())),
                                        ("name", text(group.metadata.tool_name.clone())),
                                        ("arguments", text(group.metadata.input.clone())),
                                    ]));
                                }
                                continue;
                            }

                            let id = named_str(part_options, name, "itemId");
                            let namespace = named_value(part_options, name, "namespace").cloned();
                            let is_async = named_value(part_options, name, "async").cloned();
                            let caller = named_value(part_options, name, "caller");
                            if caller.and_then(|c| c.get("type")).and_then(Value::as_str)
                                == Some("program")
                            {
                                programmatic_tool_call_ids.insert(tool_call_id.clone());
                            }
                            if options.has_conversation && id.is_some() {
                                continue;
                            }

                            let resolved =
                                options.tool_name_mapping.to_provider_tool_name(tool_name);

                            if Some(tool_name.as_str()) == options.tool_search_tool_name {
                                if let Some(id) = id
                                    && store
                                {
                                    input.push(item_reference(id));
                                    continue;
                                }
                                let parsed = parse_tool_search_input(tool_input)?;
                                let call_id =
                                    parsed.get("call_id").filter(|v| !v.is_null()).cloned();
                                let execution = if call_id.is_some() {
                                    "client"
                                } else {
                                    "server"
                                };
                                input.push(object(vec![
                                    ("type", text("tool_search_call")),
                                    ("id", text(id.unwrap_or(tool_call_id))),
                                    ("execution", text(execution)),
                                    ("call_id", Some(call_id.unwrap_or(Value::Null))),
                                    ("status", text("completed")),
                                    ("arguments", parsed.get("arguments").cloned()),
                                ]));
                                continue;
                            }

                            if resolved == "programmatic_tool_calling" {
                                if let Some(id) = id
                                    && store
                                {
                                    input.push(item_reference(id));
                                    continue;
                                }
                                return Err(unsupported(
                                    "programmatic tool calls without stored responses",
                                ));
                            }

                            if *provider_executed == Some(true) {
                                if let Some(id) = id
                                    && store
                                {
                                    input.push(item_reference(id));
                                }
                                continue;
                            }

                            // Plain client-executed function calls are never sent as
                            // item references: the matching `function_call_output`
                            // references the call by `call_id`, which the API cannot
                            // reconcile with an item id.
                            let arguments = js_stringify(tool_input);
                            input.push(object(vec![
                                ("type", text("function_call")),
                                ("call_id", text(tool_call_id.clone())),
                                ("name", text(resolved)),
                                ("arguments", text(arguments)),
                                ("async", is_async),
                                ("namespace", namespace),
                                ("caller", map_tool_caller(caller)),
                            ]));
                        }

                        // Assistant tool results are from provider-executed tools.
                        LanguageModelV4Part::ToolResult {
                            tool_call_id,
                            tool_name,
                            output,
                            provider_options,
                        } => {
                            // Results of denied approvals have no item in OpenAI's store.
                            let denied = match output {
                                ToolResultOutput::ExecutionDenied { .. } => true,
                                ToolResultOutput::Json { value, .. } => {
                                    value.get("type").and_then(Value::as_str)
                                        == Some("execution-denied")
                                }
                                _ => false,
                            };
                            if denied || options.has_conversation {
                                continue;
                            }
                            let part_options = provider_options.as_ref();
                            let item_id = named_str(part_options, name, "itemId")
                                .unwrap_or(tool_call_id)
                                .to_string();
                            let resolved =
                                options.tool_name_mapping.to_provider_tool_name(tool_name);

                            if Some(tool_name.as_str()) == options.tool_search_tool_name {
                                if store {
                                    input.push(item_reference(&item_id));
                                } else if let ToolResultOutput::Json { value, .. } = output {
                                    let tools = tool_search_output_tools(value)?;
                                    input.push(object(vec![
                                        ("type", text("tool_search_output")),
                                        ("id", text(item_id)),
                                        ("execution", text("server")),
                                        ("call_id", Some(Value::Null)),
                                        ("status", text("completed")),
                                        ("tools", Some(tools)),
                                    ]));
                                }
                                continue;
                            }

                            if resolved == "programmatic_tool_calling" {
                                if store {
                                    input.push(item_reference(&item_id));
                                } else if matches!(output, ToolResultOutput::Json { .. }) {
                                    return Err(unsupported(
                                        "programmatic tool results without stored responses",
                                    ));
                                }
                                continue;
                            }

                            if store {
                                input.push(item_reference(&item_id));
                            } else {
                                warnings.push(Warning::Other {
                                    message: format!(
                                        "Results for OpenAI tool {tool_name} are not sent to the API when store is false"
                                    ),
                                });
                            }
                        }

                        LanguageModelV4Part::Reasoning {
                            text: value,
                            provider_options,
                        } => {
                            has_preceding_reasoning = true;
                            let reasoning_options: Option<ReasoningPartOptions> =
                                parse_provider_options(name, provider_options.as_ref())?;
                            let reasoning_id =
                                reasoning_options.as_ref().and_then(|o| o.item_id.clone());
                            let encrypted = reasoning_options
                                .as_ref()
                                .and_then(|o| o.reasoning_encrypted_content.clone());

                            if (options.has_conversation || options.has_previous_response_id)
                                && reasoning_id.is_some()
                            {
                                continue;
                            }

                            let Some(reasoning_id) = reasoning_id else {
                                // Without an item id, encrypted content still carries
                                // the reasoning to the next request.
                                match encrypted {
                                    Some(encrypted) => {
                                        let mut summary = Vec::new();
                                        if !value.is_empty() {
                                            summary.push(summary_text(value));
                                        }
                                        input.push(object(vec![
                                            ("type", text("reasoning")),
                                            ("encrypted_content", text(encrypted)),
                                            ("summary", Some(Value::Array(summary))),
                                        ]));
                                    }
                                    None => warnings.push(Warning::Other {
                                        message: format!(
                                            "Non-OpenAI reasoning parts are not supported. Skipping reasoning part: {}.",
                                            part_json(part)
                                        ),
                                    }),
                                }
                                continue;
                            };

                            let existing = reasoning_messages.get(&reasoning_id).copied();
                            if store {
                                // One reference, when the first part of the item is met.
                                if existing.is_none() {
                                    input.push(item_reference(&reasoning_id));
                                    reasoning_messages.insert(reasoning_id, None);
                                }
                                continue;
                            }

                            let mut summary_parts = Vec::new();
                            if !value.is_empty() {
                                summary_parts.push(summary_text(value));
                            } else if existing.is_some() {
                                warnings.push(Warning::Other {
                                    message: format!(
                                        "Cannot append empty reasoning part to existing reasoning sequence. Skipping reasoning part: {}.",
                                        part_json(part)
                                    ),
                                });
                            }
                            match existing {
                                None => {
                                    reasoning_messages
                                        .insert(reasoning_id.clone(), Some(input.len()));
                                    input.push(object(vec![
                                        ("type", text("reasoning")),
                                        ("id", text(reasoning_id)),
                                        ("encrypted_content", encrypted.map(Value::String)),
                                        ("summary", Some(Value::Array(summary_parts))),
                                    ]));
                                }
                                Some(index) => {
                                    let Some(Value::Object(item)) =
                                        index.and_then(|i| input.get_mut(i))
                                    else {
                                        continue;
                                    };
                                    if let Some(Value::Array(summary)) = item.get_mut("summary") {
                                        summary.extend(summary_parts);
                                    }
                                    // The encrypted content of the last summary part wins.
                                    if let Some(encrypted) = encrypted {
                                        insert_before(
                                            item,
                                            "encrypted_content",
                                            Value::String(encrypted),
                                            "summary",
                                        );
                                    }
                                }
                            }
                        }

                        LanguageModelV4Part::Custom {
                            kind,
                            provider_options,
                        } => {
                            if kind != "openai.compaction" {
                                continue;
                            }
                            let part_options = provider_options.as_ref();
                            let id = named_str(part_options, name, "itemId");
                            if options.has_conversation && id.is_some() {
                                continue;
                            }
                            if let Some(id) = id
                                && store
                            {
                                input.push(item_reference(id));
                                continue;
                            }
                            if let Some(id) = id {
                                input.push(object(vec![
                                    ("type", text("compaction")),
                                    ("id", text(id)),
                                    (
                                        "encrypted_content",
                                        named_value(part_options, name, "encryptedContent")
                                            .cloned(),
                                    ),
                                ]));
                            }
                        }

                        _ => {}
                    }
                }
            }

            LanguageModelV4Message::Tool { content, .. } => {
                for part in content {
                    if let LanguageModelV4Part::ToolApprovalResponse {
                        approval_id,
                        approved,
                        ..
                    } = part
                    {
                        if !processed_approval_ids.insert(approval_id.clone()) {
                            continue;
                        }
                        if store && !options.has_conversation && !options.has_previous_response_id {
                            input.push(item_reference(approval_id));
                        }
                        input.push(object(vec![
                            ("type", text("mcp_approval_response")),
                            ("approval_request_id", text(approval_id.clone())),
                            ("approve", Some(Value::Bool(*approved))),
                        ]));
                        continue;
                    }

                    let LanguageModelV4Part::ToolResult {
                        tool_call_id,
                        tool_name,
                        output,
                        provider_options,
                    } = part
                    else {
                        continue;
                    };
                    let part_options = provider_options.as_ref();

                    let parallel = parallel_tool_call_metadata(part_options, name);
                    if let Some(metadata) = &parallel
                        && let Some(group) = parallel_groups.get(&metadata.tool_call_id)
                        && has_same_parallel_tool_call(&group.metadata, metadata)
                    {
                        if emitted_parallel_tool_results.insert(group.metadata.tool_call_id.clone())
                        {
                            input.push(parallel_function_call_output(
                                group,
                                options.output_schema_tool_names,
                                name,
                                &mut warnings,
                            )?);
                        }
                        continue;
                    }

                    // Execution-denied results with an approval id are answered by the
                    // approval response.
                    if let ToolResultOutput::ExecutionDenied {
                        provider_options: Some(output_options),
                        ..
                    } = output
                        && named(Some(output_options), "openai")
                            .and_then(|o| o.get("approvalId"))
                            .is_some_and(is_truthy)
                    {
                        continue;
                    }

                    if Some(tool_name.as_str()) == options.tool_search_tool_name
                        && let ToolResultOutput::Json { value, .. } = output
                    {
                        let tools = tool_search_output_tools(value)?;
                        input.push(object(vec![
                            ("type", text("tool_search_output")),
                            ("execution", text("client")),
                            ("call_id", text(tool_call_id.clone())),
                            ("status", text("completed")),
                            ("tools", Some(tools)),
                        ]));
                        continue;
                    }

                    let result_caller = named_value(part_options, name, "caller");
                    if matches!(output, ToolResultOutput::ExecutionDenied { .. })
                        && (result_caller
                            .and_then(|c| c.get("type"))
                            .and_then(Value::as_str)
                            == Some("program")
                            || programmatic_tool_call_ids.contains(tool_call_id))
                    {
                        return Err(unsupported(
                            "execution-denied results for programmatic tool calls",
                        ));
                    }

                    let breakpoint = scalar_tool_result_breakpoint(output, part_options, name);
                    let content_value = convert_function_tool_result_output(
                        output,
                        tool_name,
                        options.output_schema_tool_names,
                        breakpoint,
                        name,
                        &mut warnings,
                    )?;
                    input.push(object(vec![
                        ("type", text("function_call_output")),
                        ("call_id", text(tool_call_id.clone())),
                        ("output", Some(content_value)),
                        ("caller", map_tool_caller(result_caller)),
                    ]));

                    let result_options: Option<ToolResultOptions> =
                        parse_provider_options(name, part_options)?;
                    if let Some(tools) = result_options
                        .and_then(|o| o.additional_tools)
                        .filter(|tools| !tools.is_empty())
                    {
                        input.push(object(vec![
                            ("type", text("additional_tools")),
                            ("role", text("developer")),
                            ("tools", Some(Value::Array(tools))),
                        ]));
                    }
                }
            }
        }
    }

    // Without stored responses, reasoning items without encrypted content are dropped.
    let is_bare_reasoning = |item: &Value| {
        item.get("type").and_then(Value::as_str) == Some("reasoning")
            && item.get("encrypted_content").is_none_or(Value::is_null)
    };
    if !store && input.iter().any(is_bare_reasoning) {
        warnings.push(Warning::Other {
            message: "Reasoning parts without encrypted content are not supported when store is false. Skipping reasoning parts."
                .to_string(),
        });
        input.retain(|item| !is_bare_reasoning(item));
    }

    Ok((input, warnings))
}

/// The one output of a parallel wrapper call: its results in the order of the
/// wrapper's `tool_uses`.
fn parallel_function_call_output(
    group: &ParallelToolResultGroup<'_>,
    output_schema_tool_names: &HashSet<String>,
    name: &str,
    warnings: &mut Vec<Warning>,
) -> anyhow::Result<Value> {
    let mut outputs: Vec<(String, Option<Value>)> = Vec::new();
    for result in &group.results {
        let LanguageModelV4Part::ToolResult {
            tool_name,
            output,
            provider_options,
            ..
        } = result
        else {
            continue;
        };
        let breakpoint = scalar_tool_result_breakpoint(output, provider_options.as_ref(), name);
        let converted = convert_function_tool_result_output(
            output,
            tool_name,
            output_schema_tool_names,
            None,
            name,
            warnings,
        )?;
        let serialized = match converted {
            Value::String(text) => text,
            other => js_stringify(&other),
        };
        outputs.push((serialized, breakpoint));
    }
    let has_breakpoint = outputs.iter().any(|(_, b)| b.is_some());
    let output = if has_breakpoint {
        Value::Array(
            outputs
                .into_iter()
                .enumerate()
                .map(|(index, (serialized, breakpoint))| {
                    let value = if index == 0 {
                        serialized
                    } else {
                        format!("\n{serialized}")
                    };
                    object(vec![
                        ("type", text("input_text")),
                        ("text", text(value)),
                        ("prompt_cache_breakpoint", breakpoint),
                    ])
                })
                .collect(),
        )
    } else {
        Value::String(
            outputs
                .into_iter()
                .map(|(serialized, _)| serialized)
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    Ok(object(vec![
        ("type", text("function_call_output")),
        ("call_id", text(group.metadata.tool_call_id.clone())),
        ("output", Some(output)),
    ]))
}

/// `{ type: 'configuration_update', reasoning: { effort } }`.
pub fn configuration_update(effort: &str) -> Value {
    object(vec![
        ("type", text("configuration_update")),
        ("reasoning", Some(object(vec![("effort", text(effort))]))),
    ])
}

fn summary_text(value: &str) -> Value {
    object(vec![("type", text("summary_text")), ("text", text(value))])
}

/// The part as `JSON.stringify` writes it.
fn part_json(part: &LanguageModelV4Part) -> String {
    serde_json::to_value(part)
        .map(|v| js_stringify(&v))
        .unwrap_or_default()
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Sets `key`, placing a new key before `before` as an object literal that declares
/// it there would. An existing key keeps its place.
fn insert_before(map: &mut Map<String, Value>, key: &str, value: Value, before: &str) {
    if map.contains_key(key) {
        map.insert(key.to_string(), value);
        return;
    }
    let entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
    for (k, v) in entries {
        if k == before {
            map.insert(key.to_string(), value.clone());
        }
        map.insert(k, v);
    }
    if !map.contains_key(key) {
        map.insert(key.to_string(), value);
    }
}
