//! Tools: what the model may call, how its input is checked, and how a tool set is
//! sent to a provider.

use std::fmt;
use std::future::Future;
use std::sync::{Arc, OnceLock};

use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::errors::TypeValidationError;
use super::messages::ModelMessage;
use super::provider::{
    JsonObject, LanguageModelV4FunctionTool, LanguageModelV4ProviderTool, LanguageModelV4Tool,
    LanguageModelV4ToolChoice, ProviderOptions, ToolInputExample, ToolResultOutput,
};
use super::zod::ZodValidator;

/// A custom validator: the parsed value, or why the value does not match.
pub type ValidateFunction = Arc<dyn Fn(&Value) -> anyhow::Result<Value> + Send + Sync>;

enum Validation {
    None,
    Zod(OnceLock<ZodValidator>),
    Custom(ValidateFunction),
}

/// A JSON Schema, and how a value is checked against it.
#[derive(Clone)]
pub struct Schema {
    json_schema: Arc<Value>,
    validation: Arc<Validation>,
}

impl Schema {
    /// The JSON Schema the model is given.
    pub fn json_schema(&self) -> &Value {
        &self.json_schema
    }

    /// Whether the schema checks values at all.
    pub fn validates(&self) -> bool {
        !matches!(*self.validation, Validation::None)
    }

    /// The value as the schema parses it, or why it does not match. A schema
    /// without a validator passes every value through unchanged.
    pub fn validate(&self, value: &Value) -> anyhow::Result<Value> {
        match &*self.validation {
            Validation::None => Ok(value.clone()),
            Validation::Zod(cell) => {
                let validator = cell.get_or_init(|| ZodValidator::new(&self.json_schema));
                validator.parse(value).map_err(anyhow::Error::new)
            }
            Validation::Custom(f) => f(value),
        }
    }
}

impl Default for Schema {
    fn default() -> Self {
        json_schema(serde_json::json!({ "type": "object", "properties": {} }))
    }
}

impl fmt::Debug for Schema {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Schema")
            .field("json_schema", &self.json_schema)
            .finish()
    }
}

/// `jsonSchema(schema)`: a schema the SDK passes to the model and does not check.
pub fn json_schema(schema: Value) -> Schema {
    Schema {
        json_schema: Arc::new(schema),
        validation: Arc::new(Validation::None),
    }
}

/// `jsonSchema(schema, { validate })`: a schema checked by `validate`.
pub fn json_schema_with_validator(schema: Value, validate: ValidateFunction) -> Schema {
    Schema {
        json_schema: Arc::new(schema),
        validation: Arc::new(Validation::Custom(validate)),
    }
}

/// A zod schema, given as the JSON Schema `asSchema(zodSchema).jsonSchema` produces
/// for it. Values are checked as zod checks them: the same issues, keys in schema
/// order, unknown keys stripped, defaults filled in.
pub fn zod_schema(schema: Value) -> Schema {
    Schema {
        json_schema: Arc::new(schema),
        validation: Arc::new(Validation::Zod(OnceLock::new())),
    }
}

/// `safeValidateTypes`: the parsed value, or a `TypeValidationError`.
pub fn safe_validate_types(value: &Value, schema: &Schema) -> Result<Value, TypeValidationError> {
    schema
        .validate(value)
        .map_err(|cause| match cause.downcast::<TypeValidationError>() {
            Ok(existing) if existing.value == *value && existing.context.is_none() => existing,
            Ok(existing) => {
                TypeValidationError::new(value.clone(), anyhow::Error::new(existing), None)
            }
            Err(cause) => TypeValidationError::new(value.clone(), cause, None),
        })
}

/// What a tool's `execute` receives besides its input.
#[derive(Clone, Default)]
pub struct ToolExecutionOptions {
    /// The id of the tool call; it matches the result sent back to the model.
    pub tool_call_id: String,
    /// The messages of the request that produced the call.
    pub messages: Arc<Vec<ModelMessage>>,
    /// The call's cancellation.
    pub abort_signal: Option<CancellationToken>,
    /// This tool's entry of the call's `tools_context`.
    pub context: Value,
}

impl fmt::Debug for ToolExecutionOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolExecutionOptions")
            .field("tool_call_id", &self.tool_call_id)
            .field("messages", &self.messages.len())
            .finish()
    }
}

/// What `to_model_output` receives.
#[derive(Debug, Clone)]
pub struct ToModelOutputOptions {
    pub tool_call_id: String,
    pub input: Value,
    pub output: Value,
}

/// A tool's `execute`.
pub type ToolExecuteFunction = Arc<
    dyn Fn(Value, ToolExecutionOptions) -> BoxFuture<'static, anyhow::Result<Value>> + Send + Sync,
>;

