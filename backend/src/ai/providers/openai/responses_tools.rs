//! The tools and tool choice of a Responses API request (`prepareResponsesTools`),
//! and the mapping between the names the caller gives provider tools and the names
//! OpenAI gives them (`createToolNameMapping`).

use std::collections::HashSet;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::json_schema::normalize_openai_json_schema;
use super::tools::TOOL_SEARCH_ID;
use crate::ai::errors::{TypeValidationError, UnsupportedFunctionalityError};
use crate::ai::provider::{
    LanguageModelV4FunctionTool, LanguageModelV4Tool, LanguageModelV4ToolChoice, Warning,
};

/// The OpenAI tool name of each provider tool id.
pub(super) const PROVIDER_TOOL_NAMES: &[(&str, &str)] = &[
    ("openai.code_interpreter", "code_interpreter"),
    ("openai.computer", "computer"),
    ("openai.file_search", "file_search"),
    ("openai.image_generation", "image_generation"),
    ("openai.local_shell", "local_shell"),
    ("openai.shell", "shell"),
    ("openai.web_search", "web_search"),
    ("openai.web_search_preview", "web_search_preview"),
    ("openai.mcp", "mcp"),
    ("openai.apply_patch", "apply_patch"),
    ("openai.tool_search", "tool_search"),
    (
        "openai.programmatic_tool_calling",
        "programmatic_tool_calling",
    ),
];

/// The provider tools whose requests this port builds. The others are hosted tools
/// the runtime never declares.
const PORTED_PROVIDER_TOOLS: &[&str] = &[TOOL_SEARCH_ID];

pub use crate::ai::providers::provider_utils::ToolNameMapping;

/// What `prepareResponsesTools` gives the request.
#[derive(Debug, Default)]
pub struct PreparedTools {
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    pub tool_warnings: Vec<Warning>,
    /// The function tools that declare an output schema; their results are sent as
    /// JSON.
    pub output_schema_tool_names: HashSet<String>,
}

fn unsupported(functionality: &str) -> anyhow::Error {
    UnsupportedFunctionalityError::new(functionality).into()
}

/// The `openai` provider options of a function tool (`OpenAIToolOptions`), read
/// without validation.
fn tool_options(tool: &LanguageModelV4FunctionTool) -> Option<&Map<String, Value>> {
    tool.provider_options
        .as_ref()
        .and_then(|options| options.get("openai"))
        .and_then(Value::as_object)
}

/// `value != null` for an option.
fn option<'a>(options: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a Value> {
    options.and_then(|o| o.get(key)).filter(|v| !v.is_null())
}

