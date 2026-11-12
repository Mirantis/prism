//! The provider against `testdata/anthropic_sdk.json`: what `@ai-sdk/anthropic`
//! sent and returned for the same call options, captured through a fake `fetch`
//! (`testdata/anthropic_sdk.mjs` writes the file).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::ai::json::{js_stringify, normalize_numbers};
use crate::ai::{
    ApiCallError, DataContent, FileData, LanguageModelV4CallOptions, LanguageModelV4Message,
    LanguageModelV4Part, error_name, is_abort_error,
};

const FIXTURE: &str = include_str!("../testdata/anthropic_sdk.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the fixture is JSON")
}

type Captured = Arc<Mutex<Vec<FetchRequest>>>;

/// A `fetch` that records each request and answers with `response`.
fn capturing_fetch(response: FetchResponse) -> (FetchFunction, Captured) {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let sink = captured.clone();
    let fetch: FetchFunction = Arc::new(move |request, _abort| {
        sink.lock().push(request);
        let response = response.clone();
        Box::pin(async move { Ok(response) })
    });
    (fetch, captured)
}

fn ok_response() -> FetchResponse {
    FetchResponse {
        status: 200,
        status_text: "OK".to_string(),
        headers: [("content-type".to_string(), "application/json".to_string())]
            .into_iter()
            .collect(),
        body: Bytes::from(js_stringify(&json!({
            "type": "message",
            "id": "msg_ok",
            "model": "claude-test",
            "role": "assistant",
            "content": [{ "type": "text", "text": "ok" }],
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": { "input_tokens": 1, "output_tokens": 1 },
        }))),
    }
}

/// The provider the fixture generator used: `sk-test` at `api.example.com`, ids
/// `id-0`, `id-1`, … and the case's own settings.
fn provider(settings: &Value, fetch: FetchFunction) -> AnthropicProvider {
    let next = Arc::new(AtomicUsize::new(0));
    let headers = settings
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect::<IndexMap<_, _>>()
        });
    create_anthropic(AnthropicProviderSettings {
        api_key: Some("sk-test".to_string()),
        base_url: Some("https://api.example.com/v1".to_string()),
        headers,
        fetch: Some(fetch),
        generate_id: Some(Arc::new(move || {
            format!("id-{}", next.fetch_add(1, Ordering::SeqCst))
        })),
        name: settings
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        ..Default::default()
    })
}

fn call_options(options: &Value) -> LanguageModelV4CallOptions {
    serde_json::from_value(options.clone()).expect("the fixture's call options parse")
}

fn sorted_headers(headers: &Headers) -> Value {
    let sorted: std::collections::BTreeMap<_, _> = headers.iter().collect();
    json!(sorted)
}

#[tokio::test]
async fn request_bodies_headers_and_warnings_match_the_sdk() {
    for case in fixture()["requests"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (fetch, captured) = capturing_fetch(ok_response());
        let model =
            provider(&case["settings"], fetch).language_model(case["modelId"].as_str().unwrap());
        let result = model
            .do_generate(call_options(&case["options"]))
            .await
            .unwrap_or_else(|err| panic!("{name}: {err:#}"));
        let request = captured.lock().pop().expect("one request");

        assert_eq!(request.url, case["url"].as_str().unwrap(), "{name}: url");
        assert_eq!(request.body, case["body"].as_str().unwrap(), "{name}: body");
        assert_eq!(
            sorted_headers(&request.headers),
            case["headers"],
            "{name}: headers"
        );
        assert_eq!(
            serde_json::to_value(&result.warnings).unwrap(),
            case["warnings"],
            "{name}: warnings"
        );
        let sent: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(
            result
                .request
                .and_then(|request| request.body)
                .map(normalize_numbers),
            Some(normalize_numbers(sent)),
            "{name}: the reported request body is the sent one"
        );
    }
}

