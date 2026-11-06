//! A caller's prompt, checked (`standardizePrompt`) and converted to the prompt a
//! provider receives (`convertToLanguageModelPrompt`).

use std::collections::{HashMap, HashSet};

use bytes::Bytes;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::errors::{
    AbortError, DownloadError, InvalidDataContentError, InvalidPromptError, MissingToolResultsError,
};
use super::json::base64_to_bytes;
use super::messages::{
    AssistantContent, AssistantContentPart, FilePart, FilePartData, ImagePart, ModelMessage,
    SystemModelMessage, TextPart, ToolContentPart, UserContent, UserContentPart,
};
use super::provider::{
    DataContent, FileData, LanguageModelV4Message, LanguageModelV4Part, LanguageModelV4Prompt,
    ProviderOptions, ProviderReference, SupportedUrls, ToolResultContentPart, ToolResultOutput,
    Warning,
};
use super::warnings::log_warnings;

/// System instructions: text, one system message, or several.
#[derive(Debug, Clone, PartialEq)]
pub enum Instructions {
    Text(String),
    Message(SystemModelMessage),
    Messages(Vec<SystemModelMessage>),
}

impl Instructions {
    /// The instructions as system messages, as the provider receives them.
    pub fn to_system_messages(&self) -> Vec<LanguageModelV4Message> {
        match self {
            Instructions::Text(text) => {
                vec![LanguageModelV4Message::System {
                    content: text.clone(),
                    provider_options: None,
                }]
            }
            Instructions::Message(m) => vec![LanguageModelV4Message::System {
                content: m.content.clone(),
                provider_options: m.provider_options.clone(),
            }],
            Instructions::Messages(list) => list
                .iter()
                .map(|m| LanguageModelV4Message::System {
                    content: m.content.clone(),
                    provider_options: m.provider_options.clone(),
                })
                .collect(),
        }
    }
}

fn system_message_json(m: &SystemModelMessage) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("role".into(), json!("system"));
    map.insert("content".into(), json!(m.content));
    if let Some(options) = &m.provider_options {
        map.insert("providerOptions".into(), Value::Object(options.clone()));
    }
    Value::Object(map)
}

impl Serialize for Instructions {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Instructions::Text(text) => serializer.serialize_str(text),
            Instructions::Message(m) => system_message_json(m).serialize(serializer),
            Instructions::Messages(list) => {
                Value::Array(list.iter().map(system_message_json).collect()).serialize(serializer)
            }
        }
    }
}

impl From<String> for Instructions {
    fn from(text: String) -> Self {
        Instructions::Text(text)
    }
}

impl From<&str> for Instructions {
    fn from(text: &str) -> Self {
        Instructions::Text(text.to_string())
    }
}

impl From<SystemModelMessage> for Instructions {
    fn from(m: SystemModelMessage) -> Self {
        Instructions::Message(m)
    }
}

impl From<Vec<SystemModelMessage>> for Instructions {
    fn from(list: Vec<SystemModelMessage>) -> Self {
        Instructions::Messages(list)
    }
}

/// The `prompt` option: text, or messages.
#[derive(Debug, Clone, PartialEq)]
pub enum Prompt {
    Text(String),
    Messages(Vec<ModelMessage>),
}

impl Serialize for Prompt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Prompt::Text(text) => serializer.serialize_str(text),
            Prompt::Messages(list) => list.serialize(serializer),
        }
    }
}

impl From<String> for Prompt {
    fn from(text: String) -> Self {
        Prompt::Text(text)
    }
}

impl From<&str> for Prompt {
    fn from(text: &str) -> Self {
        Prompt::Text(text.to_string())
    }
}

impl From<Vec<ModelMessage>> for Prompt {
    fn from(list: Vec<ModelMessage>) -> Self {
        Prompt::Messages(list)
    }
}

/// A checked prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct StandardizedPrompt {
    pub instructions: Option<Instructions>,
    pub messages: Vec<ModelMessage>,
}

/// `standardizePrompt`: exactly one of `prompt` and `messages`, not empty, and no
/// system message among them unless the caller allows it.
pub fn standardize_prompt(
    instructions: Option<Instructions>,
    prompt: Option<Prompt>,
    messages: Option<Vec<ModelMessage>>,
    allow_system_in_messages: bool,
) -> Result<StandardizedPrompt, InvalidPromptError> {
    let messages = match (prompt, messages) {
        (None, None) => {
            return Err(InvalidPromptError::new(
                "prompt or messages must be defined",
            ));
        }
        (Some(_), Some(_)) => {
            return Err(InvalidPromptError::new(
                "prompt and messages cannot be defined at the same time",
            ));
        }
        (Some(Prompt::Text(text)), None) => vec![ModelMessage::user(text)],
        (Some(Prompt::Messages(list)), None) => list,
        (None, Some(list)) => list,
    };
    if messages.is_empty() {
        return Err(InvalidPromptError::new("messages must not be empty"));
    }
    if !allow_system_in_messages
        && messages
            .iter()
            .any(|m| matches!(m, ModelMessage::System(_)))
    {
        return Err(InvalidPromptError::new(
            "System messages are not allowed in the prompt or messages fields. Use the instructions option instead.",
        ));
    }
    Ok(StandardizedPrompt {
        instructions,
        messages,
    })
}

/// A downloaded file: its bytes and the media type the server named.
#[derive(Debug, Clone)]
pub struct DownloadedAsset {
    pub data: Bytes,
    pub media_type: Option<String>,
}

