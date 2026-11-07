//! The tools block of a Messages API request (`anthropic-prepare-tools.ts`) and the
//! names provider-defined tools go by (`createToolNameMapping`).

use std::collections::HashMap;

use indexmap::IndexSet;
use serde_json::{Map, Value};

use super::cache_control::{CacheControlValidator, cacheable};
use crate::ai::{
    LanguageModelV4FunctionTool, LanguageModelV4ProviderTool, LanguageModelV4Tool,
    LanguageModelV4ToolChoice, Warning,
};

/// The provider tool ids Anthropic knows, with the name each has on the API.
const PROVIDER_TOOL_NAMES: &[(&str, &str)] = &[
    ("anthropic.code_execution_20250522", "code_execution"),
    ("anthropic.code_execution_20250825", "code_execution"),
    ("anthropic.code_execution_20260120", "code_execution"),
    ("anthropic.computer_20241022", "computer"),
    ("anthropic.computer_20250124", "computer"),
    ("anthropic.computer_20251124", "computer"),
    ("anthropic.computer_toolset_20260801", "computer"),
    ("anthropic.text_editor_20241022", "str_replace_editor"),
    ("anthropic.text_editor_20250124", "str_replace_editor"),
    (
        "anthropic.text_editor_20250429",
        "str_replace_based_edit_tool",
    ),
    (
        "anthropic.text_editor_20250728",
        "str_replace_based_edit_tool",
    ),
    ("anthropic.bash_20241022", "bash"),
    ("anthropic.bash_20250124", "bash"),
    ("anthropic.memory_20250818", "memory"),
    ("anthropic.web_search_20250305", "web_search"),
    ("anthropic.web_search_20260209", "web_search"),
    ("anthropic.web_search_20260318", "web_search"),
    ("anthropic.web_fetch_20250910", "web_fetch"),
    ("anthropic.web_fetch_20260209", "web_fetch"),
    ("anthropic.web_fetch_20260318", "web_fetch"),
    (
        "anthropic.tool_search_regex_20251119",
        "tool_search_tool_regex",
    ),
    (
        "anthropic.tool_search_bm25_20251119",
        "tool_search_tool_bm25",
    ),
    ("anthropic.advisor_20260301", "advisor"),
];

/// Maps the name a caller gave a provider tool to its name on the API, and back.
/// A name without a mapping maps to itself.
#[derive(Debug, Clone, Default)]
pub struct ToolNameMapping {
    custom_to_provider: HashMap<String, String>,
    provider_to_custom: HashMap<String, String>,
}

impl ToolNameMapping {
    /// `createToolNameMapping` over the request's tools.
    pub fn new(tools: Option<&[LanguageModelV4Tool]>) -> Self {
        let mut mapping = Self::default();
        for tool in tools.unwrap_or_default() {
            let LanguageModelV4Tool::Provider(tool) = tool else {
                continue;
            };
            let Some((_, provider_name)) =
                PROVIDER_TOOL_NAMES.iter().find(|(id, _)| *id == tool.id)
            else {
                continue;
            };
            mapping
                .custom_to_provider
                .insert(tool.name.clone(), provider_name.to_string());
            mapping
                .provider_to_custom
                .insert(provider_name.to_string(), tool.name.clone());
        }
        mapping
    }

    pub fn to_provider_tool_name(&self, custom_tool_name: &str) -> String {
        self.custom_to_provider
            .get(custom_tool_name)
            .cloned()
            .unwrap_or_else(|| custom_tool_name.to_string())
    }

    pub fn to_custom_tool_name(&self, provider_tool_name: &str) -> String {
        self.provider_to_custom
            .get(provider_tool_name)
            .cloned()
            .unwrap_or_else(|| provider_tool_name.to_string())
    }
}

/// The input of `prepare_tools`.
pub(super) struct PrepareToolsInput<'a> {
    pub tools: Vec<LanguageModelV4Tool>,
    pub tool_choice: Option<&'a LanguageModelV4ToolChoice>,
    pub disable_parallel_tool_use: Option<bool>,
    pub supports_structured_output: bool,
    pub supports_strict_tools: bool,
    pub default_eager_input_streaming: bool,
    pub rejects_forced_tool_use: bool,
}

/// The tools block, the tool choice, and what preparing them adds.
pub(super) struct PreparedTools {
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    pub tool_warnings: Vec<Warning>,
    pub betas: IndexSet<String>,
}

