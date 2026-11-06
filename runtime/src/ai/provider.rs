//! The provider specification the SDK calls models through (`@ai-sdk/provider`,
//! language model V4, embedding model V4).
//!
//! Each type serializes to the object the TypeScript SDK builds, key for key, with
//! an absent optional left out, because the E2E LLM cache hashes these objects.
//! The SDK and every provider speak version 4; the version 3 names are aliases.

use bytes::Bytes;
use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use super::json::{base64_to_bytes, bytes_to_base64, serialize_js_number_opt};

/// A JSON object.
pub type JsonObject = Map<String, Value>;

/// Provider-specific options, keyed by provider name; each value is an object.
pub type ProviderOptions = JsonObject;

/// Provider-specific metadata on a result, keyed by provider name.
pub type ProviderMetadata = JsonObject;

/// A provider's own id for an uploaded file, keyed by provider name.
pub type ProviderReference = IndexMap<String, String>;

/// HTTP headers.
pub type Headers = IndexMap<String, String>;

/// Which URLs a model reads itself, by media type pattern (`image/*`, `*`).
pub type SupportedUrls = IndexMap<String, Vec<regex::Regex>>;

/// Inline file data: base64 text or bytes. Bytes serialize as base64, as the
/// E2E cache key writes a `Uint8Array`.
#[derive(Debug, Clone, PartialEq)]
pub enum DataContent {
    Base64(String),
    Bytes(Bytes),
}

impl DataContent {
    /// The data as base64 text.
    pub fn to_base64(&self) -> String {
        match self {
            DataContent::Base64(text) => text.clone(),
            DataContent::Bytes(bytes) => bytes_to_base64(bytes),
        }
    }

    /// The data as bytes; base64 text is decoded.
    pub fn to_bytes(&self) -> Result<Bytes, String> {
        match self {
            DataContent::Base64(text) => base64_to_bytes(text).map(Bytes::from),
            DataContent::Bytes(bytes) => Ok(bytes.clone()),
        }
    }
}

impl Serialize for DataContent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            DataContent::Base64(text) => serializer.serialize_str(text),
            DataContent::Bytes(bytes) => serializer.serialize_str(&bytes_to_base64(bytes)),
        }
    }
}

impl<'de> Deserialize<'de> for DataContent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(DataContent::Base64(String::deserialize(deserializer)?))
    }
}

impl From<Vec<u8>> for DataContent {
    fn from(bytes: Vec<u8>) -> Self {
        DataContent::Bytes(Bytes::from(bytes))
    }
}

impl From<Bytes> for DataContent {
    fn from(bytes: Bytes) -> Self {
        DataContent::Bytes(bytes)
    }
}

/// File data as a tagged union (`SharedV4FileData`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum FileData {
    /// Raw bytes or base64 text.
    Data { data: DataContent },
    /// A URL that points to the file; `url` is the URL's `href`.
    Url {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        original_url: Option<String>,
    },
    /// A provider reference.
    Reference { reference: ProviderReference },
    /// Inline text content.
    Text { text: String },
}

/// One part of a prompt message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum LanguageModelV4Part {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "file")]
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        data: FileData,
        media_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "reasoning-file")]
    ReasoningFile {
        data: FileData,
        media_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "custom")]
    Custom {
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "tool-call")]
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_executed: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "tool-result")]
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        output: ToolResultOutput,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "tool-approval-response")]
    ToolApprovalResponse {
        approval_id: String,
        approved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
}

impl LanguageModelV4Part {
    pub fn provider_options(&self) -> Option<&ProviderOptions> {
        match self {
            Self::Text {
                provider_options, ..
            }
            | Self::File {
                provider_options, ..
            }
            | Self::Reasoning {
                provider_options, ..
            }
            | Self::ReasoningFile {
                provider_options, ..
            }
            | Self::Custom {
                provider_options, ..
            }
            | Self::ToolCall {
                provider_options, ..
            }
            | Self::ToolResult {
                provider_options, ..
            }
            | Self::ToolApprovalResponse {
                provider_options, ..
            } => provider_options.as_ref(),
        }
    }

    pub fn provider_options_mut(&mut self) -> &mut Option<ProviderOptions> {
        match self {
            Self::Text {
                provider_options, ..
            }
            | Self::File {
                provider_options, ..
            }
            | Self::Reasoning {
                provider_options, ..
            }
            | Self::ReasoningFile {
                provider_options, ..
            }
            | Self::Custom {
                provider_options, ..
            }
            | Self::ToolCall {
                provider_options, ..
            }
            | Self::ToolResult {
                provider_options, ..
            }
            | Self::ToolApprovalResponse {
                provider_options, ..
            } => provider_options,
        }
    }
}