/// `mergeObjects`: a deep merge where `overrides` wins; `None` on both sides is
/// `None`.
pub fn merge_objects(
    base: Option<&ProviderOptions>,
    overrides: Option<&ProviderOptions>,
) -> Option<ProviderOptions> {
    match (base, overrides) {
        (None, None) => None,
        (None, Some(o)) => Some(o.clone()),
        (Some(b), None) => Some(b.clone()),
        (Some(b), Some(o)) => Some(merge_maps(b, o)),
    }
}

fn merge_maps(
    base: &serde_json::Map<String, Value>,
    overrides: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let mut result = base.clone();
    for (key, value) in overrides {
        if key == "__proto__" || key == "constructor" || key == "prototype" {
            continue;
        }
        match (result.get(key), value) {
            (Some(Value::Object(b)), Value::Object(o)) => {
                let merged = merge_maps(b, o);
                result.insert(key.clone(), Value::Object(merged));
            }
            _ => {
                result.insert(key.clone(), value.clone());
            }
        }
    }
    result
}

/// The image signatures `detectMediaType` checks for `image/*` data.
const IMAGE_SIGNATURES: &[(&str, &[Option<u8>])] = &[
    (
        "image/gif",
        &[
            Some(0x47),
            Some(0x49),
            Some(0x46),
            Some(0x38),
            Some(0x37),
            Some(0x61),
        ],
    ),
    (
        "image/gif",
        &[
            Some(0x47),
            Some(0x49),
            Some(0x46),
            Some(0x38),
            Some(0x39),
            Some(0x61),
        ],
    ),
    (
        "image/png",
        &[Some(0x89), Some(0x50), Some(0x4e), Some(0x47)],
    ),
    ("image/jpeg", &[Some(0xff), Some(0xd8)]),
    (
        "image/webp",
        &[
            Some(0x52),
            Some(0x49),
            Some(0x46),
            Some(0x46),
            None,
            None,
            None,
            None,
            Some(0x57),
            Some(0x45),
            Some(0x42),
            Some(0x50),
        ],
    ),
    (
        "image/bmp",
        &[
            Some(0x42),
            Some(0x4d),
            None,
            None,
            None,
            None,
            Some(0x00),
            Some(0x00),
            Some(0x00),
            Some(0x00),
        ],
    ),
    (
        "image/tiff",
        &[Some(0x49), Some(0x49), Some(0x2a), Some(0x00)],
    ),
    (
        "image/tiff",
        &[Some(0x4d), Some(0x4d), Some(0x00), Some(0x2a)],
    ),
    (
        "image/avif",
        &[
            Some(0x00),
            Some(0x00),
            Some(0x00),
            None,
            Some(0x66),
            Some(0x74),
            Some(0x79),
            Some(0x70),
            Some(0x61),
            Some(0x76),
            Some(0x69),
            Some(0x66),
        ],
    ),
    (
        "image/heic",
        &[
            Some(0x00),
            Some(0x00),
            Some(0x00),
            None,
            Some(0x66),
            Some(0x74),
            Some(0x79),
            Some(0x70),
            Some(0x68),
            Some(0x65),
            Some(0x69),
            Some(0x63),
        ],
    ),
];

const DEFAULT_SNIFF_BYTES: usize = 18;
const MAX_ID3_TAG_BYTES: usize = 128 * 1024;
const MAX_SIGNATURE_BYTES: usize = 12;

fn decode_prefix(data: &DataContent, max_bytes: usize) -> anyhow::Result<Vec<u8>> {
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

/// `detectMediaType({ data, topLevelType: 'image' })`.
pub fn detect_image_media_type(data: &DataContent) -> anyhow::Result<Option<&'static str>> {
    let mut bytes = decode_prefix(data, DEFAULT_SNIFF_BYTES)?;
    if bytes.len() > 10 && bytes[0] == 0x49 && bytes[1] == 0x44 && bytes[2] == 0x33 {
        let full = decode_prefix(data, MAX_ID3_TAG_BYTES + MAX_SIGNATURE_BYTES)?;
        let size = (((full[6] & 0x7f) as usize) << 21)
            | (((full[7] & 0x7f) as usize) << 14)
            | (((full[8] & 0x7f) as usize) << 7)
            | ((full[9] & 0x7f) as usize);
        bytes = full
            .get(size + 10..)
            .map(|s| s.to_vec())
            .unwrap_or_default();
    }
    for (media_type, prefix) in IMAGE_SIGNATURES {
        if bytes.len() >= prefix.len()
            && prefix
                .iter()
                .enumerate()
                .all(|(i, b)| b.is_none_or(|b| bytes[i] == b))
        {
            return Ok(Some(media_type));
        }
    }
    Ok(None)
}

/// `isFullMediaType`: a type with a subtype that is not `*`.
pub fn is_full_media_type(media_type: &str) -> bool {
    match media_type.find('/') {
        None => false,
        Some(i) => {
            let subtype = &media_type[i + 1..];
            !subtype.is_empty() && subtype != "*"
        }
    }
}

/// `isUrlSupported`: whether the model reads the URL itself.
pub fn is_url_supported(url: &str, media_type: &str, supported_urls: &SupportedUrls) -> bool {
    let url = url.to_lowercase();
    let media_type = media_type.to_lowercase();
    let top_level_only = !media_type.contains('/');
    supported_urls
        .iter()
        .filter(|(key, _)| {
            let key = key.to_lowercase();
            let prefix = if key == "*" || key == "*/*" {
                String::new()
            } else {
                key.replacen('*', "", 1)
            };
            if prefix.is_empty() {
                return true;
            }
            if top_level_only {
                return format!("{media_type}/") == prefix;
            }
            if prefix.ends_with('/') {
                media_type.starts_with(&prefix)
            } else {
                media_type == prefix
            }
        })
        .flat_map(|(_, patterns)| patterns.iter())
        .any(|pattern| pattern.is_match(&url))
}

