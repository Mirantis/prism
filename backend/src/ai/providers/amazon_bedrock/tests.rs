//! The provider against what `@ai-sdk/amazon-bedrock` sends and returns, recorded
//! by `testdata/sdk_requests.mjs` with a fake `fetch` under Node 24
//! (`testdata/sdk_requests.json`).

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::api::{EnvLookup, FetchFunction, FetchRequest, FetchResponse};
use super::*;
use crate::ai::json::{js_stringify, normalize_numbers};
use crate::ai::provider::{EmbeddingModelV4CallOptions, LanguageModelV4CallOptions};
use crate::ai::{ApiCallError, LanguageModel};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("testdata/sdk_requests.json")).unwrap()
}

fn no_env() -> EnvLookup {
    Arc::new(|_: &str| None)
}

/// A `fetch` that records each request and answers with the case's response.
fn fake_fetch(response: &Value, seen: Arc<Mutex<Vec<FetchRequest>>>) -> FetchFunction {
    let status = response["status"].as_u64().unwrap_or(200) as u16;
    let status_text = response["statusText"].as_str().unwrap_or("OK").to_string();
    let mut headers: Vec<(String, String)> = response["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.as_str().unwrap().to_string()))
        .collect();
    headers.sort();
    let body = match &response["body"] {
        Value::String(text) => text.clone(),
        other => js_stringify(other),
    };
    Arc::new(move |request: FetchRequest, _| {
        seen.lock().push(request);
        let response = FetchResponse {
            status,
            status_text: status_text.clone(),
            headers: headers.iter().cloned().collect(),
            body: bytes::Bytes::from(body.clone()),
        };
        Box::pin(async move { Ok(response) })
    })
}

fn provider_for(case: &Value, seen: Arc<Mutex<Vec<FetchRequest>>>) -> AmazonBedrockProvider {
    create_amazon_bedrock_in(
        AmazonBedrockProviderSettings {
            region: Some("us-east-1".into()),
            api_key: Some("test-key".into()),
            fetch: Some(fake_fetch(&case["response"], seen)),
            ..Default::default()
        },
        no_env(),
    )
}

/// The recorded request's headers with the user agent left out, as the fixture
/// writes them.
fn sent_headers(request: &FetchRequest) -> Value {
    let mut headers = serde_json::Map::new();
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

fn check_error(name: &str, err: &anyhow::Error, expected: &Value) {
    let api = err
        .downcast_ref::<ApiCallError>()
        .unwrap_or_else(|| panic!("{name}: not an ApiCallError: {err:#}"));
    assert_eq!(api.message, expected["message"].as_str().unwrap(), "{name}");
    assert_eq!(
        api.status_code.map(u64::from),
        expected["statusCode"].as_u64(),
        "{name}"
    );
    assert_eq!(
        api.is_retryable,
        expected["isRetryable"].as_bool().unwrap(),
        "{name}"
    );
    if let Some(body) = expected["responseBody"].as_str() {
        assert_eq!(api.response_body.as_deref(), Some(body), "{name}");
    }
    if !expected["data"].is_null() {
        assert_eq!(api.data.as_ref(), Some(&expected["data"]), "{name}");
    }
}

#[tokio::test]
async fn sends_and_reads_converse_as_the_sdk_does() {
    for case in fixtures()["converse"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let provider = provider_for(case, seen.clone());
        let model = provider.language_model(case["modelId"].as_str().unwrap());
        assert_eq!(
            model.provider(),
            case["provider"].as_str().unwrap(),
            "{name}"
        );
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
            check_error(name, &result.err().unwrap(), &case["error"]);
            continue;
        }
        let result = result.unwrap_or_else(|e| panic!("{name}: {e:#}"));
        let actual = serde_json::to_value(&result).unwrap();
        let mut expected_result = case["result"].clone();
        // `generateId` is random; the fixture cases never need one.
        assert_eq!(actual, expected_result.take(), "{name}: result");
    }
}

#[tokio::test]
async fn embeds_as_the_sdk_does() {
    for case in fixtures()["embedding"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let provider = provider_for(case, seen.clone());
        let model = provider.embedding(case["modelId"].as_str().unwrap());
        assert_eq!(
            model.max_embeddings_per_call(),
            case["maxEmbeddingsPerCall"].as_u64().map(|n| n as usize),
            "{name}"
        );
        let options: EmbeddingModelV4CallOptions =
            serde_json::from_value(case["options"].clone()).unwrap();
        let result = model.do_embed(options).await;

        let request = seen.lock()[0].clone();
        assert_eq!(
            request.url,
            case["request"]["url"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(sent_headers(&request), case["request"]["headers"], "{name}");
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(
            js_stringify(&body),
            js_stringify(&case["request"]["body"]),
            "{name}: request body"
        );

        if case["error"].is_object() {
            check_error(name, &result.err().unwrap(), &case["error"]);
            continue;
        }
        let result = result.unwrap_or_else(|e| panic!("{name}: {e:#}"));
        // The token count is an `f64`; compare it as JavaScript prints it.
        assert_eq!(
            normalize_numbers(serde_json::to_value(&result).unwrap()),
            case["result"],
            "{name}"
        );
    }
}

#[tokio::test]
async fn refuses_more_values_than_one_call_embeds() {
    let provider = create_amazon_bedrock_in(
        AmazonBedrockProviderSettings {
            region: Some("us-east-1".into()),
            api_key: Some("k".into()),
            ..Default::default()
        },
        no_env(),
    );
    let err = provider
        .embedding("amazon.titan-embed-text-v2:0")
        .do_embed(EmbeddingModelV4CallOptions {
            values: vec!["a".into(), "b".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "Too many values for a single embedding call. The amazon-bedrock model \"amazon.titan-embed-text-v2:0\" can only embed up to 1 values per call, but 2 values were provided."
    );
}

#[tokio::test]
async fn sends_through_the_gateway_url_with_the_bearer_key() {
    let case = &fixtures()["converse"][0];
    let seen = Arc::new(Mutex::new(Vec::new()));
    let provider = create_amazon_bedrock_in(
        AmazonBedrockProviderSettings {
            region: Some("us-east-1".into()),
            base_url: Some("https://gateway.example.com/llm/bedrock/us-east-1/".into()),
            fetch: Some(fake_fetch(&case["response"], seen.clone())),
            ..Default::default()
        },
        Arc::new(|name: &str| (name == "AWS_BEARER_TOKEN_BEDROCK").then(|| "sentinel".to_string())),
    );
    let options: LanguageModelV4CallOptions =
        serde_json::from_value(case["options"].clone()).unwrap();
    provider
        .language_model("moonshotai.kimi-k2.5")
        .do_generate(options)
        .await
        .unwrap();
    let request = seen.lock()[0].clone();
    assert_eq!(
        request.url,
        "https://gateway.example.com/llm/bedrock/us-east-1/model/moonshotai.kimi-k2.5/converse"
    );
    assert_eq!(
        request.headers.get("Authorization").unwrap(),
        "Bearer sentinel"
    );
}

#[tokio::test]
async fn names_the_sdk_versions_in_the_user_agent() {
    let case = &fixtures()["converse"][0];
    let seen = Arc::new(Mutex::new(Vec::new()));
    let provider = provider_for(case, seen.clone());
    let options: LanguageModelV4CallOptions =
        serde_json::from_value(case["options"].clone()).unwrap();
    provider
        .language_model("us.moonshotai.kimi-k3")
        .do_generate(options)
        .await
        .unwrap();
    let request = seen.lock()[0].clone();
    assert_eq!(
        request.headers.get("user-agent").unwrap(),
        "ai/7.0.137 ai-sdk-provider-utils/5.0.58 ai-sdk-amazon-bedrock/5.0.113"
    );
}

#[test]
fn tells_claude_models_apart_by_their_support() {
    assert!(is_anthropic_model(
        "us.anthropic.claude-opus-4-7",
        None,
        None
    ));
    assert!(is_anthropic_model(
        "arn:x:application-inference-profile/abc",
        None,
        Some(1024.0)
    ));
    assert!(!is_anthropic_model(
        "arn:x:application-inference-profile/abc",
        None,
        None
    ));
    assert!(is_anthropic_model("custom", Some("anthropic"), None));
    assert!(!supports_strict_tools("global.anthropic.claude-opus-5-5"));
    assert!(supports_strict_tools("us.anthropic.claude-sonnet-4-6-v1"));
    assert!(!supports_native_structured_output(
        "us.anthropic.claude-sonnet-4-6-v1"
    ));
    assert!(!supports_native_structured_output(
        "global.anthropic.claude-haiku-5-5"
    ));
    assert!(supports_native_structured_output(
        "us.anthropic.claude-opus-4-1-20250805-v1:0"
    ));
}