fn tool_choice(kind: &str, name: Option<&str>, disable_parallel_tool_use: Option<bool>) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), Value::from(kind));
    if let Some(name) = name {
        map.insert("name".into(), Value::from(name));
    }
    if let Some(disable) = disable_parallel_tool_use {
        map.insert("disable_parallel_tool_use".into(), Value::from(disable));
    }
    Value::Object(map)
}

/// `prepareTools`: Anthropic's tool definitions with their breakpoints, and the
/// tool choice. Tool choice `none` sends no tools, since the API has no such
/// choice.
pub(super) fn prepare_tools(
    input: PrepareToolsInput<'_>,
    validator: &mut CacheControlValidator,
) -> PreparedTools {
    let mut tool_warnings = Vec::new();
    let mut betas = IndexSet::new();
    if input.tools.is_empty() {
        return PreparedTools {
            tools: None,
            tool_choice: None,
            tool_warnings,
            betas,
        };
    }

    let mut anthropic_tools: Vec<Value> = Vec::new();
    for tool in &input.tools {
        match tool {
            LanguageModelV4Tool::Function(tool) => {
                anthropic_tools.push(function_tool(
                    tool,
                    &input,
                    validator,
                    &mut tool_warnings,
                    &mut betas,
                ));
            }
            LanguageModelV4Tool::Provider(tool) => {
                if let Some(definition) = provider_tool(tool, &mut betas) {
                    anthropic_tools.push(definition);
                } else {
                    tool_warnings.push(Warning::Unsupported {
                        feature: format!("provider-defined tool {}", tool.id),
                        details: None,
                    });
                }
            }
        }
    }

    let disable = input.disable_parallel_tool_use;
    let Some(choice) = input.tool_choice else {
        return PreparedTools {
            tools: Some(anthropic_tools),
            tool_choice: (disable == Some(true)).then(|| tool_choice("auto", None, disable)),
            tool_warnings,
            betas,
        };
    };

    let (tools, choice) = match choice {
        LanguageModelV4ToolChoice::Auto => (
            Some(anthropic_tools),
            Some(tool_choice("auto", None, disable)),
        ),
        LanguageModelV4ToolChoice::Required => {
            if input.rejects_forced_tool_use {
                tool_warnings.push(Warning::Unsupported {
                    feature: "toolChoice".to_string(),
                    details: Some(
                        "toolChoice 'required' is not supported by this model because it rejects forced tool use. Using 'auto' instead. Instruct the model to use a tool in the prompt and verify that a tool call was made."
                            .to_string(),
                    ),
                });
                (
                    Some(anthropic_tools),
                    Some(tool_choice("auto", None, disable)),
                )
            } else {
                (
                    Some(anthropic_tools),
                    Some(tool_choice("any", None, disable)),
                )
            }
        }
        LanguageModelV4ToolChoice::None => (None, None),
        LanguageModelV4ToolChoice::Tool { tool_name } => {
            if input.rejects_forced_tool_use {
                tool_warnings.push(Warning::Unsupported {
                    feature: "toolChoice".to_string(),
                    details: Some(format!(
                        "toolChoice 'tool' is not supported by this model because it rejects forced tool use. Only the '{tool_name}' tool is sent with 'auto' tool choice. Instruct the model to use the tool in the prompt and verify that a tool call was made."
                    )),
                });
                let only: Vec<Value> = anthropic_tools
                    .into_iter()
                    .filter(|tool| tool.get("name").and_then(Value::as_str) == Some(tool_name))
                    .collect();
                (Some(only), Some(tool_choice("auto", None, disable)))
            } else {
                (
                    Some(anthropic_tools),
                    Some(tool_choice("tool", Some(tool_name), disable)),
                )
            }
        }
    };
    PreparedTools {
        tools,
        tool_choice: choice,
        tool_warnings,
        betas,
    }
}