fn split_data_url(data_url: &str) -> (Option<String>, Option<String>) {
    let mut pieces = data_url.split(',');
    let header = pieces.next().unwrap_or_default();
    let content = pieces.next().map(String::from);
    let media_type = header
        .split(';')
        .next()
        .and_then(|h| h.split(':').nth(1))
        .map(String::from);
    (media_type, content)
}

fn convert_url(
    url: &url::Url,
    original_url: Option<String>,
) -> anyhow::Result<(FileData, Option<String>)> {
    if url.scheme() == "data" {
        let (media_type, content) = split_data_url(url.as_str());
        return match (media_type, content) {
            (Some(media_type), Some(content)) => Ok((
                FileData::Data {
                    data: DataContent::Base64(content),
                },
                Some(media_type),
            )),
            _ => Err(InvalidDataContentError {
                message: format!("Invalid data URL format in content {}", url.as_str()),
                content: json!(url.as_str()),
                cause: None,
            }
            .into()),
        };
    }
    Ok((
        FileData::Url {
            url: url.as_str().to_string(),
            original_url,
        },
        None,
    ))
}

/// `convertToLanguageModelV4FilePart`: file data as the tagged union, and the
/// media type a data URL names.
pub fn convert_file_part_data(data: &FilePartData) -> anyhow::Result<(FileData, Option<String>)> {
    match data {
        FilePartData::Tagged(FileData::Data { data }) => {
            if let DataContent::Base64(text) = data {
                if text.starts_with("data:") {
                    return Err(InvalidDataContentError {
                        message: "Data URLs are not valid inline data. Pass them as { type: \"url\", url } instead."
                            .to_string(),
                        content: json!(text),
                        cause: None,
                    }
                    .into());
                }
            }
            Ok((FileData::Data { data: data.clone() }, None))
        }
        FilePartData::Tagged(FileData::Url { url, original_url }) => match url::Url::parse(url) {
            Ok(parsed) => convert_url(&parsed, original_url.clone()),
            Err(_) => Ok((
                FileData::Url {
                    url: url.clone(),
                    original_url: original_url.clone(),
                },
                None,
            )),
        },
        FilePartData::Tagged(other) => Ok((other.clone(), None)),
        FilePartData::Url(url) => convert_url(url, None),
        FilePartData::Data(DataContent::Base64(text)) => {
            let attempt = url::Url::parse(text)
                .map_err(anyhow::Error::from)
                .and_then(|parsed| {
                    let (data, media_type) = convert_url(&parsed, None)?;
                    Ok(match data {
                        FileData::Url { url, .. } if url != *text => (
                            FileData::Url {
                                url,
                                original_url: Some(text.clone()),
                            },
                            media_type,
                        ),
                        other => (other, media_type),
                    })
                });
            match attempt {
                Ok(result) => Ok(result),
                Err(_) => Ok((
                    FileData::Data {
                        data: DataContent::Base64(text.clone()),
                    },
                    None,
                )),
            }
        }
        FilePartData::Data(bytes @ DataContent::Bytes(_)) => Ok((
            FileData::Data {
                data: bytes.clone(),
            },
            None,
        )),
        FilePartData::Reference(reference) => Ok((
            FileData::Reference {
                reference: reference.clone(),
            },
            None,
        )),
    }
}

fn image_to_file(part: &ImagePart) -> FilePart {
    FilePart {
        data: part.image.clone(),
        filename: None,
        media_type: part
            .media_type
            .clone()
            .unwrap_or_else(|| "image".to_string()),
        provider_options: part.provider_options.clone(),
    }
}

fn convert_text_part(part: &TextPart) -> LanguageModelV4Part {
    LanguageModelV4Part::Text {
        text: part.text.clone(),
        provider_options: part.provider_options.clone(),
    }
}

/// `convertPartToLanguageModelPart` for a file part.
fn convert_file_part(
    part: &FilePart,
    downloaded: &HashMap<String, DownloadedAsset>,
) -> anyhow::Result<LanguageModelV4Part> {
    let (normalized, data_url_media_type) = convert_file_part_data(&part.data)?;
    let mut media_type: Option<String> =
        data_url_media_type.or_else(|| Some(part.media_type.clone()));
    let mut data = normalized;
    if let FileData::Url { url, .. } = &data {
        if let Some(asset) = downloaded.get(url) {
            let asset = asset.clone();
            data = FileData::Data {
                data: DataContent::Bytes(asset.data),
            };
            if let Some(downloaded_type) = asset.media_type {
                if media_type.as_deref().is_none_or(|m| !is_full_media_type(m)) {
                    media_type = Some(downloaded_type);
                }
            }
        }
    }
    if let FileData::Data { data: content } = &data {
        if let Some(detected) = detect_image_media_type(content)? {
            media_type = Some(detected.to_string());
        }
    }
    let media_type =
        media_type.ok_or_else(|| anyhow::anyhow!("Media type is missing for file part"))?;
    Ok(LanguageModelV4Part::File {
        filename: part.filename.clone(),
        data,
        media_type,
        provider_options: part.provider_options.clone(),
    })
}