pub fn prepare_responses_tools(
    tools: Option<&[LanguageModelV4Tool]>,
    tool_choice: Option<&LanguageModelV4ToolChoice>,
    tool_name_mapping: &ToolNameMapping,
    supports_async_tool_calling: bool,
) -> anyhow::Result<PreparedTools> {
    // When the tools array is empty, change it to undefined to prevent errors.
    let tools = tools.filter(|t| !t.is_empty());
    let mut prepared = PreparedTools::default();
    let Some(tools) = tools else {
        return Ok(prepared);
    };

    let mut openai_tools: Vec<Value> = Vec::new();
    // Namespace name → index of its tool in `openai_tools`.
    let mut namespace_tools: IndexMap<String, usize> = IndexMap::new();

    for tool in tools {
        match tool {
            LanguageModelV4Tool::Function(tool) => {
                let options = tool_options(tool);
                if option(options, "outputSchema").is_some() {
                    prepared.output_schema_tool_names.insert(tool.name.clone());
                }
                if options.and_then(|o| o.get("omitFromRequestTools")) == Some(&Value::Bool(true)) {
                    if let Some(LanguageModelV4ToolChoice::Tool { tool_name }) = tool_choice
                        && *tool_name == tool.name
                    {
                        return Err(unsupported(&format!(
                            "forcing tool \"{}\" omitted from the request tools array; use automatic tool choice for history-loaded tools",
                            tool.name
                        )));
                    }
                    continue;
                }
                let is_async = resolve_async_tool_option(
                    options.and_then(|o| o.get("async")),
                    supports_async_tool_calling,
                    &tool.name,
                    &mut prepared.tool_warnings,
                );
                let function_tool =
                    prepare_function_tool(tool, options, &mut prepared.tool_warnings, is_async)?;
                let Some(namespace) = option(options, "namespace") else {
                    openai_tools.push(function_tool);
                    continue;
                };
                let name = namespace.get("name").cloned().unwrap_or(Value::Null);
                let name_key = name.as_str().unwrap_or_default().to_string();
                let description = namespace.get("description").cloned().unwrap_or(Value::Null);
                match namespace_tools.get(&name_key) {
                    None => {
                        let mut namespace_tool = Map::new();
                        namespace_tool
                            .insert("type".to_string(), Value::String("namespace".to_string()));
                        namespace_tool.insert("name".to_string(), name);
                        namespace_tool.insert("description".to_string(), description);
                        namespace_tool
                            .insert("tools".to_string(), Value::Array(vec![function_tool]));
                        namespace_tools.insert(name_key, openai_tools.len());
                        openai_tools.push(Value::Object(namespace_tool));
                    }
                    Some(&index) => {
                        let namespace_tool = &mut openai_tools[index];
                        if namespace_tool.get("description") != Some(&description) {
                            return Err(unsupported(&format!(
                                "conflicting descriptions for OpenAI tool namespace \"{name_key}\""
                            )));
                        }
                        if let Some(Value::Array(list)) = namespace_tool.get_mut("tools") {
                            list.push(function_tool);
                        }
                    }
                }
            }
            LanguageModelV4Tool::Provider(tool) => {
                let known = PROVIDER_TOOL_NAMES.iter().any(|(id, _)| *id == tool.id)
                    || tool.id == "openai.custom";
                if known && !PORTED_PROVIDER_TOOLS.contains(&tool.id.as_str()) {
                    return Err(unsupported(&format!("provider tool {}", tool.id)));
                }
                if tool.id == TOOL_SEARCH_ID {
                    openai_tools.push(tool_search_tool(&tool.args)?);
                }
            }
        }
    }

    prepared.tools = Some(openai_tools);
    let Some(tool_choice) = tool_choice else {
        return Ok(prepared);
    };
    prepared.tool_choice = Some(match tool_choice {
        LanguageModelV4ToolChoice::Auto => Value::String("auto".to_string()),
        LanguageModelV4ToolChoice::None => Value::String("none".to_string()),
        LanguageModelV4ToolChoice::Required => Value::String("required".to_string()),
        LanguageModelV4ToolChoice::Tool { tool_name } => {
            let resolved = tool_name_mapping.to_provider_tool_name(tool_name);
            let mut choice = Map::new();
            if matches!(
                resolved.as_str(),
                "code_interpreter"
                    | "file_search"
                    | "image_generation"
                    | "web_search_preview"
                    | "web_search"
                    | "mcp"
                    | "apply_patch"
                    | "computer"
                    | "programmatic_tool_calling"
            ) {
                choice.insert("type".to_string(), Value::String(resolved));
            } else {
                choice.insert("type".to_string(), Value::String("function".to_string()));
                choice.insert("name".to_string(), Value::String(resolved));
            }
            Value::Object(choice)
        }
    });
    Ok(prepared)
}

/// `{ type: 'tool_search', execution?, description?, parameters? }` from the tool's
/// args, checked as `toolSearchArgsSchema` checks them.
fn tool_search_tool(args: &Map<String, Value>) -> anyhow::Result<Value> {
    let invalid = |message: &str| -> anyhow::Error {
        TypeValidationError::new(
            Value::Object(args.clone()),
            anyhow::anyhow!("{message}"),
            None,
        )
        .into()
    };
    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("tool_search".to_string()));
    match args.get("execution") {
        None => {}
        Some(Value::String(e)) if e == "server" || e == "client" => {
            out.insert("execution".to_string(), Value::String(e.clone()));
        }
        Some(_) => return Err(invalid("execution must be 'server' or 'client'")),
    }
    match args.get("description") {
        None => {}
        Some(Value::String(d)) => {
            out.insert("description".to_string(), Value::String(d.clone()));
        }
        Some(_) => return Err(invalid("description must be a string")),
    }
    match args.get("parameters") {
        None => {}
        Some(parameters @ Value::Object(_)) => {
            out.insert("parameters".to_string(), parameters.clone());
        }
        Some(_) => return Err(invalid("parameters must be an object")),
    }
    Ok(Value::Object(out))
}