/// A tool's `toModelOutput`: how its result is shown to the model.
pub type ToModelOutputFunction = Arc<
    dyn Fn(ToModelOutputOptions) -> BoxFuture<'static, anyhow::Result<ToolResultOutput>>
        + Send
        + Sync,
>;

/// A tool's `onInputAvailable`: run for every call of a step before any executes.
pub type OnInputAvailableFunction = Arc<
    dyn Fn(Value, ToolExecutionOptions) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync,
>;

/// A tool's `onInputStart`.
pub type OnInputStartFunction =
    Arc<dyn Fn(ToolExecutionOptions) -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>;

/// Wraps an async closure as a `ToolExecuteFunction`.
pub fn execute_fn<F, Fut>(f: F) -> ToolExecuteFunction
where
    F: Fn(Value, ToolExecutionOptions) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<Value>> + Send + 'static,
{
    Arc::new(move |input, options| Box::pin(f(input, options)))
}

/// Wraps an async closure as a `ToModelOutputFunction`.
pub fn to_model_output_fn<F, Fut>(f: F) -> ToModelOutputFunction
where
    F: Fn(ToModelOutputOptions) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<ToolResultOutput>> + Send + 'static,
{
    Arc::new(move |options| Box::pin(f(options)))
}

/// Wraps an async closure as an `OnInputAvailableFunction`.
pub fn on_input_available_fn<F, Fut>(f: F) -> OnInputAvailableFunction
where
    F: Fn(Value, ToolExecutionOptions) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    Arc::new(move |input, options| Box::pin(f(input, options)))
}

/// What kind of tool it is.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum ToolType {
    /// A function tool (`type` left out).
    #[default]
    Function,
    /// A function tool whose types are known only at runtime (`type: 'dynamic'`).
    Dynamic,
    /// A tool the provider defines (`type: 'provider'`).
    Provider {
        id: String,
        args: JsonObject,
        is_provider_executed: bool,
        supports_deferred_results: Option<bool>,
    },
}

impl ToolType {
    /// The tool's `type` property: `None` for a function tool.
    pub fn as_str(&self) -> Option<&'static str> {
        match self {
            ToolType::Function => None,
            ToolType::Dynamic => Some("dynamic"),
            ToolType::Provider { .. } => Some("provider"),
        }
    }
}

/// A tool the model may call.
#[derive(Clone, Default)]
pub struct Tool {
    pub tool_type: ToolType,
    pub description: Option<String>,
    pub title: Option<String>,
    pub input_schema: Schema,
    pub input_examples: Option<Vec<ToolInputExample>>,
    pub strict: Option<bool>,
    pub provider_options: Option<ProviderOptions>,
    pub metadata: Option<JsonObject>,
    pub execute: Option<ToolExecuteFunction>,
    pub to_model_output: Option<ToModelOutputFunction>,
    pub on_input_start: Option<OnInputStartFunction>,
    pub on_input_available: Option<OnInputAvailableFunction>,
}

impl Tool {
    /// Whether the SDK runs this tool itself (`isExecutableTool`).
    pub fn is_executable(&self) -> bool {
        self.execute.is_some()
    }

    pub fn is_dynamic(&self) -> bool {
        self.tool_type == ToolType::Dynamic
    }
}

impl fmt::Debug for Tool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tool")
            .field("tool_type", &self.tool_type)
            .field("description", &self.description)
            .field("input_schema", &self.input_schema)
            .field("provider_options", &self.provider_options)
            .field("execute", &self.execute.is_some())
            .field("to_model_output", &self.to_model_output.is_some())
            .finish()
    }
}

/// `tool(definition)`: the definition itself.
pub fn tool(definition: Tool) -> Tool {
    definition
}

/// `dynamicTool(definition)`: the definition with `type: 'dynamic'`.
pub fn dynamic_tool(definition: Tool) -> Tool {
    Tool {
        tool_type: ToolType::Dynamic,
        ..definition
    }
}

/// Tools by name. The order is the order they are sent to the model.
pub type ToolSet = IndexMap<String, Tool>;

/// How the model may choose a tool.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ToolChoice {
    #[default]
    Auto,
    None,
    Required,
    Tool {
        tool_name: String,
    },
}

impl Serialize for ToolChoice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ToolChoice::Auto => serializer.serialize_str("auto"),
            ToolChoice::None => serializer.serialize_str("none"),
            ToolChoice::Required => serializer.serialize_str("required"),
            ToolChoice::Tool { tool_name } => {
                serde_json::json!({ "type": "tool", "toolName": tool_name }).serialize(serializer)
            }
        }
    }
}

/// `prepareToolChoice`: the choice as the provider receives it, `auto` by default.
pub fn prepare_tool_choice(tool_choice: Option<&ToolChoice>) -> LanguageModelV4ToolChoice {
    match tool_choice {
        None | Some(ToolChoice::Auto) => LanguageModelV4ToolChoice::Auto,
        Some(ToolChoice::None) => LanguageModelV4ToolChoice::None,
        Some(ToolChoice::Required) => LanguageModelV4ToolChoice::Required,
        Some(ToolChoice::Tool { tool_name }) => LanguageModelV4ToolChoice::Tool {
            tool_name: tool_name.clone(),
        },
    }
}