/// One message of a prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "role",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum LanguageModelV4Message {
    System {
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    User {
        content: Vec<LanguageModelV4Part>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    Assistant {
        content: Vec<LanguageModelV4Part>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    Tool {
        content: Vec<LanguageModelV4Part>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
}

impl LanguageModelV4Message {
    pub fn role(&self) -> &'static str {
        match self {
            Self::System { .. } => "system",
            Self::User { .. } => "user",
            Self::Assistant { .. } => "assistant",
            Self::Tool { .. } => "tool",
        }
    }

    pub fn provider_options(&self) -> Option<&ProviderOptions> {
        match self {
            Self::System {
                provider_options, ..
            }
            | Self::User {
                provider_options, ..
            }
            | Self::Assistant {
                provider_options, ..
            }
            | Self::Tool {
                provider_options, ..
            } => provider_options.as_ref(),
        }
    }

    pub fn provider_options_mut(&mut self) -> &mut Option<ProviderOptions> {
        match self {
            Self::System {
                provider_options, ..
            }
            | Self::User {
                provider_options, ..
            }
            | Self::Assistant {
                provider_options, ..
            }
            | Self::Tool {
                provider_options, ..
            } => provider_options,
        }
    }

    /// The parts of a user, assistant or tool message; a system message has none.
    pub fn parts(&self) -> Option<&Vec<LanguageModelV4Part>> {
        match self {
            Self::System { .. } => None,
            Self::User { content, .. }
            | Self::Assistant { content, .. }
            | Self::Tool { content, .. } => Some(content),
        }
    }

    pub fn parts_mut(&mut self) -> Option<&mut Vec<LanguageModelV4Part>> {
        match self {
            Self::System { .. } => None,
            Self::User { content, .. }
            | Self::Assistant { content, .. }
            | Self::Tool { content, .. } => Some(content),
        }
    }
}

/// A prompt: the messages a model reads.
pub type LanguageModelV4Prompt = Vec<LanguageModelV4Message>;

/// The result of a tool call as the model reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ToolResultOutput {
    #[serde(rename = "text")]
    Text {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "json")]
    Json {
        value: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "execution-denied")]
    ExecutionDenied {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "error-text")]
    ErrorText {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "error-json")]
    ErrorJson {
        value: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "content")]
    Content { value: Vec<ToolResultContentPart> },
}

impl ToolResultOutput {
    /// `{ type: 'text', value }`.
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text {
            value: value.into(),
            provider_options: None,
        }
    }

    /// `{ type: 'json', value }`.
    pub fn json(value: Value) -> Self {
        Self::Json {
            value,
            provider_options: None,
        }
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Json { .. } => "json",
            Self::ExecutionDenied { .. } => "execution-denied",
            Self::ErrorText { .. } => "error-text",
            Self::ErrorJson { .. } => "error-json",
            Self::Content { .. } => "content",
        }
    }
}

/// One item of a `content` tool result. The `file-*` and `image-*` items are the
/// deprecated forms the SDK converts to `file` before a provider sees them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ToolResultContentPart {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "file")]
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        data: FileData,
        media_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "file-data")]
    FileData {
        data: String,
        media_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "file-url")]
    FileUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "file-id")]
    FileId {
        file_id: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "file-reference")]
    FileReference {
        provider_reference: ProviderReference,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "image-data")]
    ImageData {
        data: String,
        media_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "image-url")]
    ImageUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "image-file-id")]
    ImageFileId {
        file_id: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "image-file-reference")]
    ImageFileReference {
        provider_reference: ProviderReference,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
    #[serde(rename = "custom")]
    Custom {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_options: Option<ProviderOptions>,
    },
}

/// An example input of a function tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInputExample {
    pub input: Value,
}

/// A tool the model may call, defined by its JSON Schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4FunctionTool {
    pub name: String,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_examples: Option<Vec<ToolInputExample>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
}

/// A tool the provider defines (`openai.tool_search`, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LanguageModelV4ProviderTool {
    pub name: String,
    pub id: String,
    pub args: JsonObject,
}

/// A tool as the provider receives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LanguageModelV4Tool {
    #[serde(rename = "function")]
    Function(LanguageModelV4FunctionTool),
    #[serde(rename = "provider")]
    Provider(LanguageModelV4ProviderTool),
}

impl LanguageModelV4Tool {
    pub fn name(&self) -> &str {
        match self {
            Self::Function(tool) => &tool.name,
            Self::Provider(tool) => &tool.name,
        }
    }
}

/// How the model may choose tools.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LanguageModelV4ToolChoice {
    Auto,
    None,
    Required,
    Tool {
        #[serde(rename = "toolName")]
        tool_name: String,
    },
}

