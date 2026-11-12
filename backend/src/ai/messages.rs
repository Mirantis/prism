//! The messages a caller writes (`ModelMessage`) and their content parts.

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

pub use super::provider::{
    DataContent, FileData, ProviderOptions, ProviderReference, ToolResultOutput,
};

/// A system message: instructions from the operator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemModelMessage {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

impl SystemModelMessage {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            provider_options: None,
        }
    }
}

/// A user message: text, or parts of text, images and files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserModelMessage {
    pub content: UserContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// An assistant message: what the model said and the tools it called.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantModelMessage {
    pub content: AssistantContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// A tool message: the results of tool calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolModelMessage {
    pub content: ToolContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// A message of a prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum ModelMessage {
    #[serde(rename = "system")]
    System(SystemModelMessage),
    #[serde(rename = "user")]
    User(UserModelMessage),
    #[serde(rename = "assistant")]
    Assistant(AssistantModelMessage),
    #[serde(rename = "tool")]
    Tool(ToolModelMessage),
}

/// A message the model's response adds: an assistant or a tool message.
pub type ResponseMessage = ModelMessage;

impl ModelMessage {
    /// `{ role: 'system', content }`.
    pub fn system(content: impl Into<String>) -> Self {
        Self::System(SystemModelMessage::new(content))
    }

    /// `{ role: 'user', content }` with text content.
    pub fn user(content: impl Into<String>) -> Self {
        Self::User(UserModelMessage {
            content: UserContent::Text(content.into()),
            provider_options: None,
        })
    }

    /// `{ role: 'user', content: [...] }`.
    pub fn user_parts(parts: Vec<UserContentPart>) -> Self {
        Self::User(UserModelMessage {
            content: UserContent::Parts(parts),
            provider_options: None,
        })
    }

    /// `{ role: 'assistant', content }` with text content.
    pub fn assistant(content: impl Into<String>) -> Self {
        Self::Assistant(AssistantModelMessage {
            content: AssistantContent::Text(content.into()),
            provider_options: None,
        })
    }

    /// `{ role: 'assistant', content: [...] }`.
    pub fn assistant_parts(parts: Vec<AssistantContentPart>) -> Self {
        Self::Assistant(AssistantModelMessage {
            content: AssistantContent::Parts(parts),
            provider_options: None,
        })
    }

    /// `{ role: 'tool', content: [...] }`.
    pub fn tool(parts: Vec<ToolContentPart>) -> Self {
        Self::Tool(ToolModelMessage {
            content: parts,
            provider_options: None,
        })
    }

    pub fn role(&self) -> &'static str {
        match self {
            Self::System(_) => "system",
            Self::User(_) => "user",
            Self::Assistant(_) => "assistant",
            Self::Tool(_) => "tool",
        }
    }

    pub fn provider_options(&self) -> Option<&ProviderOptions> {
        match self {
            Self::System(m) => m.provider_options.as_ref(),
            Self::User(m) => m.provider_options.as_ref(),
            Self::Assistant(m) => m.provider_options.as_ref(),
            Self::Tool(m) => m.provider_options.as_ref(),
        }
    }

    pub fn provider_options_mut(&mut self) -> &mut Option<ProviderOptions> {
        match self {
            Self::System(m) => &mut m.provider_options,
            Self::User(m) => &mut m.provider_options,
            Self::Assistant(m) => &mut m.provider_options,
            Self::Tool(m) => &mut m.provider_options,
        }
    }
}

impl From<SystemModelMessage> for ModelMessage {
    fn from(m: SystemModelMessage) -> Self {
        Self::System(m)
    }
}

impl From<UserModelMessage> for ModelMessage {
    fn from(m: UserModelMessage) -> Self {
        Self::User(m)
    }
}

impl From<AssistantModelMessage> for ModelMessage {
    fn from(m: AssistantModelMessage) -> Self {
        Self::Assistant(m)
    }
}

impl From<ToolModelMessage> for ModelMessage {
    fn from(m: ToolModelMessage) -> Self {
        Self::Tool(m)
    }
}

/// The content of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Parts(Vec<UserContentPart>),
}