fn order_tool_entries<'a>(
    tools: &'a ToolSet,
    tool_order: Option<&[String]>,
) -> Vec<(&'a String, &'a Tool)> {
    let Some(order) = tool_order else {
        return tools.iter().collect();
    };
    let mut ordered: Vec<(&String, &Tool)> = tools
        .iter()
        .filter(|(name, _)| order.contains(name))
        .collect();
    ordered.sort_by_key(|(name, _)| order.iter().position(|o| o == *name).unwrap_or(usize::MAX));
    let mut rest: Vec<(&String, &Tool)> = tools
        .iter()
        .filter(|(name, _)| !order.contains(name))
        .collect();
    rest.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    ordered.extend(rest);
    ordered
}

/// `prepareTools`: the tools as the provider receives them; `None` for no tools.
pub fn prepare_tools(
    tools: Option<&ToolSet>,
    tool_order: Option<&[String]>,
) -> Option<Vec<LanguageModelV4Tool>> {
    let tools = tools.filter(|t| !t.is_empty())?;
    let prepared = order_tool_entries(tools, tool_order)
        .into_iter()
        .map(|(name, tool)| match &tool.tool_type {
            ToolType::Function | ToolType::Dynamic => {
                LanguageModelV4Tool::Function(LanguageModelV4FunctionTool {
                    name: name.clone(),
                    input_schema: tool.input_schema.json_schema().clone(),
                    description: tool.description.clone(),
                    input_examples: tool.input_examples.clone(),
                    provider_options: tool.provider_options.clone(),
                    strict: tool.strict,
                })
            }
            ToolType::Provider { id, args, .. } => {
                LanguageModelV4Tool::Provider(LanguageModelV4ProviderTool {
                    name: name.clone(),
                    id: id.clone(),
                    args: args.clone(),
                })
            }
        })
        .collect();
    Some(prepared)
}

/// `filterActiveTools`: the tools named in `active_tools`, in tool set order.
pub fn filter_active_tools(
    tools: Option<&ToolSet>,
    active_tools: Option<&[String]>,
) -> Option<ToolSet> {
    let tools = tools?;
    match active_tools {
        None => Some(tools.clone()),
        Some(active) => Some(
            tools
                .iter()
                .filter(|(name, _)| active.contains(name))
                .map(|(n, t)| (n.clone(), t.clone()))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::json::js_stringify;
    use serde_json::json;

    fn set() -> ToolSet {
        let mut tools = ToolSet::new();
        tools.insert(
            "weather".into(),
            tool(Tool {
                description: Some("w".into()),
                input_schema: zod_schema(json!({ "type": "object", "properties": {} })),
                ..Default::default()
            }),
        );
        tools.insert(
            "search".into(),
            Tool {
                tool_type: ToolType::Provider {
                    id: "openai.tool_search".into(),
                    args: json!({ "execution": "client" })
                        .as_object()
                        .unwrap()
                        .clone(),
                    is_provider_executed: false,
                    supports_deferred_results: None,
                },
                ..Default::default()
            },
        );
        tools.insert(
            "boom".into(),
            Tool {
                input_schema: json_schema(json!({ "type": "object" })),
                provider_options: Some(
                    json!({ "anthropic": { "deferLoading": true } })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                strict: Some(false),
                ..Default::default()
            },
        );
        tools
    }

    #[test]
    fn prepares_function_and_provider_tools_in_set_order() {
        let prepared = prepare_tools(Some(&set()), None).unwrap();
        assert_eq!(
            js_stringify(&serde_json::to_value(&prepared).unwrap()),
            r#"[{"type":"function","name":"weather","inputSchema":{"type":"object","properties":{}},"description":"w"},{"type":"provider","name":"search","id":"openai.tool_search","args":{"execution":"client"}},{"type":"function","name":"boom","inputSchema":{"type":"object"},"providerOptions":{"anthropic":{"deferLoading":true}},"strict":false}]"#
        );
    }

    #[test]
    fn orders_listed_tools_first_and_the_rest_alphabetically() {
        let order = vec!["search".to_string()];
        let names: Vec<String> = prepare_tools(Some(&set()), Some(&order))
            .unwrap()
            .iter()
            .map(|t| t.name().to_string())
            .collect();
        assert_eq!(names, vec!["search", "boom", "weather"]);
    }

    #[test]
    fn sends_no_tools_for_an_empty_set() {
        assert!(prepare_tools(Some(&ToolSet::new()), None).is_none());
        assert_eq!(prepare_tool_choice(None), LanguageModelV4ToolChoice::Auto);
    }
}