#[tokio::test]
async fn responses_and_errors_match_the_sdk() {
    for case in fixture()["responses"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let headers: Headers = case["responseHeaders"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect::<std::collections::BTreeMap<_, _>>()
            .into_iter()
            .collect();
        let response = FetchResponse {
            status: case["status"].as_u64().unwrap() as u16,
            status_text: case["statusText"].as_str().unwrap().to_string(),
            headers,
            body: Bytes::from(case["responseBody"].as_str().unwrap().to_string()),
        };
        let (fetch, _) = capturing_fetch(response);
        let model = provider(&json!({}), fetch).language_model(case["modelId"].as_str().unwrap());
        let outcome = model.do_generate(call_options(&case["options"])).await;

        if let Some(expected) = case.get("error") {
            let err = outcome
                .err()
                .unwrap_or_else(|| panic!("{name}: expected an error"));
            let api = err
                .downcast_ref::<ApiCallError>()
                .unwrap_or_else(|| panic!("{name}: {err:#}"));
            assert_eq!(error_name(&err), expected["name"], "{name}: name");
            assert_eq!(api.message, expected["message"], "{name}: message");
            assert_eq!(
                api.status_code.map(u64::from),
                expected["statusCode"].as_u64(),
                "{name}"
            );
            assert_eq!(
                api.is_retryable, expected["isRetryable"],
                "{name}: isRetryable"
            );
            assert_eq!(
                api.response_body.as_deref(),
                expected["responseBody"].as_str(),
                "{name}"
            );
            assert_eq!(
                api.response_headers.as_ref().map(sorted_headers),
                Some(expected["responseHeaders"].clone()),
                "{name}: response headers"
            );
            assert_eq!(api.data.as_ref(), expected.get("data"), "{name}: data");
            assert_eq!(api.url, expected["url"].as_str().unwrap(), "{name}: url");
            continue;
        }

        let result = outcome.unwrap_or_else(|err| panic!("{name}: {err:#}"));
        let expected = &case["result"];
        let actual = normalize_numbers(serde_json::to_value(&result).unwrap());
        for key in [
            "content",
            "finishReason",
            "usage",
            "providerMetadata",
            "warnings",
        ] {
            assert_eq!(
                js_stringify(&actual[key]),
                js_stringify(&expected[key]),
                "{name}: {key}"
            );
        }
        let response = &actual["response"];
        for key in ["id", "modelId", "headers", "body"] {
            assert_eq!(
                response.get(key),
                expected["response"].get(key),
                "{name}: response.{key}"
            );
        }
    }
}

fn single_user_message(part: LanguageModelV4Part) -> LanguageModelV4CallOptions {
    LanguageModelV4CallOptions {
        max_output_tokens: Some(10),
        prompt: vec![LanguageModelV4Message::User {
            content: vec![part],
            provider_options: None,
        }],
        ..Default::default()
    }
}

#[tokio::test]
async fn bytes_and_base64_send_the_same_image_and_text() {
    let png = crate::ai::json::base64_to_bytes(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    )
    .unwrap();
    let mut bodies = Vec::new();
    for data in [
        DataContent::from(png.clone()),
        DataContent::Base64(crate::ai::json::bytes_to_base64(&png)),
    ] {
        let (fetch, captured) = capturing_fetch(ok_response());
        let model = provider(&json!({}), fetch).language_model("claude-sonnet-4-5");
        let part = LanguageModelV4Part::File {
            filename: None,
            data: FileData::Data { data },
            media_type: "image".to_string(),
            provider_options: None,
        };
        model.do_generate(single_user_message(part)).await.unwrap();
        bodies.push(captured.lock().pop().unwrap().body);
    }
    assert_eq!(bodies[0], bodies[1]);

    let (fetch, captured) = capturing_fetch(ok_response());
    let model = provider(&json!({}), fetch).language_model("claude-sonnet-4-5");
    let part = LanguageModelV4Part::File {
        filename: None,
        data: FileData::Data {
            data: DataContent::from(b"\xef\xbb\xbfhello \xff".to_vec()),
        },
        media_type: "text/plain".to_string(),
        provider_options: None,
    };
    model.do_generate(single_user_message(part)).await.unwrap();
    let body: Value = serde_json::from_str(&captured.lock().pop().unwrap().body).unwrap();
    assert_eq!(
        body["messages"][0]["content"][0]["source"]["data"],
        "hello \u{fffd}"
    );
}

#[tokio::test]
async fn a_media_type_the_api_cannot_hold_refuses_the_call() {
    let (fetch, captured) = capturing_fetch(ok_response());
    let model = provider(&json!({}), fetch).language_model("claude-sonnet-4-5");
    let part = LanguageModelV4Part::File {
        filename: None,
        data: FileData::Data {
            data: DataContent::Base64("aGk=".to_string()),
        },
        media_type: "audio/mpeg".to_string(),
        provider_options: None,
    };
    let err = model
        .do_generate(single_user_message(part))
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "'media type: audio/mpeg' functionality not supported."
    );
    assert!(captured.lock().is_empty());
}