const URL_EXTENSION_TO_MEDIA_TYPE: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("heic", "image/heic"),
    ("bmp", "image/bmp"),
    ("tiff", "image/tiff"),
    ("tif", "image/tiff"),
    ("pdf", "application/pdf"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
];

fn media_type_from_url(url: &str) -> String {
    let fallback = "application/octet-stream".to_string();
    let Ok(parsed) = url::Url::parse(url) else {
        return fallback;
    };
    let extension = parsed.path().rsplit('.').next().map(|e| e.to_lowercase());
    match extension {
        Some(ext) if !ext.is_empty() => URL_EXTENSION_TO_MEDIA_TYPE
            .iter()
            .find(|(e, _)| *e == ext)
            .map(|(_, m)| m.to_string())
            .unwrap_or(fallback),
        _ => fallback,
    }
}

fn file_id_reference(file_id: &Value, provider: Option<&str>) -> anyhow::Result<ProviderReference> {
    match file_id {
        Value::Object(map) => Ok(map
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
            .collect()),
        Value::String(id) => match provider {
            Some(provider) => Ok([(provider.to_string(), id.clone())].into_iter().collect()),
            None => Err(anyhow::anyhow!(
                "Cannot convert string fileId to provider reference without a provider ID. Use a Record<string, string> fileId or switch to the file-reference type."
            )),
        },
        _ => Err(anyhow::anyhow!("Invalid fileId")),
    }
}

fn deprecated(setting: &str, message: String) -> Warning {
    Warning::Deprecated {
        setting: setting.to_string(),
        message,
    }
}

/// `mapToolResultOutput`: a tool result's content with the deprecated item types
/// converted to `file`.
pub fn map_tool_result_output(
    output: &ToolResultOutput,
    provider: Option<&str>,
    warnings: &mut Vec<Warning>,
    downloaded: &HashMap<String, DownloadedAsset>,
) -> anyhow::Result<ToolResultOutput> {
    let ToolResultOutput::Content { value } = output else {
        return Ok(output.clone());
    };
    let mut items = Vec::with_capacity(value.len());
    for item in value {
        let converted = match item {
            ToolResultContentPart::File {
                filename,
                data,
                media_type,
                provider_options,
            } => {
                let part = FilePart {
                    data: FilePartData::Tagged(data.clone()),
                    filename: filename.clone(),
                    media_type: media_type.clone(),
                    provider_options: provider_options.clone(),
                };
                match convert_file_part(&part, downloaded)? {
                    LanguageModelV4Part::File {
                        filename,
                        data,
                        media_type,
                        provider_options,
                    } => ToolResultContentPart::File {
                        filename,
                        data,
                        media_type,
                        provider_options,
                    },
                    _ => {
                        return Err(anyhow::anyhow!(
                            "Expected tool result file content to convert to file."
                        ));
                    }
                }
            }
            ToolResultContentPart::FileData {
                data,
                media_type,
                filename,
                provider_options,
            } => {
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"file-data\"",
                    "The \"file-data\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'data', data } instead.".to_string(),
                ));
                ToolResultContentPart::File {
                    filename: filename.clone(),
                    data: FileData::Data {
                        data: DataContent::Base64(data.clone()),
                    },
                    media_type: media_type.clone(),
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::FileUrl {
                url,
                media_type,
                provider_options,
            } => {
                let resolved = media_type
                    .clone()
                    .unwrap_or_else(|| media_type_from_url(url));
                let parsed = url::Url::parse(url)
                    .map_err(|e| anyhow::anyhow!("TypeError: Invalid URL: {e}"))?;
                let mut message = "The \"file-url\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'url', url } instead.".to_string();
                if media_type.is_none() {
                    let suffix = if resolved == "application/octet-stream" {
                        "Unable to infer media type from URL. Defaulting to 'application/octet-stream'.".to_string()
                    } else {
                        format!("Inferred media type '{resolved}' from URL.")
                    };
                    message = format!(
                        "The \"file-url\" tool result content part with URL \"{url}\" is missing a \"mediaType\". {suffix} {message}"
                    );
                }
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"file-url\"",
                    message,
                ));
                let href = parsed.as_str().to_string();
                let original_url = if href != *url {
                    Some(url.clone())
                } else {
                    None
                };
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Url {
                        url: href,
                        original_url,
                    },
                    media_type: resolved,
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::FileId {
                file_id,
                provider_options,
            } => {
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"file-id\"",
                    "The \"file-id\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'reference', reference } instead.".to_string(),
                ));
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Reference {
                        reference: file_id_reference(file_id, provider)?,
                    },
                    media_type: "application".to_string(),
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::FileReference {
                provider_reference,
                provider_options,
            } => {
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"file-reference\"",
                    "The \"file-reference\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'reference', reference } instead.".to_string(),
                ));
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Reference {
                        reference: provider_reference.clone(),
                    },
                    media_type: "application".to_string(),
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::ImageData {
                data,
                media_type,
                provider_options,
            } => {
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"image-data\"",
                    "The \"image-data\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'data', data } instead.".to_string(),
                ));
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Data {
                        data: DataContent::Base64(data.clone()),
                    },
                    media_type: media_type.clone(),
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::ImageUrl {
                url,
                provider_options,
            } => {
                let parsed = url::Url::parse(url)
                    .map_err(|e| anyhow::anyhow!("TypeError: Invalid URL: {e}"))?;
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"image-url\"",
                    "The \"image-url\" type for tool result content is deprecated. Use the \"file\" type with mediaType 'image' (or a specific image/* subtype) and { type: 'url', url } instead.".to_string(),
                ));
                let href = parsed.as_str().to_string();
                let original_url = if href != *url {
                    Some(url.clone())
                } else {
                    None
                };
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Url {
                        url: href,
                        original_url,
                    },
                    media_type: "image".to_string(),
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::ImageFileId {
                file_id,
                provider_options,
            } => {
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"image-file-id\"",
                    "The \"image-file-id\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'reference', reference } instead.".to_string(),
                ));
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Reference {
                        reference: file_id_reference(file_id, provider)?,
                    },
                    media_type: "image".to_string(),
                    provider_options: provider_options.clone(),
                }
            }
            ToolResultContentPart::ImageFileReference {
                provider_reference,
                provider_options,
            } => {
                warnings.push(deprecated(
                    "\"tool-result\" content of type \"image-file-reference\"",
                    "The \"image-file-reference\" type for tool result content is deprecated. Use the \"file\" type with mediaType and { type: 'reference', reference } instead.".to_string(),
                ));
                ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Reference {
                        reference: provider_reference.clone(),
                    },
                    media_type: "image".to_string(),
                    provider_options: provider_options.clone(),
                }
            }
            other => other.clone(),
        };
        items.push(converted);
    }
    Ok(ToolResultOutput::Content { value: items })
}