fn function_tool(
    tool: &LanguageModelV4FunctionTool,
    input: &PrepareToolsInput<'_>,
    validator: &mut CacheControlValidator,
    tool_warnings: &mut Vec<Warning>,
    betas: &mut IndexSet<String>,
) -> Value {
    let cache_control =
        validator.get_cache_control(tool.provider_options.as_ref(), cacheable("tool definition"));
    let anthropic = tool
        .provider_options
        .as_ref()
        .and_then(|options| options.get("anthropic"));
    let eager_input_streaming = anthropic
        .and_then(|options| options.get("eagerInputStreaming"))
        .filter(|value| !value.is_null())
        .map(super::cache_control::is_truthy)
        .unwrap_or(input.default_eager_input_streaming);
    let defer_loading = anthropic
        .and_then(|options| options.get("deferLoading"))
        .filter(|value| !value.is_null());
    let allowed_callers = anthropic
        .and_then(|options| options.get("allowedCallers"))
        .filter(|value| !value.is_null());

    if !input.supports_strict_tools && tool.strict == Some(true) {
        tool_warnings.push(Warning::Unsupported {
            feature: "strict".to_string(),
            details: Some(format!(
                "Tool '{}' has strict: true, but strict mode is not supported by this provider. The strict property will be ignored.",
                tool.name
            )),
        });
    }

    let mut map = Map::new();
    map.insert("name".into(), Value::from(tool.name.clone()));
    if let Some(description) = &tool.description {
        map.insert("description".into(), Value::from(description.clone()));
    }
    map.insert("input_schema".into(), tool.input_schema.clone());
    if let Some(cache_control) = cache_control {
        map.insert("cache_control".into(), cache_control);
    }
    if eager_input_streaming {
        map.insert("eager_input_streaming".into(), Value::Bool(true));
    }
    if input.supports_strict_tools {
        if let Some(strict) = tool.strict {
            map.insert("strict".into(), Value::Bool(strict));
        }
    }
    if let Some(defer_loading) = defer_loading {
        map.insert("defer_loading".into(), defer_loading.clone());
    }
    if let Some(allowed_callers) = allowed_callers {
        map.insert("allowed_callers".into(), allowed_callers.clone());
    }
    if let Some(examples) = &tool.input_examples {
        map.insert(
            "input_examples".into(),
            Value::Array(
                examples
                    .iter()
                    .map(|example| example.input.clone())
                    .collect(),
            ),
        );
    }

    if input.supports_structured_output {
        betas.insert("structured-outputs-2025-11-13".to_string());
    }
    if tool.input_examples.is_some() || allowed_callers.is_some() {
        betas.insert("advanced-tool-use-2025-11-20".to_string());
    }
    Value::Object(map)
}

fn arg<'a>(tool: &'a LanguageModelV4ProviderTool, name: &str) -> Option<&'a Value> {
    tool.args.get(name).filter(|value| !value.is_null())
}