/// The form of the answer: text, or JSON matching a schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LanguageModelV4ResponseFormat {
    Text,
    Json {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schema: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

/// How hard the model reasons before it answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningEffort {
    ProviderDefault,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// The options of one model call.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4CallOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_js_number_opt"
    )]
    pub temperature: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_js_number_opt"
    )]
    pub top_p: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_js_number_opt"
    )]
    pub top_k: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_js_number_opt"
    )]
    pub presence_penalty: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_js_number_opt"
    )]
    pub frequency_penalty: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<LanguageModelV4Tool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<LanguageModelV4ToolChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_format: Option<LanguageModelV4ResponseFormat>,
    pub prompt: LanguageModelV4Prompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_raw_chunks: Option<bool>,
    /// The call's cancellation. Never serialized.
    #[serde(skip)]
    pub abort_signal: Option<CancellationToken>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Headers>,
}

/// Why the model stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    Stop,
    Length,
    ContentFilter,
    ToolCalls,
    Error,
    Other,
}

impl FinishReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Length => "length",
            Self::ContentFilter => "content-filter",
            Self::ToolCalls => "tool-calls",
            Self::Error => "error",
            Self::Other => "other",
        }
    }
}

/// The unified finish reason and the provider's own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageModelV4FinishReason {
    pub unified: FinishReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// Input token counts of one call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4InputTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_cache: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<i64>,
}

/// Output token counts of one call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4OutputTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<i64>,
}

/// The token usage a provider reports.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4Usage {
    pub input_tokens: LanguageModelV4InputTokens,
    pub output_tokens: LanguageModelV4OutputTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<JsonObject>,
}

/// A source the model cited.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "sourceType",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum LanguageModelV4Source {
    Url {
        id: String,
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    Document {
        id: String,
        media_type: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
}

/// One part of what a model generated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum LanguageModelV4Content {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "custom")]
    Custom {
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "reasoning-file")]
    ReasoningFile {
        media_type: String,
        data: FileData,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "file")]
    File {
        media_type: String,
        data: FileData,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "tool-approval-request")]
    ToolApprovalRequest {
        approval_id: String,
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "source")]
    Source(LanguageModelV4Source),
    #[serde(rename = "tool-call")]
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        /// The input as the model wrote it: JSON text.
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_executed: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamic: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "tool-result")]
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        result: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preliminary: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamic: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
}

/// A warning a provider or the SDK reports for a call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Warning {
    Unsupported {
        feature: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },
    Compatibility {
        feature: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },
    Deprecated {
        setting: String,
        message: String,
    },
    Other {
        message: String,
    },
}

/// What a provider reports about the request it sent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LanguageModelV4Request {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

/// What a provider reports about the response it got.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4Response {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::support::serde_iso::option"
    )]
    pub timestamp: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Headers>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

/// What one model call generated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelV4GenerateResult {
    pub content: Vec<LanguageModelV4Content>,
    pub finish_reason: LanguageModelV4FinishReason,
    pub usage: LanguageModelV4Usage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<ProviderMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<LanguageModelV4Request>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<LanguageModelV4Response>,
    #[serde(default)]
    pub warnings: Vec<Warning>,
}

/// The options of one embedding call.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingModelV4CallOptions {
    pub values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<i64>,
    #[serde(skip)]
    pub abort_signal: Option<CancellationToken>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<ProviderOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Headers>,
}

/// Token usage of an embedding call. A provider that reports none gives `NaN`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingModelUsage {
    pub tokens: f64,
}

/// What a provider reports about an embedding response.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingModelV4Response {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Headers>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

/// One embedding call's result.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingModelV4Result {
    pub embeddings: Vec<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<EmbeddingModelUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<ProviderMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<EmbeddingModelV4Response>,
    #[serde(default)]
    pub warnings: Vec<Warning>,
}

pub type LanguageModelV3CallOptions = LanguageModelV4CallOptions;
pub type LanguageModelV3Prompt = LanguageModelV4Prompt;
pub type LanguageModelV3Message = LanguageModelV4Message;
pub type LanguageModelV3Content = LanguageModelV4Content;
pub type LanguageModelV3GenerateResult = LanguageModelV4GenerateResult;
pub type LanguageModelV3Usage = LanguageModelV4Usage;
pub type LanguageModelV3FinishReason = LanguageModelV4FinishReason;
pub type LanguageModelV3FunctionTool = LanguageModelV4FunctionTool;
pub type LanguageModelV3ToolChoice = LanguageModelV4ToolChoice;
pub type EmbeddingModelV3CallOptions = EmbeddingModelV4CallOptions;
pub type EmbeddingModelV3Result = EmbeddingModelV4Result;