/// `convertToLanguageModelMessage`.
pub fn convert_to_language_model_message(
    message: &ModelMessage,
    downloaded: &HashMap<String, DownloadedAsset>,
    provider: Option<&str>,
) -> anyhow::Result<LanguageModelV4Message> {
    let mut warnings: Vec<Warning> = Vec::new();
    let converted = match message {
        ModelMessage::System(m) => LanguageModelV4Message::System {
            content: m.content.clone(),
            provider_options: m.provider_options.clone(),
        },
        ModelMessage::User(m) => match &m.content {
            UserContent::Text(text) => LanguageModelV4Message::User {
                content: vec![LanguageModelV4Part::Text {
                    text: text.clone(),
                    provider_options: None,
                }],
                provider_options: m.provider_options.clone(),
            },
            UserContent::Parts(parts) => {
                let mut content = Vec::new();
                for part in parts {
                    let converted = match part {
                        UserContentPart::Text(text) => convert_text_part(text),
                        UserContentPart::Image(image) => {
                            warnings.push(deprecated(
                                "\"image\" content part",
                                "The \"image\" content part type is deprecated. Use a \"file\" part with mediaType: 'image' (or a more specific image/* subtype) instead.".to_string(),
                            ));
                            convert_file_part(&image_to_file(image), downloaded)?
                        }
                        UserContentPart::File(file) => convert_file_part(file, downloaded)?,
                    };
                    if matches!(&converted, LanguageModelV4Part::Text { text, .. } if text.is_empty())
                    {
                        continue;
                    }
                    content.push(converted);
                }
                LanguageModelV4Message::User {
                    content,
                    provider_options: m.provider_options.clone(),
                }
            }
        },
        ModelMessage::Assistant(m) => match &m.content {
            AssistantContent::Text(text) => LanguageModelV4Message::Assistant {
                content: vec![LanguageModelV4Part::Text {
                    text: text.clone(),
                    provider_options: None,
                }],
                provider_options: m.provider_options.clone(),
            },
            AssistantContent::Parts(parts) => {
                let mut content = Vec::new();
                for part in parts {
                    let converted = match part {
                        AssistantContentPart::Text(text) => {
                            if text.text.is_empty() && text.provider_options.is_none() {
                                continue;
                            }
                            convert_text_part(text)
                        }
                        AssistantContentPart::ToolApprovalRequest(_) => continue,
                        AssistantContentPart::Custom(custom) => LanguageModelV4Part::Custom {
                            kind: custom.kind.clone(),
                            provider_options: custom.provider_options.clone(),
                        },
                        AssistantContentPart::File(file) => {
                            let (data, media_type) = convert_file_part_data(&file.data)?;
                            LanguageModelV4Part::File {
                                filename: file.filename.clone(),
                                data,
                                media_type: media_type.unwrap_or_else(|| file.media_type.clone()),
                                provider_options: file.provider_options.clone(),
                            }
                        }
                        AssistantContentPart::Reasoning(reasoning) => {
                            LanguageModelV4Part::Reasoning {
                                text: reasoning.text.clone(),
                                provider_options: reasoning.provider_options.clone(),
                            }
                        }
                        AssistantContentPart::ReasoningFile(file) => {
                            let (data, media_type) = convert_file_part_data(&file.data)?;
                            if !matches!(data, FileData::Data { .. } | FileData::Url { .. }) {
                                let kind = match data {
                                    FileData::Reference { .. } => "reference",
                                    _ => "text",
                                };
                                return Err(anyhow::anyhow!(
                                    "Unsupported reasoning-file data type: {kind}"
                                ));
                            }
                            LanguageModelV4Part::ReasoningFile {
                                data,
                                media_type: media_type.unwrap_or_else(|| file.media_type.clone()),
                                provider_options: file.provider_options.clone(),
                            }
                        }
                        AssistantContentPart::ToolCall(call) => LanguageModelV4Part::ToolCall {
                            tool_call_id: call.tool_call_id.clone(),
                            tool_name: call.tool_name.clone(),
                            input: call.input.clone(),
                            provider_executed: call.provider_executed,
                            provider_options: call.provider_options.clone(),
                        },
                        AssistantContentPart::ToolResult(result) => {
                            LanguageModelV4Part::ToolResult {
                                tool_call_id: result.tool_call_id.clone(),
                                tool_name: result.tool_name.clone(),
                                output: map_tool_result_output(
                                    &result.output,
                                    provider,
                                    &mut warnings,
                                    downloaded,
                                )?,
                                provider_options: result.provider_options.clone(),
                            }
                        }
                    };
                    content.push(converted);
                }
                LanguageModelV4Message::Assistant {
                    content,
                    provider_options: m.provider_options.clone(),
                }
            }
        },
        ModelMessage::Tool(m) => {
            let mut content = Vec::new();
            for part in &m.content {
                match part {
                    ToolContentPart::ToolResult(result) => {
                        content.push(LanguageModelV4Part::ToolResult {
                            tool_call_id: result.tool_call_id.clone(),
                            tool_name: result.tool_name.clone(),
                            output: map_tool_result_output(
                                &result.output,
                                provider,
                                &mut warnings,
                                downloaded,
                            )?,
                            provider_options: result.provider_options.clone(),
                        })
                    }
                    ToolContentPart::ToolApprovalResponse(response) => {
                        if response.provider_executed != Some(true) {
                            continue;
                        }
                        content.push(LanguageModelV4Part::ToolApprovalResponse {
                            approval_id: response.approval_id.clone(),
                            approved: response.approved,
                            reason: response.reason.clone(),
                            provider_options: None,
                        });
                    }
                }
            }
            LanguageModelV4Message::Tool {
                content,
                provider_options: m.provider_options.clone(),
            }
        }
    };
    if !warnings.is_empty() {
        log_warnings(&warnings, None, None);
    }
    Ok(converted)
}

