//! The Converse `toolConfig` (`prepareTools`): function tools as `toolSpec`s, the
//! tool choice, and the warnings for what Bedrock does not take.

use serde_json::{Map, Value, json};

use super::{is_anthropic_model, supports_strict_tools};
use crate::ai::errors::UnsupportedFunctionalityError;
use crate::ai::provider::{LanguageModelV4Tool, LanguageModelV4ToolChoice, Warning};

/// What `prepare_tools` returns.
pub struct PreparedTools {
    /// `{ tools, toolChoice }`, or `{}` when no tool is sent.
    pub tool_config: Map<String, Value>,
    /// Fields for `additionalModelRequestFields` (an Anthropic `tool_choice`).
    pub additional_tools: Option<Map<String, Value>>,
    /// Anthropic beta flags the tools need.
    pub betas: Vec<String>,
    pub tool_warnings: Vec<Warning>,
}

/// The inputs of `prepare_tools`.
pub struct PrepareToolsInput<'a> {
    pub tools: Option<&'a [LanguageModelV4Tool]>,
    pub tool_choice: Option<&'a LanguageModelV4ToolChoice>,
    pub model_id: &'a str,
    pub model_family: Option<&'a str>,
    pub reasoning_budget_tokens: Option<f64>,
    pub disable_parallel_tool_use: Option<bool>,
    pub rejects_forced_tool_use: bool,
}

const UNSUPPORTED_WEB_TOOLS: &[&str] = &[
    "anthropic.web_search_20250305",
    "anthropic.web_search_20260318",
    "anthropic.web_fetch_20260318",
];

fn empty(tool_warnings: Vec<Warning>) -> PreparedTools {
    PreparedTools {
        tool_config: Map::new(),
        additional_tools: None,
        betas: Vec::new(),
        tool_warnings,
    }
}