/// A part of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum UserContentPart {
    #[serde(rename = "text")]
    Text(TextPart),
    #[serde(rename = "image")]
    Image(ImagePart),
    #[serde(rename = "file")]
    File(FilePart),
}

/// The content of an assistant message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AssistantContent {
    Text(String),
    Parts(Vec<AssistantContentPart>),
}

/// A part of an assistant message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AssistantContentPart {
    #[serde(rename = "text")]
    Text(TextPart),
    #[serde(rename = "custom")]
    Custom(CustomPart),
    #[serde(rename = "file")]
    File(FilePart),
    #[serde(rename = "reasoning")]
    Reasoning(ReasoningPart),
    #[serde(rename = "reasoning-file")]
    ReasoningFile(ReasoningFilePart),
    #[serde(rename = "tool-call")]
    ToolCall(ToolCallPart),
    #[serde(rename = "tool-result")]
    ToolResult(ToolResultPart),
    #[serde(rename = "tool-approval-request")]
    ToolApprovalRequest(ToolApprovalRequest),
}

/// The content of a tool message.
pub type ToolContent = Vec<ToolContentPart>;

/// A part of a tool message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ToolContentPart {
    #[serde(rename = "tool-result")]
    ToolResult(ToolResultPart),
    #[serde(rename = "tool-approval-response")]
    ToolApprovalResponse(ToolApprovalResponse),
}

/// Text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

impl TextPart {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            provider_options: None,
        }
    }
}

/// Where a file part's bytes are: tagged data, inline data (bytes, or text that is
/// base64 unless it parses as a URL), a URL, or a provider reference.
#[derive(Debug, Clone, PartialEq)]
pub enum FilePartData {
    Tagged(FileData),
    Data(DataContent),
    Url(url::Url),
    Reference(ProviderReference),
}

impl Serialize for FilePartData {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            FilePartData::Tagged(data) => data.serialize(serializer),
            FilePartData::Data(data) => data.serialize(serializer),
            FilePartData::Url(url) => serializer.serialize_str(url.as_str()),
            FilePartData::Reference(reference) => reference.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for FilePartData {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(text) => Ok(FilePartData::Data(DataContent::Base64(text))),
            Value::Object(ref map) => match map.get("type").and_then(Value::as_str) {
                Some("data" | "url" | "reference" | "text") => serde_json::from_value(value)
                    .map(FilePartData::Tagged)
                    .map_err(serde::de::Error::custom),
                _ => serde_json::from_value::<IndexMap<String, String>>(value)
                    .map(FilePartData::Reference)
                    .map_err(serde::de::Error::custom),
            },
            other => Err(serde::de::Error::custom(format!(
                "invalid file data: {other}"
            ))),
        }
    }
}

impl From<Vec<u8>> for FilePartData {
    fn from(bytes: Vec<u8>) -> Self {
        FilePartData::Data(DataContent::from(bytes))
    }
}

impl From<bytes::Bytes> for FilePartData {
    fn from(bytes: bytes::Bytes) -> Self {
        FilePartData::Data(DataContent::Bytes(bytes))
    }
}

impl From<String> for FilePartData {
    fn from(text: String) -> Self {
        FilePartData::Data(DataContent::Base64(text))
    }
}

impl From<&str> for FilePartData {
    fn from(text: &str) -> Self {
        FilePartData::Data(DataContent::Base64(text.to_string()))
    }
}

impl From<url::Url> for FilePartData {
    fn from(url: url::Url) -> Self {
        FilePartData::Url(url)
    }
}

impl From<FileData> for FilePartData {
    fn from(data: FileData) -> Self {
        FilePartData::Tagged(data)
    }
}

/// An image. Deprecated in favor of a file part with an image media type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub image: FilePartData,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// A file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePart {
    pub data: FilePartData,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// Reasoning text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningPart {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// A file produced while reasoning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningFilePart {
    pub data: FilePartData,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// Provider-specific content with no standard payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPart {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// A tool call the model made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallPart {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// The result of a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultPart {
    pub tool_call_id: String,
    pub tool_name: String,
    pub output: ToolResultOutput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
}

/// A request to approve a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalRequest {
    pub approval_id: String,
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_automatic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema_input: Option<Value>,
}

/// The answer to a tool approval request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApprovalResponse {
    pub approval_id: String,
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
}
