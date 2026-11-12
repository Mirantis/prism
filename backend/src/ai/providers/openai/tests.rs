//! The provider against `testdata/openai_sdk.json`: what `@ai-sdk/openai` sent
//! and returned for the same call options (written by `testdata/openai_sdk.mjs`).

use std::sync::Arc;

use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::api::{EnvLookup, FetchFunction, FetchRequest, FetchResponse};
use super::{OpenAIProviderSettings, create_openai_with_env};
use crate::ai::errors::ApiCallError;
use crate::ai::json::js_stringify;
use crate::ai::provider::{EmbeddingModelV4CallOptions, LanguageModelV4CallOptions};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../testdata/openai_sdk.json")).unwrap()
}

fn no_env() -> EnvLookup {
    Arc::new(|_| None)
}

type Captured = Arc<Mutex<Option<FetchRequest>>>;

/// A `fetch` that records the request and answers with the given response.
fn fake_fetch(
    status: u16,
    status_text: &str,
    headers: &Value,
    body: &str,
) -> (FetchFunction, Captured) {
    let captured: Captured = Arc::new(Mutex::new(None));
    let sink = captured.clone();
    let status_text = status_text.to_string();
    let body = body.to_string();
    let mut response_headers: Vec<(String, String)> = headers
        .as_object()
        .map(|h| {
            h.iter()
                .map(|(k, v)| (k.to_lowercase(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    response_headers.sort();
    let fetch: FetchFunction = Arc::new(move |request| {
        *sink.lock() = Some(request);
        let response = FetchResponse {
            status,
            status_text: status_text.clone(),
            headers: response_headers.clone().into_iter().collect(),
            body: Bytes::from(body.clone()),
        };
        Box::pin(async move { Ok(response) })
    });
    (fetch, captured)
}

fn provider(fetch: FetchFunction) -> super::OpenAIProvider {
    create_openai_with_env(
        OpenAIProviderSettings {
            api_key: Some("sk-test".to_string()),
            base_url: Some("https://api.example.com/v1".to_string()),
            fetch: Some(fetch),
            ..Default::default()
        },
        no_env(),
    )
}

fn call_options(value: &Value) -> LanguageModelV4CallOptions {
    serde_json::from_value(value.clone()).expect("the fixture's call options deserialize")
}

fn assert_error(err: &anyhow::Error, expected: &Value, name: &str) {
    assert_eq!(
        err.to_string(),
        expected["message"].as_str().unwrap(),
        "{name}: message"
    );
    assert_eq!(
        crate::ai::error_name(err),
        expected["name"].as_str().unwrap(),
        "{name}: error name"
    );
    let Some(api) = err.downcast_ref::<ApiCallError>() else {
        return;
    };
    assert_eq!(
        api.status_code.map(u64::from),
        expected["statusCode"].as_u64(),
        "{name}: status"
    );
    assert_eq!(
        Some(api.is_retryable),
        expected["isRetryable"].as_bool(),
        "{name}: retryable"
    );
    assert_eq!(
        Some(api.url.as_str()),
        expected["url"].as_str(),
        "{name}: url"
    );
    assert_eq!(api.data.as_ref(), expected.get("data"), "{name}: data");
    match &expected["responseBody"] {
        Value::String(body) => {
            assert_eq!(api.response_body.as_deref(), Some(body.as_str()), "{name}")
        }
        // The SDK hands the parsed body on for an error in a successful response.
        other => assert_eq!(
            api.response_body
                .as_deref()
                .map(|b| serde_json::from_str::<Value>(b).unwrap()),
            Some(other.clone()),
            "{name}: response body"
        ),
    }
    let headers = serde_json::to_value(api.response_headers.as_ref().unwrap()).unwrap();
    assert_eq!(
        js_stringify(&headers),
        js_stringify(&expected["responseHeaders"]),
        "{name}"
    );
}

#[tokio::test]
async fn requests_match_the_sdk() {
    let fixture = fixture();
    for case in fixture["requests"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let ok = json!({
            "id": "resp_ok",
            "created_at": 1741269019,
            "model": "gpt-test",
            "output": [{ "type": "message", "role": "assistant", "id": "msg_ok",
                         "content": [{ "type": "output_text", "text": "ok", "annotations": [] }] }],
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        });
        let (fetch, captured) = fake_fetch(
            200,
            "OK",
            &json!({ "content-type": "application/json" }),
            &js_stringify(&ok),
        );
        let model = provider(fetch).language_model(case["modelId"].as_str().unwrap());
        let result = model.do_generate(call_options(&case["options"])).await;

        if let Some(expected) = case.get("error") {
            let err = result
                .err()
                .unwrap_or_else(|| panic!("{name}: the SDK failed"));
            assert_error(&err, expected, name);
            continue;
        }
        let result = result.unwrap_or_else(|err| panic!("{name}: {err}"));
        let request = captured.lock().clone().expect("a request was sent");
        assert_eq!(request.url, case["url"].as_str().unwrap(), "{name}: url");
        let headers = serde_json::to_value(&request.headers).unwrap();
        assert_eq!(
            js_stringify(&headers),
            js_stringify(&case["headers"]),
            "{name}: headers"
        );
        assert_eq!(request.body, case["body"].as_str().unwrap(), "{name}: body");
        assert_eq!(
            serde_json::to_value(&result.warnings).unwrap(),
            case["warnings"],
            "{name}: warnings"
        );
        assert_eq!(
            result
                .request
                .unwrap()
                .body
                .map(|b| js_stringify(&b))
                .as_deref(),
            case["body"].as_str(),
            "{name}: request body"
        );
    }
}

/// The SDK's content, without the citations the provider interface here does not
/// have, and with the random ids of sources blanked.
fn comparable_content(content: &Value) -> Value {
    let mut parts = content.as_array().cloned().unwrap_or_default();
    for part in &mut parts {
        let Value::Object(part) = part else { continue };
        part.shift_remove("citations");
        if part.get("type") == Some(&json!("source")) {
            part.insert("id".to_string(), json!("<id>"));
        }
    }
    Value::Array(parts)
}

#[tokio::test]
async fn responses_match_the_sdk() {
    let fixture = fixture();
    for case in fixture["responses"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (fetch, _) = fake_fetch(
            case["status"].as_u64().unwrap() as u16,
            case["statusText"].as_str().unwrap(),
            &case["responseHeaders"],
            case["responseBody"].as_str().unwrap(),
        );
        let model = provider(fetch).language_model(case["modelId"].as_str().unwrap());
        let result = model.do_generate(call_options(&case["options"])).await;

        if let Some(expected) = case.get("error") {
            let err = result
                .err()
                .unwrap_or_else(|| panic!("{name}: the SDK failed"));
            assert_error(&err, expected, name);
            continue;
        }
        let result = result.unwrap_or_else(|err| panic!("{name}: {err}"));
        let expected = &case["result"];
        let actual = serde_json::to_value(&result).unwrap();
        assert_eq!(
            comparable_content(&actual["content"]),
            comparable_content(&expected["content"]),
            "{name}: content"
        );
        for key in ["finishReason", "usage", "providerMetadata", "warnings"] {
            assert_eq!(
                js_stringify(&actual[key]),
                js_stringify(&expected[key]),
                "{name}: {key}"
            );
        }
        assert_eq!(
            js_stringify(&actual["response"]),
            js_stringify(&expected["response"]),
            "{name}: response"
        );
    }
}

#[tokio::test]
async fn embedding_calls_match_the_sdk() {
    let fixture = fixture();
    for case in fixture["embeddings"].as_array().unwrap() {
        if case["provider"] != "openai" {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let (fetch, captured) = fake_fetch(
            case["status"].as_u64().unwrap() as u16,
            case["statusText"].as_str().unwrap(),
            &json!({ "content-type": "application/json" }),
            case["responseBody"].as_str().unwrap(),
        );
        let settings = &case["settings"];
        let model = create_openai_with_env(
            OpenAIProviderSettings {
                api_key: settings["apiKey"].as_str().map(str::to_string),
                base_url: settings["baseURL"].as_str().map(str::to_string),
                fetch: Some(fetch),
                ..Default::default()
            },
            no_env(),
        )
        .embedding(case["modelId"].as_str().unwrap());
        assert_eq!(
            model.provider(),
            case["modelProvider"].as_str().unwrap(),
            "{name}"
        );
        let options: EmbeddingModelV4CallOptions =
            serde_json::from_value(case["options"].clone()).unwrap();
        let result = model.do_embed(options).await;

        let request = captured.lock().clone().expect("a request was sent");
        assert_eq!(request.url, case["url"].as_str().unwrap(), "{name}: url");
        assert_eq!(request.body, case["body"].as_str().unwrap(), "{name}: body");
        let headers = serde_json::to_value(&request.headers).unwrap();
        assert_eq!(
            js_stringify(&headers),
            js_stringify(&case["headers"]),
            "{name}: headers"
        );

        if let Some(expected) = case.get("error") {
            let err = result
                .err()
                .unwrap_or_else(|| panic!("{name}: the SDK failed"));
            assert_error(&err, expected, name);
            continue;
        }
        let actual = serde_json::to_value(result.unwrap()).unwrap();
        let expected = &case["result"];
        assert_eq!(
            js_stringify(&actual["embeddings"]),
            js_stringify(&expected["embeddings"]),
            "{name}"
        );
        assert_eq!(actual.get("usage"), expected.get("usage"), "{name}: usage");
        assert_eq!(
            js_stringify(&actual["response"]),
            js_stringify(&expected["response"]),
            "{name}: response"
        );
    }
}

#[tokio::test]
async fn too_many_values_for_one_embedding_call_are_refused() {
    let (fetch, captured) = fake_fetch(200, "OK", &json!({}), "{}");
    let model = provider(fetch).embedding("text-embedding-3-small");
    let err = model
        .do_embed(EmbeddingModelV4CallOptions {
            values: vec!["a".to_string(); 2049],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(
        crate::ai::error_name(&err),
        "AI_TooManyEmbeddingValuesForCallError"
    );
    assert!(captured.lock().is_none());
}

#[tokio::test]
async fn a_missing_key_fails_the_call_before_it_is_sent() {
    let (fetch, captured) = fake_fetch(200, "OK", &json!({}), "{}");
    let model = create_openai_with_env(
        OpenAIProviderSettings {
            fetch: Some(fetch),
            ..Default::default()
        },
        no_env(),
    )
    .language_model("gpt-5.6-sol");
    let err = model
        .do_generate(call_options(&json!({ "prompt": [] })))
        .await
        .unwrap_err();
    assert_eq!(crate::ai::error_name(&err), "AI_LoadAPIKeyError");
    assert!(captured.lock().is_none());
}

#[tokio::test]
async fn the_key_and_base_url_fall_back_to_the_environment() {
    let (fetch, captured) = fake_fetch(200, "OK", &json!({}), "{\"output\":[]}");
    let env: EnvLookup = Arc::new(|name| match name {
        "OPENAI_API_KEY" => Some("sk-env".to_string()),
        "OPENAI_BASE_URL" => Some("https://env.example/v1/".to_string()),
        _ => None,
    });
    let model = create_openai_with_env(
        OpenAIProviderSettings {
            fetch: Some(fetch),
            ..Default::default()
        },
        env,
    )
    .language_model("gpt-5.6-sol");
    model
        .do_generate(call_options(&json!({ "prompt": [] })))
        .await
        .unwrap();
    let request = captured.lock().clone().unwrap();
    assert_eq!(request.url, "https://env.example/v1/responses");
    assert_eq!(request.headers["authorization"], "Bearer sk-env");
}

#[tokio::test]
async fn a_blank_base_url_fails_every_call() {
    let (fetch, _) = fake_fetch(200, "OK", &json!({}), "{}");
    let model = create_openai_with_env(
        OpenAIProviderSettings {
            api_key: Some("k".to_string()),
            base_url: Some("  ".to_string()),
            fetch: Some(fetch),
            ..Default::default()
        },
        no_env(),
    )
    .language_model("gpt-5.6-sol");
    let err = model
        .do_generate(call_options(&json!({ "prompt": [] })))
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "baseURL must be a non-empty string.");
}

#[test]
fn the_model_reads_image_and_pdf_urls_itself() {
    let (fetch, _) = fake_fetch(200, "OK", &json!({}), "{}");
    let model = provider(fetch).language_model("gpt-5.6-sol");
    let urls = model.supported_urls();
    assert!(crate::ai::prompt::is_url_supported(
        "https://x/a.png",
        "image/png",
        &urls
    ));
    assert!(crate::ai::prompt::is_url_supported(
        "https://x/a.pdf",
        "application/pdf",
        &urls
    ));
    assert!(!crate::ai::prompt::is_url_supported(
        "https://x/a.txt",
        "text/plain",
        &urls
    ));
}