pub fn prepare_tools(input: PrepareToolsInput<'_>) -> anyhow::Result<PreparedTools> {
    let mut tool_warnings: Vec<Warning> = Vec::new();
    let Some(tools) = input.tools.filter(|t| !t.is_empty()) else {
        return Ok(empty(tool_warnings));
    };

    let supported: Vec<&LanguageModelV4Tool> = tools
        .iter()
        .filter(|tool| match tool {
            LanguageModelV4Tool::Provider(provider)
                if UNSUPPORTED_WEB_TOOLS.contains(&provider.id.as_str()) =>
            {
                let name = &provider.id["anthropic.".len()..];
                tool_warnings.push(Warning::Unsupported {
                    feature: format!("{name} tool"),
                    details: Some(format!(
                        "The {name} tool is not supported on Amazon Bedrock."
                    )),
                });
                false
            }
            _ => true,
        })
        .collect();
    if supported.is_empty() {
        return Ok(empty(tool_warnings));
    }

    let is_anthropic = is_anthropic_model(
        input.model_id,
        input.model_family,
        input.reasoning_budget_tokens,
    );
    let provider_tools: Vec<_> = supported
        .iter()
        .filter_map(|t| match t {
            LanguageModelV4Tool::Provider(p) => Some(p),
            _ => None,
        })
        .collect();
    let function_tools: Vec<_> = supported
        .iter()
        .filter_map(|t| match t {
            LanguageModelV4Tool::Function(f) => Some(f),
            _ => None,
        })
        .collect();
    let rejects_forced_tool_choice = is_anthropic
        && input.rejects_forced_tool_use
        && matches!(
            input.tool_choice,
            Some(LanguageModelV4ToolChoice::Required)
                | Some(LanguageModelV4ToolChoice::Tool { .. })
        );
    let provider_tools_for_request: Vec<_> = match input.tool_choice {
        Some(LanguageModelV4ToolChoice::Tool { tool_name }) if rejects_forced_tool_choice => {
            provider_tools
                .iter()
                .filter(|t| &t.name == tool_name)
                .copied()
                .collect()
        }
        _ => provider_tools.clone(),
    };

    let mut additional_tools: Option<Map<String, Value>> = None;
    let mut bedrock_tools: Vec<Value> = Vec::new();

    let using_anthropic_tools = is_anthropic && !provider_tools_for_request.is_empty();
    if using_anthropic_tools {
        return Err(UnsupportedFunctionalityError::new(
            "Anthropic provider-defined tools on the Converse API",
        )
        .into());
    }
    for tool in &provider_tools_for_request {
        tool_warnings.push(Warning::Unsupported {
            feature: format!("tool {}", tool.id),
            details: None,
        });
    }

    let mut prepared_choice = input.tool_choice.cloned();
    if rejects_forced_tool_choice {
        let details = match input.tool_choice {
            Some(LanguageModelV4ToolChoice::Tool { tool_name }) => format!(
                "toolChoice 'tool' is not supported by this model because it rejects forced tool use. Only the '{tool_name}' tool is sent with 'auto' tool choice. Instruct the model to use the tool in the prompt and verify that a tool call was made."
            ),
            _ => "toolChoice 'required' is not supported by this model because it rejects forced tool use. Using 'auto' instead. Instruct the model to use a tool in the prompt and verify that a tool call was made.".to_string(),
        };
        tool_warnings.push(Warning::Unsupported {
            feature: "toolChoice".to_string(),
            details: Some(details),
        });
        prepared_choice = Some(LanguageModelV4ToolChoice::Auto);
    }

    let filtered: Vec<_> = match input.tool_choice {
        Some(LanguageModelV4ToolChoice::Tool { tool_name }) => function_tools
            .iter()
            .filter(|t| &t.name == tool_name)
            .copied()
            .collect(),
        _ => function_tools.clone(),
    };

    let strict_on_tools = supports_strict_tools(input.model_id);
    for tool in filtered {
        let strict_for_tool = strict_on_tools
            && (tool.strict != Some(true) || is_strict_tool_schema_compatible(&tool.input_schema));
        if !strict_on_tools && tool.strict == Some(true) {
            tool_warnings.push(Warning::Unsupported {
                feature: "strict".to_string(),
                details: Some(format!(
                    "Tool '{}' has strict: true, but strict mode is not supported by this model on Amazon Bedrock. The strict property will be ignored.",
                    tool.name
                )),
            });
        } else if tool.strict == Some(true) && !strict_for_tool {
            tool_warnings.push(Warning::Unsupported {
                feature: "strict".to_string(),
                details: Some(format!(
                    "Tool '{}' has strict: true, but Amazon Bedrock requires every object in a strict tool schema to set additionalProperties: false. The strict property will be ignored.",
                    tool.name
                )),
            });
        }

        let mut spec = Map::new();
        spec.insert("name".into(), json!(tool.name));
        // `description?.trim() !== ''`: an absent description is kept as absent.
        if let Some(description) = &tool.description
            && !crate::support::js::trim(description).is_empty()
        {
            spec.insert("description".into(), json!(description));
        }
        if let Some(strict) = tool.strict
            && strict_for_tool
        {
            spec.insert("strict".into(), json!(strict));
        }
        spec.insert("inputSchema".into(), json!({ "json": tool.input_schema }));
        bedrock_tools.push(json!({ "toolSpec": spec }));
    }

    if is_anthropic
        && input.disable_parallel_tool_use == Some(true)
        && !bedrock_tools.is_empty()
        && prepared_choice != Some(LanguageModelV4ToolChoice::None)
    {
        let tool_choice = match &prepared_choice {
            Some(LanguageModelV4ToolChoice::Required) => {
                json!({ "type": "any", "disable_parallel_tool_use": true })
            }
            Some(LanguageModelV4ToolChoice::Tool { tool_name }) => {
                json!({ "type": "tool", "name": tool_name, "disable_parallel_tool_use": true })
            }
            _ => json!({ "type": "auto", "disable_parallel_tool_use": true }),
        };
        let mut fields = Map::new();
        fields.insert("tool_choice".into(), tool_choice);
        additional_tools = Some(fields);
    }

    let mut bedrock_tool_choice: Option<Value> = None;
    let has_additional_choice = additional_tools
        .as_ref()
        .is_some_and(|f| f.get("tool_choice").is_some_and(|c| !c.is_null()));
    if !has_additional_choice && !bedrock_tools.is_empty() {
        match &prepared_choice {
            Some(LanguageModelV4ToolChoice::Auto) => {
                bedrock_tool_choice = Some(json!({ "auto": {} }))
            }
            Some(LanguageModelV4ToolChoice::Required) => {
                bedrock_tool_choice = Some(json!({ "any": {} }))
            }
            Some(LanguageModelV4ToolChoice::None) => bedrock_tools.clear(),
            Some(LanguageModelV4ToolChoice::Tool { tool_name }) => {
                bedrock_tool_choice = Some(json!({ "tool": { "name": tool_name } }))
            }
            None => {}
        }
    }

    let mut tool_config = Map::new();
    if !bedrock_tools.is_empty() {
        tool_config.insert("tools".into(), Value::Array(bedrock_tools));
        if let Some(choice) = bedrock_tool_choice {
            tool_config.insert("toolChoice".into(), choice);
        }
    }

    Ok(PreparedTools {
        tool_config,
        additional_tools,
        betas: Vec::new(),
        tool_warnings,
    })
}