fn put_arg(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// A provider-defined tool's definition, or `None` for an id Anthropic does not
/// define. Its arguments go to the API as given.
fn provider_tool(
    tool: &LanguageModelV4ProviderTool,
    betas: &mut IndexSet<String>,
) -> Option<Value> {
    let mut map = Map::new();
    let named = |map: &mut Map<String, Value>, kind: &str, name: &str| {
        map.insert("type".into(), Value::from(kind));
        map.insert("name".into(), Value::from(name));
    };
    let mut beta = |name: &str| {
        betas.insert(name.to_string());
    };
    match tool.id.as_str() {
        "anthropic.code_execution_20250522" => {
            beta("code-execution-2025-05-22");
            named(&mut map, "code_execution_20250522", "code_execution");
        }
        "anthropic.code_execution_20250825" => {
            beta("code-execution-2025-08-25");
            named(&mut map, "code_execution_20250825", "code_execution");
        }
        "anthropic.code_execution_20260120" => {
            named(&mut map, "code_execution_20260120", "code_execution");
        }
        "anthropic.computer_20241022"
        | "anthropic.computer_20250124"
        | "anthropic.computer_20251124" => {
            let kind = tool.id.trim_start_matches("anthropic.");
            beta(match kind {
                "computer_20241022" => "computer-use-2024-10-22",
                "computer_20250124" => "computer-use-2025-01-24",
                _ => "computer-use-2025-11-24",
            });
            map.insert("name".into(), Value::from("computer"));
            map.insert("type".into(), Value::from(kind));
            put_arg(&mut map, "display_width_px", arg(tool, "displayWidthPx"));
            put_arg(&mut map, "display_height_px", arg(tool, "displayHeightPx"));
            put_arg(&mut map, "display_number", arg(tool, "displayNumber"));
            if kind == "computer_20251124" {
                put_arg(&mut map, "enable_zoom", arg(tool, "enableZoom"));
            }
        }
        "anthropic.computer_toolset_20260801" => {
            map.insert("type".into(), Value::from("computer_toolset_20260801"));
            if let Some(Value::Object(configs)) = arg(tool, "configs") {
                let configs: Map<String, Value> = configs
                    .iter()
                    .map(|(member, config)| {
                        let mut entry = Map::new();
                        put_arg(
                            &mut entry,
                            "enabled",
                            config.get("enabled").filter(|v| !v.is_null()),
                        );
                        put_arg(
                            &mut entry,
                            "defer_loading",
                            config.get("deferLoading").filter(|v| !v.is_null()),
                        );
                        (member.clone(), Value::Object(entry))
                    })
                    .collect();
                map.insert("configs".into(), Value::Object(configs));
            }
        }
        "anthropic.text_editor_20250124" | "anthropic.text_editor_20241022" => {
            let kind = tool.id.trim_start_matches("anthropic.");
            beta(if kind == "text_editor_20250124" {
                "computer-use-2025-01-24"
            } else {
                "computer-use-2024-10-22"
            });
            map.insert("name".into(), Value::from("str_replace_editor"));
            map.insert("type".into(), Value::from(kind));
        }
        "anthropic.text_editor_20250429" => {
            beta("computer-use-2025-01-24");
            map.insert("name".into(), Value::from("str_replace_based_edit_tool"));
            map.insert("type".into(), Value::from("text_editor_20250429"));
        }
        "anthropic.text_editor_20250728" => {
            map.insert("name".into(), Value::from("str_replace_based_edit_tool"));
            map.insert("type".into(), Value::from("text_editor_20250728"));
            put_arg(&mut map, "max_characters", arg(tool, "maxCharacters"));
        }
        "anthropic.bash_20250124" | "anthropic.bash_20241022" => {
            let kind = tool.id.trim_start_matches("anthropic.");
            beta(if kind == "bash_20250124" {
                "computer-use-2025-01-24"
            } else {
                "computer-use-2024-10-22"
            });
            map.insert("name".into(), Value::from("bash"));
            map.insert("type".into(), Value::from(kind));
        }
        "anthropic.memory_20250818" => {
            beta("context-management-2025-06-27");
            map.insert("name".into(), Value::from("memory"));
            map.insert("type".into(), Value::from("memory_20250818"));
        }
        "anthropic.web_fetch_20250910"
        | "anthropic.web_fetch_20260209"
        | "anthropic.web_fetch_20260318" => {
            let kind = tool.id.trim_start_matches("anthropic.");
            match kind {
                "web_fetch_20250910" => beta("web-fetch-2025-09-10"),
                "web_fetch_20260209" => beta("code-execution-web-tools-2026-02-09"),
                _ => {}
            }
            named(&mut map, kind, "web_fetch");
            put_arg(&mut map, "max_uses", arg(tool, "maxUses"));
            put_arg(&mut map, "allowed_domains", arg(tool, "allowedDomains"));
            put_arg(&mut map, "blocked_domains", arg(tool, "blockedDomains"));
            put_arg(&mut map, "citations", arg(tool, "citations"));
            put_arg(
                &mut map,
                "max_content_tokens",
                arg(tool, "maxContentTokens"),
            );
            if kind == "web_fetch_20260318" {
                put_arg(&mut map, "use_cache", arg(tool, "useCache"));
                put_arg(
                    &mut map,
                    "response_inclusion",
                    arg(tool, "responseInclusion"),
                );
            }
        }
        "anthropic.web_search_20250305"
        | "anthropic.web_search_20260209"
        | "anthropic.web_search_20260318" => {
            let kind = tool.id.trim_start_matches("anthropic.");
            if kind == "web_search_20260209" {
                beta("code-execution-web-tools-2026-02-09");
            }
            named(&mut map, kind, "web_search");
            put_arg(&mut map, "max_uses", arg(tool, "maxUses"));
            put_arg(&mut map, "allowed_domains", arg(tool, "allowedDomains"));
            put_arg(&mut map, "blocked_domains", arg(tool, "blockedDomains"));
            put_arg(&mut map, "user_location", arg(tool, "userLocation"));
            if kind == "web_search_20260318" {
                put_arg(
                    &mut map,
                    "response_inclusion",
                    arg(tool, "responseInclusion"),
                );
            }
        }
        "anthropic.tool_search_regex_20251119" => {
            named(
                &mut map,
                "tool_search_tool_regex_20251119",
                "tool_search_tool_regex",
            );
        }
        "anthropic.tool_search_bm25_20251119" => {
            named(
                &mut map,
                "tool_search_tool_bm25_20251119",
                "tool_search_tool_bm25",
            );
        }
        "anthropic.advisor_20260301" => {
            beta("advisor-tool-2026-03-01");
            named(&mut map, "advisor_20260301", "advisor");
            put_arg(&mut map, "model", arg(tool, "model"));
            put_arg(&mut map, "max_uses", arg(tool, "maxUses"));
            put_arg(&mut map, "max_tokens", arg(tool, "maxTokens"));
            put_arg(&mut map, "caching", arg(tool, "caching"));
        }
        _ => return None,
    }
    Some(Value::Object(map))
}