#[tokio::test]
async fn invalid_provider_options_refuse_the_call() {
    let (fetch, _) = capturing_fetch(ok_response());
    let model = provider(&json!({}), fetch).language_model("claude-sonnet-4-5");
    let mut options = single_user_message(LanguageModelV4Part::Text {
        text: "Hi".to_string(),
        provider_options: None,
    });
    options.provider_options = Some(
        json!({ "anthropic": { "thinking": { "type": "sometimes" } } })
            .as_object()
            .cloned()
            .unwrap(),
    );
    let err = model.do_generate(options).await.unwrap_err();
    assert_eq!(err.to_string(), "invalid anthropic provider options");
    assert_eq!(error_name(&err), "AI_InvalidArgumentError");
}

#[tokio::test]
async fn a_blank_base_url_fails_every_call() {
    let anthropic = create_anthropic(AnthropicProviderSettings {
        api_key: Some("k".to_string()),
        base_url: Some("  ".to_string()),
        ..Default::default()
    });
    let err = anthropic
        .language_model("claude-opus-5")
        .do_generate(single_user_message(LanguageModelV4Part::Text {
            text: "Hi".to_string(),
            provider_options: None,
        }))
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "baseURL must be a non-empty string.");
}

#[test]
fn the_bare_api_host_gains_its_version_and_a_trailing_slash_goes() {
    let base = |url: &str| {
        create_anthropic(AnthropicProviderSettings {
            base_url: Some(url.to_string()),
            ..Default::default()
        })
        .base_url
    };
    assert_eq!(
        base("https://api.anthropic.com/"),
        "https://api.anthropic.com/v1"
    );
    assert_eq!(
        base("https://gw.example/anthropic/v1/"),
        "https://gw.example/anthropic/v1"
    );
}

#[test]
fn models_report_the_provider_and_the_urls_they_read() {
    let anthropic = create_anthropic(AnthropicProviderSettings {
        api_key: Some("k".to_string()),
        ..Default::default()
    });
    let model = anthropic.language_model("claude-opus-5");
    assert_eq!(model.provider(), "anthropic.messages");
    assert_eq!(model.model_id(), "claude-opus-5");
    let urls = model.supported_urls();
    assert_eq!(
        urls.keys().collect::<Vec<_>>(),
        ["image/*", "application/pdf"]
    );
    assert!(urls["image/*"][0].is_match("https://example.com/a.png"));
}

#[tokio::test]
async fn an_aborted_call_is_an_abort_error() {
    let token = CancellationToken::new();
    token.cancel();
    let anthropic = create_anthropic(AnthropicProviderSettings {
        api_key: Some("k".to_string()),
        base_url: Some("http://127.0.0.1:9/v1".to_string()),
        ..Default::default()
    });
    let mut options = single_user_message(LanguageModelV4Part::Text {
        text: "Hi".to_string(),
        provider_options: None,
    });
    options.abort_signal = Some(token);
    let err = anthropic
        .language_model("claude-opus-5")
        .do_generate(options)
        .await
        .unwrap_err();
    assert!(is_abort_error(&err));
}