/// The file parts whose bytes are at a URL, with whether the model reads that URL.
fn planned_downloads(
    messages: &[ModelMessage],
    supported_urls: &SupportedUrls,
) -> Vec<(String, bool)> {
    let mut files: Vec<(FilePartData, Option<String>)> = Vec::new();
    for message in messages {
        match message {
            ModelMessage::User(m) => {
                if let UserContent::Parts(parts) = &m.content {
                    for part in parts {
                        match part {
                            UserContentPart::Image(image) => {
                                let file = image_to_file(image);
                                files.push((file.data, Some(file.media_type)));
                            }
                            UserContentPart::File(file) => {
                                files.push((file.data.clone(), Some(file.media_type.clone())))
                            }
                            UserContentPart::Text(_) => {}
                        }
                    }
                }
            }
            ModelMessage::Tool(m) => {
                for part in &m.content {
                    if let ToolContentPart::ToolResult(result) = part {
                        collect_output_files(&result.output, &mut files);
                    }
                }
            }
            ModelMessage::Assistant(m) => {
                if let AssistantContent::Parts(parts) = &m.content {
                    for part in parts {
                        if let AssistantContentPart::ToolResult(result) = part {
                            collect_output_files(&result.output, &mut files);
                        }
                    }
                }
            }
            ModelMessage::System(_) => {}
        }
    }
    files
        .into_iter()
        .filter_map(|(data, media_type)| {
            let (data, _) = convert_file_part_data(&data).ok()?;
            match data {
                FileData::Url { url, .. } => {
                    let supported = media_type
                        .as_deref()
                        .is_some_and(|m| is_url_supported(&url, m, supported_urls));
                    Some((url, supported))
                }
                _ => None,
            }
        })
        .collect()
}

fn collect_output_files(
    output: &ToolResultOutput,
    files: &mut Vec<(FilePartData, Option<String>)>,
) {
    if let ToolResultOutput::Content { value } = output {
        for item in value {
            if let ToolResultContentPart::File {
                data, media_type, ..
            } = item
            {
                files.push((FilePartData::Tagged(data.clone()), Some(media_type.clone())));
            }
        }
    }
}

