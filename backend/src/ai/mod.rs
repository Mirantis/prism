//! The subset of the Vercel AI SDK (`ai` 7, `@ai-sdk/provider`,
//! `@ai-sdk/provider-utils`) the runtime uses: messages, tools, `generate_text`,
//! `generate_object`, `embed`, the provider interface, and the E2E LLM cache.
//! Names follow the SDK's, in snake case for functions.

#[cfg(feature = "e2e-llm-cache")]
pub mod cache;
pub mod embed;
pub mod errors;
pub mod generate_object;
pub mod generate_text;
pub mod json;
pub mod mcp;
pub mod messages;
pub mod model;
pub mod prompt;
pub mod provider;
pub mod providers;
pub mod retry;
pub mod telemetry;
pub mod tool;
pub mod usage;
pub mod warnings;
mod zod;

/// The SDK version this module follows; it ends the `user-agent` of every call.
pub const VERSION: &str = "7.0.137";

#[cfg(feature = "e2e-llm-cache")]
pub use cache::{is_llm_cache_enabled, with_llm_cache};

/// A build without the `e2e-llm-cache` feature, as every release is, has no LLM cache:
/// the model is handed out as it is.
#[cfg(not(feature = "e2e-llm-cache"))]
pub fn with_llm_cache(
    model: std::sync::Arc<dyn LanguageModel>,
) -> std::sync::Arc<dyn LanguageModel> {
    model
}

#[cfg(not(feature = "e2e-llm-cache"))]
pub fn is_llm_cache_enabled() -> bool {
    false
}
pub use embed::{
    EmbedManyOptions, EmbedManyResult, EmbedOptions, EmbedResult, Embedding, embed, embed_many,
};
pub use errors::{
    AbortError, ApiCallError, DownloadError, EmptyResponseBodyError, InvalidArgumentError,
    InvalidDataContentError, InvalidPromptError, InvalidResponseDataError, InvalidToolInputError,
    JsonParseError, LoadApiKeyError, LoadSettingError, MissingToolResultsError,
    NoObjectGeneratedError, NoSuchToolError, RetryError, RetryErrorReason, SchemaIssuesError,
    SharedError, SyntaxError, TooManyEmbeddingValuesForCallError, ToolChoiceViolationError,
    TypeValidationContext, TypeValidationError, UnsupportedFunctionalityError, error_name,
    get_error_message, is_abort_error,
};
pub use generate_object::{GenerateObjectOptions, GenerateObjectResult, generate_object};
pub use generate_text::{
    CallSettings, ContentPart, FinishReason, GenerateTextInclude, GenerateTextOptions,
    GenerateTextResult, GeneratedFile, LanguageModelRequestMetadata, LanguageModelResponseMetadata,
    OnStepFinishFunction, PrepareStepFunction, PrepareStepOptions, PrepareStepResult, StepModel,
    StepResult, StepResultPerformance, StopCondition, ToolErrorValue, ToolOutput, TypedToolCall,
    TypedToolError, TypedToolResult, generate_text, has_tool_call, is_loop_finished, step_count_is,
};
pub use messages::{
    AssistantContent, AssistantContentPart, AssistantModelMessage, CustomPart, FilePart,
    FilePartData, ImagePart, ModelMessage, ReasoningFilePart, ReasoningPart, ResponseMessage,
    SystemModelMessage, TextPart, ToolApprovalRequest, ToolApprovalResponse, ToolCallPart,
    ToolContent, ToolContentPart, ToolModelMessage, ToolResultPart, UserContent, UserContentPart,
    UserModelMessage,
};
pub use model::{
    EmbeddingModel, LanguageModel, LanguageModelMiddleware, WrapLanguageModelOptions,
    wrap_language_model,
};
pub use prompt::{Instructions, Prompt};
pub use provider::*;
pub use telemetry::{Telemetry, TelemetryMeta, TelemetryOptions, register_telemetry};
pub use tool::{
    OnInputAvailableFunction, OnInputStartFunction, Schema, ToModelOutputFunction,
    ToModelOutputOptions, Tool, ToolChoice, ToolExecuteFunction, ToolExecutionOptions, ToolSet,
    ToolType, dynamic_tool, execute_fn, json_schema, json_schema_with_validator,
    on_input_available_fn, to_model_output_fn, tool, zod_schema,
};
pub use usage::{InputTokenDetails, LanguageModelUsage, OutputTokenDetails};