fn prepare_function_tool(
    tool: &LanguageModelV4FunctionTool,
    options: Option<&Map<String, Value>>,
    tool_warnings: &mut Vec<Warning>,
    is_async: Option<Value>,
) -> anyhow::Result<Value> {
    let defer_loading = option(options, "deferLoading");
    let (input_schema, input_warnings) = normalize_openai_json_schema(&tool.input_schema)?;
    let output_schema = match option(options, "outputSchema") {
        Some(schema) => Some(normalize_openai_json_schema(schema)?),
        None => None,
    };
    tool_warnings.extend(input_warnings);
    if let Some((_, warnings)) = &output_schema {
        tool_warnings.extend(warnings.iter().cloned());
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("name".to_string(), Value::String(tool.name.clone()));
    if let Some(description) = &tool.description {
        out.insert(
            "description".to_string(),
            Value::String(description.clone()),
        );
    }
    out.insert("parameters".to_string(), input_schema);
    if let Some(is_async) = is_async {
        out.insert("async".to_string(), is_async);
    }
    out.insert(
        "strict".to_string(),
        Value::Bool(tool.strict.unwrap_or(false)),
    );
    if let Some(defer_loading) = defer_loading {
        out.insert("defer_loading".to_string(), defer_loading.clone());
    }
    if let Some(allowed_callers) = option(options, "allowedCallers") {
        out.insert("allowed_callers".to_string(), allowed_callers.clone());
    }
    if let Some((schema, _)) = output_schema {
        out.insert("output_schema".to_string(), schema);
    }
    Ok(Value::Object(out))
}

/// The `async` option as sent: `true` only on a model that calls tools asynchronously.
fn resolve_async_tool_option(
    value: Option<&Value>,
    supports_async_tool_calling: bool,
    tool_name: &str,
    tool_warnings: &mut Vec<Warning>,
) -> Option<Value> {
    if value != Some(&Value::Bool(true)) || supports_async_tool_calling {
        return value.filter(|v| !v.is_null()).cloned();
    }
    tool_warnings.push(Warning::Unsupported {
        feature: format!("async tool calling for \"{tool_name}\""),
        details: Some(
            "Async tool calling is only supported by GPT-6 and later models.".to_string(),
        ),
    });
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::json::js_stringify;
    use crate::ai::provider::LanguageModelV4ProviderTool;
    use serde_json::json;

    fn function(name: &str, options: Value) -> LanguageModelV4Tool {
        LanguageModelV4Tool::Function(LanguageModelV4FunctionTool {
            name: name.to_string(),
            input_schema: json!({ "type": "object" }),
            description: None,
            input_examples: None,
            provider_options: Some(json!({ "openai": options }).as_object().unwrap().clone()),
            strict: None,
        })
    }

    #[test]
    fn groups_tools_of_one_namespace() {
        let ns = json!({ "namespace": { "name": "fs", "description": "Files." } });
        let tools = vec![function("a", ns.clone()), function("b", ns)];
        let prepared =
            prepare_responses_tools(Some(&tools), None, &ToolNameMapping::default(), true).unwrap();
        assert_eq!(
            js_stringify(&Value::Array(prepared.tools.unwrap())),
            r#"[{"type":"namespace","name":"fs","description":"Files.","tools":[{"type":"function","name":"a","parameters":{"type":"object"},"strict":false},{"type":"function","name":"b","parameters":{"type":"object"},"strict":false}]}]"#
        );
    }

    #[test]
    fn async_tools_need_gpt_6() {
        let tools = vec![function("a", json!({ "async": true }))];
        let prepared =
            prepare_responses_tools(Some(&tools), None, &ToolNameMapping::default(), false)
                .unwrap();
        assert_eq!(prepared.tool_warnings.len(), 1);
        assert!(prepared.tools.unwrap()[0].get("async").is_none());
    }

    #[test]
    fn an_omitted_tool_is_left_out_and_cannot_be_forced() {
        let tools = vec![function("a", json!({ "omitFromRequestTools": true }))];
        let prepared =
            prepare_responses_tools(Some(&tools), None, &ToolNameMapping::default(), true).unwrap();
        assert_eq!(prepared.tools.unwrap().len(), 0);
        let choice = LanguageModelV4ToolChoice::Tool {
            tool_name: "a".to_string(),
        };
        assert!(
            prepare_responses_tools(
                Some(&tools),
                Some(&choice),
                &ToolNameMapping::default(),
                true
            )
            .is_err()
        );
    }

    #[test]
    fn a_hosted_tool_is_refused() {
        let tools = vec![LanguageModelV4Tool::Provider(LanguageModelV4ProviderTool {
            name: "search".to_string(),
            id: "openai.web_search".to_string(),
            args: Map::new(),
        })];
        let mapping = ToolNameMapping::new(Some(&tools), PROVIDER_TOOL_NAMES);
        assert!(prepare_responses_tools(Some(&tools), None, &mapping, true).is_err());
    }
}