/// Whether every object in a strict schema sets `additionalProperties: false`.
fn is_strict_tool_schema_compatible(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        // `true` and `false` are schemas too.
        return true;
    };
    let is_object_type = match object.get("type") {
        Some(Value::String(t)) => t == "object",
        Some(Value::Array(types)) => types.iter().any(|t| t == "object"),
        _ => false,
    };
    if is_object_type && object.get("additionalProperties") != Some(&Value::Bool(false)) {
        return false;
    }
    for key in ["properties", "patternProperties", "definitions", "$defs"] {
        if let Some(Value::Object(map)) = object.get(key)
            && map.values().any(|d| !is_strict_tool_schema_compatible(d))
        {
            return false;
        }
    }
    if let Some(Value::Object(dependencies)) = object.get("dependencies")
        && dependencies
            .values()
            .any(|d| !d.is_array() && !is_strict_tool_schema_compatible(d))
    {
        return false;
    }
    for key in ["propertyNames", "contains", "not", "if", "then", "else"] {
        if let Some(nested) = object.get(key)
            && !nested.is_null()
            && !is_strict_tool_schema_compatible(nested)
        {
            return false;
        }
    }
    match object.get("items") {
        Some(Value::Array(items)) if items.iter().any(|i| !is_strict_tool_schema_compatible(i)) => {
            return false;
        }
        Some(items @ Value::Object(_)) if !is_strict_tool_schema_compatible(items) => return false,
        _ => {}
    }
    ["anyOf", "allOf", "oneOf"]
        .iter()
        .all(|key| match object.get(*key) {
            Some(Value::Array(alternatives)) => {
                alternatives.iter().all(is_strict_tool_schema_compatible)
            }
            _ => true,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_strict_schema_needs_closed_objects_everywhere() {
        assert!(is_strict_tool_schema_compatible(&json!({
            "type": "object",
            "properties": { "a": { "type": "object", "additionalProperties": false } },
            "additionalProperties": false
        })));
        assert!(!is_strict_tool_schema_compatible(&json!({
            "type": "object",
            "properties": { "a": { "type": "object" } },
            "additionalProperties": false
        })));
        assert!(!is_strict_tool_schema_compatible(&json!({
            "type": "object",
            "additionalProperties": false,
            "properties": { "list": { "type": "array", "items": { "type": "object" } } }
        })));
    }
}
