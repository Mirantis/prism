//! The OpenAI provider tools the runtime uses (`openai.tools`).

use serde_json::{Map, Value, json};

use crate::ai::provider::JsonObject;
use crate::ai::tool::{ToModelOutputFunction, Tool, ToolExecuteFunction, ToolType, zod_schema};

/// The provider tool id of the tool search.
pub const TOOL_SEARCH_ID: &str = "openai.tool_search";

/// The arguments of `openai.tools.toolSearch`.
#[derive(Clone, Default)]
pub struct ToolSearchArgs {
    /// `server` (default): OpenAI searches the deferred tools. `client`: the model
    /// emits a `tool_search_call` and `execute` returns the tools to load.
    pub execution: Option<String>,
    /// A description of the tool search; used by a client search only.
    pub description: Option<String>,
    /// JSON Schema of the search arguments; used by a client search only.
    pub parameters: Option<JsonObject>,
    pub execute: Option<ToolExecuteFunction>,
    pub to_model_output: Option<ToModelOutputFunction>,
}

/// The tool search call's input as the model writes it: `{ arguments?, call_id? }`.
pub(crate) fn tool_search_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "arguments": {},
            "call_id": { "type": ["string", "null"] }
        },
        "additionalProperties": false
    })
}

/// `openai.tools.toolSearch(args)`: the provider tool `openai.tool_search`, whose
/// args are the given `execution`, `description` and `parameters`.
pub fn tool_search(args: ToolSearchArgs) -> Tool {
    let mut provider_args = Map::new();
    if let Some(execution) = args.execution {
        provider_args.insert("execution".to_string(), Value::String(execution));
    }
    if let Some(description) = args.description {
        provider_args.insert("description".to_string(), Value::String(description));
    }
    if let Some(parameters) = args.parameters {
        provider_args.insert("parameters".to_string(), Value::Object(parameters));
    }
    Tool {
        tool_type: ToolType::Provider {
            id: TOOL_SEARCH_ID.to_string(),
            args: provider_args,
            is_provider_executed: false,
            supports_deferred_results: None,
        },
        input_schema: zod_schema(tool_search_input_schema()),
        execute: args.execute,
        to_model_output: args.to_model_output,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::json::js_stringify;

    #[test]
    fn matches_the_sdk_tool_search_tool() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/openai_sdk.json")).unwrap();
        let expected = &fixture["toolSearch"];
        let tool = tool_search(ToolSearchArgs {
            execution: Some("client".to_string()),
            description: Some("Load deferred tools.".to_string()),
            parameters: Some(json!({ "type": "object" }).as_object().unwrap().clone()),
            ..Default::default()
        });
        let ToolType::Provider { id, args, .. } = &tool.tool_type else {
            panic!("a provider tool");
        };
        assert_eq!(id, expected["id"].as_str().unwrap());
        assert_eq!(
            js_stringify(&Value::Object(args.clone())),
            js_stringify(&expected["args"])
        );
        assert_eq!(
            js_stringify(tool.input_schema.json_schema()),
            js_stringify(&expected["inputSchema"])
        );
    }

    #[test]
    fn its_input_keeps_the_arguments_and_the_call_id() {
        let tool = tool_search(ToolSearchArgs::default());
        let parsed = tool
            .input_schema
            .validate(&json!({ "call_id": "tsc_1", "arguments": { "query": "x" }, "extra": 1 }))
            .unwrap();
        assert_eq!(
            js_stringify(&parsed),
            r#"{"arguments":{"query":"x"},"call_id":"tsc_1"}"#
        );
    }
}
