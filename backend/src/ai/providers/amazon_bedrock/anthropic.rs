//! Claude on Bedrock through the Anthropic Messages body over InvokeModel
//! (`@ai-sdk/amazon-bedrock/anthropic`): the Messages model with Bedrock's URL,
//! body and authorization.

use std::sync::Arc;

use indexmap::IndexSet;
use serde_json::{Map, Value, json};

use super::api::{
    EnvLookup, FetchFunction, FetchRequest, FetchResponse, default_fetch, encode_uri_component,
    process_env, resolve_bedrock_runtime_base_url,
};
use super::auth::{SessionTokenFallback, authorized_fetch, resolve_auth};
use super::{
    AmazonBedrockProviderSettings, VERSION, supports_native_structured_output,
    supports_strict_tools,
};
use crate::ai::LanguageModel;
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::json::{js_stringify, secure_json_parse};
use crate::ai::provider::SupportedUrls;
use crate::ai::providers::anthropic::{
    AnthropicMessagesConfig, AnthropicMessagesLanguageModel, HeadersFunction,
};

/// The provider `createBedrockAnthropic` returns.
pub struct BedrockAnthropicProvider {
    pub settings: AmazonBedrockProviderSettings,
    fetch: FetchFunction,
    env: EnvLookup,
}

/// `createAmazonBedrockAnthropic`: a bearer key when one is set, else SigV4.
pub fn create_bedrock_anthropic(
    settings: AmazonBedrockProviderSettings,
) -> BedrockAnthropicProvider {
    create_bedrock_anthropic_in(settings, process_env())
}

/// `create_bedrock_anthropic` reading `env` in place of the process environment.
pub fn create_bedrock_anthropic_in(
    settings: AmazonBedrockProviderSettings,
    env: EnvLookup,
) -> BedrockAnthropicProvider {
    let auth = resolve_auth(&settings, &env, SessionTokenFallback::Always);
    let base_fetch = authorized_fetch(auth, settings.fetch.clone().unwrap_or_else(default_fetch));
    BedrockAnthropicProvider {
        settings,
        fetch: bedrock_anthropic_fetch(base_fetch),
        env,
    }
}

/// Tools Bedrock knows only in a newer version.
const BEDROCK_TOOL_VERSION_MAP: &[(&str, &str)] = &[
    ("bash_20241022", "bash_20250124"),
    ("text_editor_20241022", "text_editor_20250728"),
    ("computer_20241022", "computer_20250124"),
];

/// The name a tool version requires.
const BEDROCK_TOOL_NAME_MAP: &[(&str, &str)] =
    &[("text_editor_20250728", "str_replace_based_edit_tool")];