/// `download`: the bytes at a URL and the media type its server names.
pub async fn download(
    url: &str,
    abort: Option<&CancellationToken>,
) -> anyhow::Result<DownloadedAsset> {
    let parsed =
        url::Url::parse(url).map_err(|e| DownloadError::from_cause(url, anyhow::anyhow!("{e}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(DownloadError::from_cause(
            url,
            anyhow::anyhow!("URL scheme must be http or https"),
        )
        .into());
    }
    let request = async {
        let client = reqwest::Client::new();
        let response = client
            .get(parsed.clone())
            .header("user-agent", format!("ai-sdk/{}", super::VERSION))
            .send()
            .await
            .map_err(|e| {
                anyhow::Error::from(DownloadError::from_cause(url, anyhow::Error::new(e)))
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(DownloadError::from_status(
                url,
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
            )
            .into());
        }
        let media_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let data = response.bytes().await.map_err(|e| {
            anyhow::Error::from(DownloadError::from_cause(url, anyhow::Error::new(e)))
        })?;
        Ok(DownloadedAsset { data, media_type })
    };
    match abort {
        Some(token) => tokio::select! {
            result = request => result,
            _ = token.cancelled() => Err(AbortError::operation().into()),
        },
        None => request.await,
    }
}

async fn download_assets(
    messages: &[ModelMessage],
    supported_urls: &SupportedUrls,
    abort: Option<&CancellationToken>,
) -> anyhow::Result<HashMap<String, DownloadedAsset>> {
    let planned = planned_downloads(messages, supported_urls);
    let results = futures::future::join_all(planned.iter().map(|(url, supported)| async move {
        if *supported {
            Ok(None)
        } else {
            download(url, abort).await.map(Some)
        }
    }))
    .await;
    let mut assets = HashMap::new();
    for ((url, _), result) in planned.into_iter().zip(results) {
        if let Some(asset) = result? {
            assets.insert(url, asset);
        }
    }
    Ok(assets)
}

/// `convertToLanguageModelPrompt`: the prompt a provider receives. Files at URLs the
/// model does not read are downloaded, consecutive tool messages are joined, and a
/// tool call without a result before the next user or system message is refused.
pub async fn convert_to_language_model_prompt(
    prompt: &StandardizedPrompt,
    supported_urls: &SupportedUrls,
    abort: Option<&CancellationToken>,
    provider: Option<&str>,
) -> anyhow::Result<LanguageModelV4Prompt> {
    let downloaded = download_assets(&prompt.messages, supported_urls, abort).await?;

    let mut approval_to_call: HashMap<String, String> = HashMap::new();
    for message in &prompt.messages {
        if let ModelMessage::Assistant(m) = message {
            if let AssistantContent::Parts(parts) = &m.content {
                for part in parts {
                    if let AssistantContentPart::ToolApprovalRequest(request) = part {
                        approval_to_call
                            .insert(request.approval_id.clone(), request.tool_call_id.clone());
                    }
                }
            }
        }
    }
    let mut approved_call_ids: HashSet<String> = HashSet::new();
    for message in &prompt.messages {
        if let ModelMessage::Tool(m) = message {
            for part in &m.content {
                if let ToolContentPart::ToolApprovalResponse(response) = part {
                    if let Some(call_id) = approval_to_call.get(&response.approval_id) {
                        approved_call_ids.insert(call_id.clone());
                    }
                }
            }
        }
    }

    let mut messages: Vec<LanguageModelV4Message> = prompt
        .instructions
        .as_ref()
        .map(Instructions::to_system_messages)
        .unwrap_or_default();
    for message in &prompt.messages {
        messages.push(convert_to_language_model_message(
            message,
            &downloaded,
            provider,
        )?);
    }

    let mut combined: Vec<LanguageModelV4Message> = Vec::new();
    for message in messages {
        let LanguageModelV4Message::Tool {
            content,
            provider_options,
        } = message
        else {
            combined.push(message);
            continue;
        };
        match combined.last_mut() {
            Some(LanguageModelV4Message::Tool {
                content: last_content,
                provider_options: last_options,
            }) => {
                let has_last_part = !last_content.is_empty();
                if let (Some(last_part), Some(options)) =
                    (last_content.last_mut(), last_options.as_ref())
                {
                    let merged = merge_objects(Some(options), last_part.provider_options());
                    *last_part.provider_options_mut() = merged;
                }
                last_content.extend(content);
                *last_options = if has_last_part {
                    provider_options
                } else {
                    merge_objects(last_options.as_ref(), provider_options.as_ref())
                };
            }
            _ => combined.push(LanguageModelV4Message::Tool {
                content,
                provider_options,
            }),
        }
    }

    let mut open_calls: Vec<String> = Vec::new();
    let close = |open: &mut Vec<String>, id: &str| open.retain(|o| o != id);
    for message in &combined {
        match message {
            LanguageModelV4Message::Assistant { content, .. } => {
                for part in content {
                    if let LanguageModelV4Part::ToolCall {
                        tool_call_id,
                        provider_executed,
                        ..
                    } = part
                    {
                        if *provider_executed != Some(true) && !open_calls.contains(tool_call_id) {
                            open_calls.push(tool_call_id.clone());
                        }
                    }
                }
            }
            LanguageModelV4Message::Tool { content, .. } => {
                for part in content {
                    if let LanguageModelV4Part::ToolResult { tool_call_id, .. } = part {
                        close(&mut open_calls, tool_call_id);
                    }
                }
            }
            LanguageModelV4Message::User { .. } | LanguageModelV4Message::System { .. } => {
                open_calls.retain(|id| !approved_call_ids.contains(id));
                if !open_calls.is_empty() {
                    return Err(MissingToolResultsError::new(open_calls).into());
                }
            }
        }
    }
    open_calls.retain(|id| !approved_call_ids.contains(id));
    if !open_calls.is_empty() {
        return Err(MissingToolResultsError::new(open_calls).into());
    }

    Ok(combined
        .into_iter()
        .filter(
            |m| !matches!(m, LanguageModelV4Message::Tool { content, .. } if content.is_empty()),
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::json::js_stringify;
    use crate::ai::messages::{ToolCallPart, ToolResultPart};
    use serde_json::json;

    fn options(value: Value) -> Option<ProviderOptions> {
        value.as_object().cloned()
    }

    async fn convert(
        instructions: Option<Instructions>,
        messages: Vec<ModelMessage>,
    ) -> anyhow::Result<Value> {
        let prompt = standardize_prompt(instructions, None, Some(messages), true)?;
        let converted = convert_to_language_model_prompt(
            &prompt,
            &SupportedUrls::new(),
            None,
            Some("anthropic"),
        )
        .await?;
        Ok(serde_json::to_value(converted)?)
    }

    #[tokio::test]
    async fn converts_text_messages_and_system_instructions() {
        let system = Instructions::Messages(vec![SystemModelMessage {
            content: "sys".into(),
            provider_options: options(
                json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } }),
            ),
        }]);
        let out = convert(
            Some(system),
            vec![ModelMessage::user("hi"), ModelMessage::assistant("yo")],
        )
        .await
        .unwrap();
        assert_eq!(
            js_stringify(&out),
            r#"[{"role":"system","content":"sys","providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}},{"role":"user","content":[{"type":"text","text":"hi"}]},{"role":"assistant","content":[{"type":"text","text":"yo"}]}]"#
        );
    }

    #[tokio::test]
    async fn drops_empty_text_parts_and_detects_image_types() {
        let png = vec![0x89u8, 0x50, 0x4e, 0x47, 0, 0, 0, 0];
        let message = ModelMessage::user_parts(vec![
            UserContentPart::Text(TextPart::new("")),
            UserContentPart::File(FilePart {
                data: FilePartData::from(png),
                filename: Some("a.jpg".into()),
                media_type: "image/jpeg".into(),
                provider_options: None,
            }),
        ]);
        let out = convert(None, vec![message]).await.unwrap();
        assert_eq!(
            js_stringify(&out),
            r#"[{"role":"user","content":[{"type":"file","filename":"a.jpg","data":{"type":"data","data":"iVBORwAAAAA="},"mediaType":"image/png"}]}]"#
        );
    }

    #[tokio::test]
    async fn reads_a_data_url_and_converts_legacy_image_data_results() {
        let message = ModelMessage::user_parts(vec![UserContentPart::File(FilePart {
            data: FilePartData::from("data:application/pdf;base64,JVBERg=="),
            filename: None,
            media_type: "application/octet-stream".into(),
            provider_options: None,
        })]);
        let call =
            ModelMessage::assistant_parts(vec![AssistantContentPart::ToolCall(ToolCallPart {
                tool_call_id: "c1".into(),
                tool_name: "shot".into(),
                input: json!({}),
                provider_executed: None,
                provider_options: None,
            })]);
        let result = ModelMessage::tool(vec![ToolContentPart::ToolResult(ToolResultPart {
            tool_call_id: "c1".into(),
            tool_name: "shot".into(),
            output: ToolResultOutput::Content {
                value: vec![ToolResultContentPart::ImageData {
                    data: "AAAA".into(),
                    media_type: "image/png".into(),
                    provider_options: None,
                }],
            },
            provider_options: None,
        })]);
        let out = convert(None, vec![message, call, result]).await.unwrap();
        assert_eq!(
            out[0]["content"][0]["data"],
            json!({ "type": "data", "data": "JVBERg==" })
        );
        assert_eq!(out[0]["content"][0]["mediaType"], "application/pdf");
        assert_eq!(
            out[2]["content"][0]["output"],
            json!({ "type": "content", "value": [{ "type": "file", "data": { "type": "data", "data": "AAAA" }, "mediaType": "image/png" }] })
        );
    }

    #[tokio::test]
    async fn joins_consecutive_tool_messages_and_carries_their_options() {
        let call = ModelMessage::assistant_parts(vec![
            AssistantContentPart::ToolCall(ToolCallPart {
                tool_call_id: "a".into(),
                tool_name: "t".into(),
                input: json!({}),
                provider_executed: None,
                provider_options: None,
            }),
            AssistantContentPart::ToolCall(ToolCallPart {
                tool_call_id: "b".into(),
                tool_name: "t".into(),
                input: json!({}),
                provider_executed: None,
                provider_options: None,
            }),
        ]);
        let result = |id: &str, opts: Option<ProviderOptions>| {
            ModelMessage::Tool(crate::ai::messages::ToolModelMessage {
                content: vec![ToolContentPart::ToolResult(ToolResultPart {
                    tool_call_id: id.into(),
                    tool_name: "t".into(),
                    output: ToolResultOutput::text("ok"),
                    provider_options: None,
                })],
                provider_options: opts,
            })
        };
        let out = convert(
            None,
            vec![
                ModelMessage::user("go"),
                call,
                result("a", options(json!({ "p": { "x": 1 } }))),
                result("b", options(json!({ "p": { "y": 2 } }))),
            ],
        )
        .await
        .unwrap();
        assert_eq!(out.as_array().unwrap().len(), 3);
        assert_eq!(
            out[2]["content"][0]["providerOptions"],
            json!({ "p": { "x": 1 } })
        );
        assert_eq!(out[2]["providerOptions"], json!({ "p": { "y": 2 } }));
    }

    #[tokio::test]
    async fn refuses_a_tool_call_without_a_result() {
        let call =
            ModelMessage::assistant_parts(vec![AssistantContentPart::ToolCall(ToolCallPart {
                tool_call_id: "a".into(),
                tool_name: "t".into(),
                input: json!({}),
                provider_executed: None,
                provider_options: None,
            })]);
        let err = convert(
            None,
            vec![ModelMessage::user("go"), call, ModelMessage::user("again")],
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "Tool result is missing for tool call a.");
    }

    #[test]
    fn refuses_system_messages_unless_allowed() {
        let err = standardize_prompt(None, None, Some(vec![ModelMessage::system("s")]), false)
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Invalid prompt: System messages are not allowed in the prompt or messages fields. Use the instructions option instead."
        );
        assert!(standardize_prompt(None, None, Some(vec![]), false).is_err());
    }

    #[test]
    fn matches_supported_urls_by_media_type() {
        let mut supported = SupportedUrls::new();
        supported.insert(
            "image/*".into(),
            vec![regex::Regex::new("^https://").unwrap()],
        );
        assert!(is_url_supported("https://x/y.png", "image/png", &supported));
        assert!(is_url_supported("https://x/y.png", "image", &supported));
        assert!(!is_url_supported(
            "https://x/y.pdf",
            "application/pdf",
            &supported
        ));
    }
}