#[tokio::test]
async fn a_refused_connection_is_a_retryable_api_call_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let anthropic = create_anthropic(AnthropicProviderSettings {
        api_key: Some("k".to_string()),
        base_url: Some(format!("http://127.0.0.1:{port}/v1")),
        ..Default::default()
    });
    let err = anthropic
        .language_model("claude-opus-5")
        .do_generate(single_user_message(LanguageModelV4Part::Text {
            text: "Hi".to_string(),
            provider_options: None,
        }))
        .await
        .unwrap_err();
    let api = err
        .downcast_ref::<ApiCallError>()
        .expect("an API call error");
    assert!(
        api.message.starts_with("Cannot connect to API: "),
        "{}",
        api.message
    );
    assert!(api.is_retryable);
    assert_eq!(api.url, format!("http://127.0.0.1:{port}/v1/messages"));
    assert_eq!(api.request_body_values["model"], "claude-opus-5");
}

/// Reads one HTTP/1.1 request: its head and its body.
async fn read_request(socket: &mut tokio::net::TcpStream) -> (String, String) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = socket.read(&mut chunk).await.unwrap();
        buffer.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&buffer).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let head = text[..end].to_string();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            if buffer.len() >= end + 4 + length {
                let body = String::from_utf8_lossy(&buffer[end + 4..end + 4 + length]).to_string();
                return (head, body);
            }
        }
        if read == 0 {
            panic!("the request ended early");
        }
    }
}

#[tokio::test]
async fn the_default_fetch_posts_the_body_with_the_provider_headers() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        let body = r#"{"type":"message","id":"msg_x","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-b: 1\r\nx-b: 2\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        request
    });

    let anthropic = create_anthropic(AnthropicProviderSettings {
        api_key: Some("sk-live".to_string()),
        base_url: Some(format!("http://127.0.0.1:{port}/v1")),
        ..Default::default()
    });
    let mut options = single_user_message(LanguageModelV4Part::Text {
        text: "Hi".to_string(),
        provider_options: None,
    });
    options.headers = Some(
        [("user-agent".to_string(), "ai/7.0.137".to_string())]
            .into_iter()
            .collect(),
    );
    let result = anthropic
        .language_model("claude-haiku-4-5")
        .do_generate(options)
        .await
        .unwrap();
    let (head, body) = server.await.unwrap();

    assert!(head.starts_with("POST /v1/messages HTTP/1.1"), "{head}");
    let lower = head.to_lowercase();
    assert!(lower.contains("\r\nx-api-key: sk-live"), "{head}");
    assert!(
        lower.contains("\r\nanthropic-version: 2023-06-01"),
        "{head}"
    );
    assert!(
        lower.contains("\r\ncontent-type: application/json"),
        "{head}"
    );
    assert!(
        lower.contains("\r\nuser-agent: ai/7.0.137 ai-sdk-provider-utils/5.0.58"),
        "{head}"
    );
    assert_eq!(
        body,
        r#"{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"Hi"}]}]}"#
    );
    let response = result.response.unwrap();
    assert_eq!(response.headers.unwrap()["x-b"], "1, 2");
    assert_eq!(response.id.as_deref(), Some("msg_x"));
}

#[test]
fn model_families_resolve_to_their_capabilities() {
    let caps = get_model_capabilities("us.anthropic.claude-opus-5-5-v1:0");
    assert!(
        caps.is_known_model
            && caps.rejects_forced_tool_use
            && !caps.supports_between_tools_thinking
    );
    assert_eq!(
        get_model_capabilities("claude-sonnet-4@20250514").max_output_tokens,
        64000
    );
    assert_eq!(
        get_model_capabilities("claude-opus-4-20250514").max_output_tokens,
        32000
    );
    let legacy = get_model_capabilities("claude-2.1");
    assert!(!legacy.is_known_model);
    assert_eq!(legacy.max_output_tokens, 4096);
    let newer = get_model_capabilities("claude-opus-9");
    assert!(!newer.is_known_model);
    assert_eq!(newer.max_output_tokens, 128000);
    assert_eq!(get_model_capabilities("gpt-5").max_output_tokens, 4096);
}