/// The `anthropic_beta` each tool type requires on Bedrock.
const BEDROCK_TOOL_BETA_MAP: &[(&str, &str)] = &[
    ("bash_20250124", "computer-use-2025-01-24"),
    ("bash_20241022", "computer-use-2024-10-22"),
    ("text_editor_20250124", "computer-use-2025-01-24"),
    ("text_editor_20241022", "computer-use-2024-10-22"),
    ("text_editor_20250429", "computer-use-2025-01-24"),
    ("text_editor_20250728", "computer-use-2025-01-24"),
    ("computer_20250124", "computer-use-2025-01-24"),
    ("computer_20241022", "computer-use-2024-10-22"),
    (
        "tool_search_tool_regex_20251119",
        "tool-search-tool-2025-10-19",
    ),
    // Bedrock serves no BM25 search; the beta gets a clearer error from it.
    (
        "tool_search_tool_bm25_20251119",
        "tool-search-tool-2025-10-19",
    ),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// `transformRequestBody`: the Messages arguments as InvokeModel takes them. The
/// model id leaves the body for the URL, `tool_choice` keeps its type and name,
/// the thinking block binding takes Bedrock's field name, tools take the versions
/// and names Bedrock knows, the betas move into `anthropic_beta`, and
/// `anthropic_version` names Bedrock's.
pub fn transform_request_body(args: Value, betas: &IndexSet<String>) -> Value {
    let Value::Object(mut rest) = args else {
        return args;
    };
    rest.shift_remove("model");
    rest.shift_remove("stream");
    let tool_choice = rest.shift_remove("tool_choice").filter(|v| !v.is_null());
    let thinking = rest.shift_remove("thinking").filter(|v| !v.is_null());
    let tools = rest.shift_remove("tools").filter(|v| !v.is_null());

    let transformed_tool_choice = tool_choice.map(|choice| {
        let mut out = Map::new();
        out.insert(
            "type".into(),
            choice.get("type").cloned().unwrap_or(Value::Null),
        );
        if let Some(name) = choice.get("name").filter(|n| !n.is_null()) {
            out.insert("name".into(), name.clone());
        }
        Value::Object(out)
    });

    // Bedrock names the block binding field `mismatch_behavior`, where the Messages
    // API names it `prefix_mismatch_behavior`; some regions alias it, others fail.
    let transformed_thinking = thinking.map(|thinking| {
        let binding = thinking
            .get("block_binding")
            .filter(|b| !b.is_null())
            .cloned();
        match (binding, thinking) {
            (Some(binding), Value::Object(mut fields)) => {
                let behavior = binding
                    .get("prefix_mismatch_behavior")
                    .cloned()
                    .unwrap_or(Value::Null);
                let mut bound = Map::new();
                if !behavior.is_null() {
                    bound.insert("mismatch_behavior".into(), behavior);
                }
                fields.insert("block_binding".into(), Value::Object(bound));
                Value::Object(fields)
            }
            (_, thinking) => thinking,
        }
    });

    let mut required_betas: IndexSet<String> = betas.clone();
    let transformed_tools = tools.map(|tools| match tools {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|raw| transform_tool(raw, &mut required_betas))
                .collect(),
        ),
        other => other,
    });

    if let Some(thinking) = transformed_thinking {
        rest.insert("thinking".into(), thinking);
    }
    if let Some(tools) = transformed_tools {
        rest.insert("tools".into(), tools);
    }
    if let Some(choice) = transformed_tool_choice {
        rest.insert("tool_choice".into(), choice);
    }
    if !required_betas.is_empty() {
        rest.insert(
            "anthropic_beta".into(),
            json!(required_betas.into_iter().collect::<Vec<_>>()),
        );
    }
    rest.insert("anthropic_version".into(), json!("bedrock-2023-05-31"));
    Value::Object(rest)
}

/// One tool as Bedrock takes it.
fn transform_tool(raw: Value, required_betas: &mut IndexSet<String>) -> Value {
    let Value::Object(mut tool) = raw else {
        return raw;
    };
    // Bedrock refuses a tool's `eager_input_streaming`, but the beta alone turns the
    // same behavior on.
    if tool.shift_remove("eager_input_streaming") == Some(Value::Bool(true)) {
        required_betas.insert("fine-grained-tool-streaming-2025-05-14".to_string());
    }
    let tool_type = tool.get("type").and_then(Value::as_str).map(str::to_string);
    let Some(tool_type) = tool_type else {
        return Value::Object(tool);
    };

    if let Some(new_type) = lookup(BEDROCK_TOOL_VERSION_MAP, &tool_type) {
        if let Some(beta) = lookup(BEDROCK_TOOL_BETA_MAP, new_type) {
            required_betas.insert(beta.to_string());
        }
        let new_name = match lookup(BEDROCK_TOOL_NAME_MAP, new_type) {
            Some(name) => json!(name),
            None => tool.get("name").cloned().unwrap_or(Value::Null),
        };
        tool.insert("type".into(), json!(new_type));
        tool.insert("name".into(), new_name);
        return Value::Object(tool);
    }
    if let Some(beta) = lookup(BEDROCK_TOOL_BETA_MAP, &tool_type) {
        required_betas.insert(beta.to_string());
    }
    if let Some(name) = lookup(BEDROCK_TOOL_NAME_MAP, &tool_type) {
        tool.insert("name".into(), json!(name));
    }
    Value::Object(tool)
}

/// `createAmazonBedrockAnthropicFetch`: an error response's body in Anthropic's
/// error shape, so the Messages model reads the message Bedrock gave.
fn bedrock_anthropic_fetch(base: FetchFunction) -> FetchFunction {
    Arc::new(move |request: FetchRequest, abort_signal| {
        let base = base.clone();
        Box::pin(async move {
            let response = base(request, abort_signal).await?;
            if response.ok() {
                return Ok(response);
            }
            let text = String::from_utf8_lossy(&response.body).into_owned();
            let message = secure_json_parse(&text)
                .ok()
                .filter(Value::is_object)
                .and_then(|parsed| match parsed.get("message") {
                    None => Some(None),
                    Some(Value::String(message)) => Some(Some(message.clone())),
                    Some(_) => None,
                })
                .flatten()
                .filter(|m| !m.is_empty())
                .unwrap_or(text);
            let body = js_stringify(&json!({
                "type": "error",
                "error": { "type": "error", "message": message },
            }));
            Ok(FetchResponse {
                body: bytes::Bytes::from(body),
                ..response
            })
        })
    })
}

impl BedrockAnthropicProvider {
    /// `provider(modelId)`. The base URL is resolved here, so a missing or invalid
    /// region fails the model's creation.
    pub fn language_model(&self, model_id: &str) -> anyhow::Result<Arc<dyn LanguageModel>> {
        let base_url = resolve_bedrock_runtime_base_url(
            self.settings.base_url.as_deref(),
            self.settings.region.as_deref(),
            &self.env,
        )?;
        let header_settings = self.settings.headers.clone();
        let headers: HeadersFunction = Arc::new(move || {
            let headers = with_user_agent_suffix(
                header_settings.as_ref(),
                &format!("ai-sdk-amazon-bedrock/{VERSION}"),
            );
            Box::pin(async move { Ok(headers) })
        });
        let url_model_id = encode_uri_component(model_id);

        let mut config = AnthropicMessagesConfig::new("bedrock.anthropic.messages", base_url);
        config.headers = Some(headers);
        config.fetch = Some(self.fetch.clone());
        config.build_request_url = Some(Arc::new(move |base_url: &str, is_streaming: bool| {
            let action = if is_streaming {
                "invoke-with-response-stream"
            } else {
                "invoke"
            };
            format!("{base_url}/model/{url_model_id}/{action}")
        }));
        config.transform_request_body = Some(Arc::new(transform_request_body));
        // Bedrock reads no URL source, so every file is downloaded and sent inline.
        config.supported_urls = Some(Arc::new(SupportedUrls::new));
        config.supports_native_structured_output =
            Some(supports_native_structured_output(model_id));
        config.supports_strict_tools = Some(supports_strict_tools(model_id));
        Ok(Arc::new(AnthropicMessagesLanguageModel::new(
            model_id, config,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fake_fetch, fixtures};
    use super::*;
    use crate::ai::provider::LanguageModelV4CallOptions;
    use crate::ai::{ApiCallError, json::js_stringify};
    use parking_lot::Mutex;

    fn sent_headers(request: &FetchRequest) -> Value {
        let mut headers = Map::new();
        for (name, value) in &request.headers {
            let name = name.to_lowercase();
            let value = if name == "user-agent" {
                "<user-agent>".to_string()
            } else {
                value.clone()
            };
            headers.insert(name, json!(value));
        }
        Value::Object(headers)
    }

    #[tokio::test]
    async fn sends_claude_on_bedrock_as_the_sdk_does() {
        for case in fixtures()["anthropic"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let provider = create_bedrock_anthropic_in(
                AmazonBedrockProviderSettings {
                    region: Some("us-east-1".into()),
                    api_key: Some("test-key".into()),
                    fetch: Some(fake_fetch(&case["response"], seen.clone())),
                    ..Default::default()
                },
                Arc::new(|_: &str| None),
            );
            let model = provider
                .language_model(case["modelId"].as_str().unwrap())
                .unwrap();
            assert_eq!(model.provider(), "bedrock.anthropic.messages", "{name}");
            assert!(model.supported_urls().is_empty(), "{name}");
            let options: LanguageModelV4CallOptions =
                serde_json::from_value(case["options"].clone()).unwrap();
            let result = model.do_generate(options).await;

            let request = seen.lock()[0].clone();
            let expected = &case["request"];
            assert_eq!(request.url, expected["url"].as_str().unwrap(), "{name}");
            assert_eq!(sent_headers(&request), expected["headers"], "{name}");
            let body: Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(
                js_stringify(&body),
                js_stringify(&expected["body"]),
                "{name}: request body"
            );

            if case["error"].is_object() {
                let err = result.err().unwrap();
                let api = err.downcast_ref::<ApiCallError>().unwrap();
                let error = &case["error"];
                assert_eq!(api.message, error["message"].as_str().unwrap(), "{name}");
                assert_eq!(
                    api.status_code.map(u64::from),
                    error["statusCode"].as_u64(),
                    "{name}"
                );
                assert_eq!(
                    api.is_retryable,
                    error["isRetryable"].as_bool().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    api.response_body.as_deref(),
                    error["responseBody"].as_str(),
                    "{name}"
                );
                assert_eq!(api.data.as_ref(), Some(&error["data"]), "{name}");
                continue;
            }
            let result = result.unwrap_or_else(|e| panic!("{name}: {e:#}"));
            let actual = serde_json::to_value(&result).unwrap();
            assert_eq!(actual, case["result"], "{name}: result");
        }
    }

    #[test]
    fn upgrades_tools_bedrock_knows_only_in_a_newer_version() {
        let betas: IndexSet<String> = ["context-1m-2025-08-07".to_string()].into_iter().collect();
        let body = transform_request_body(
            json!({
                "model": "m",
                "max_tokens": 10,
                "thinking": { "type": "adaptive", "block_binding": { "prefix_mismatch_behavior": "error" } },
                "messages": [],
                "tools": [
                    { "type": "text_editor_20241022", "name": "str_replace_editor" },
                    { "type": "bash_20250124", "name": "bash" },
                    { "name": "plain", "input_schema": {}, "eager_input_streaming": true }
                ],
                "tool_choice": { "type": "auto", "disable_parallel_tool_use": true }
            }),
            &betas,
        );
        assert_eq!(
            js_stringify(&body),
            js_stringify(&json!({
                "max_tokens": 10,
                "messages": [],
                "thinking": { "type": "adaptive", "block_binding": { "mismatch_behavior": "error" } },
                "tools": [
                    { "type": "text_editor_20250728", "name": "str_replace_based_edit_tool" },
                    { "type": "bash_20250124", "name": "bash" },
                    { "name": "plain", "input_schema": {} }
                ],
                "tool_choice": { "type": "auto" },
                "anthropic_beta": [
                    "context-1m-2025-08-07",
                    "computer-use-2025-01-24",
                    "fine-grained-tool-streaming-2025-05-14"
                ],
                "anthropic_version": "bedrock-2023-05-31"
            }))
        );
    }

    #[tokio::test]
    async fn refuses_an_invalid_region_when_the_model_is_made() {
        let provider = create_bedrock_anthropic_in(
            AmazonBedrockProviderSettings {
                region: Some("bad region".into()),
                api_key: Some("k".into()),
                ..Default::default()
            },
            Arc::new(|_: &str| None),
        );
        assert!(
            provider
                .language_model("global.anthropic.claude-opus-5-5")
                .is_err()
        );
    }
}
