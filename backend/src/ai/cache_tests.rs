use async_trait::async_trait;
use bytes::Bytes;
use serde_json::json;

use super::*;
use crate::ai::provider::{
    DataContent, FileData, FinishReason, LanguageModelV4Content, LanguageModelV4FinishReason,
    LanguageModelV4FunctionTool, LanguageModelV4Message, LanguageModelV4Part,
    LanguageModelV4ProviderTool, LanguageModelV4ResponseFormat, LanguageModelV4Tool,
    LanguageModelV4ToolChoice, LanguageModelV4Usage, ToolInputExample,
};

const GOLDEN: &str = include_str!("testdata/sdk_golden.json");

fn user_text(text: &str) -> LanguageModelV4Message {
    LanguageModelV4Message::User {
        content: vec![LanguageModelV4Part::Text {
            text: text.into(),
            provider_options: None,
        }],
        provider_options: None,
    }
}

/// The call options `probe3.mjs` keyed with `callKey`, built the way the runtime builds them.
fn plain_calls() -> Vec<LanguageModelV4CallOptions> {
    let first = LanguageModelV4CallOptions {
        prompt: vec![user_text("hi")],
        tool_choice: Some(LanguageModelV4ToolChoice::Auto),
        max_output_tokens: Some(16),
        temperature: Some(0.0),
        ..Default::default()
    };
    let second = LanguageModelV4CallOptions {
        response_format: Some(LanguageModelV4ResponseFormat::Json {
            schema: Some(json!({
                "type": "object",
                "properties": { "action": { "type": "string", "enum": ["respond", "no_reply"] } },
                "required": ["action"],
                "additionalProperties": false,
                "$schema": "http://json-schema.org/draft-07/schema#"
            })),
            name: Some("tool_risk_decision".into()),
            description: None,
        }),
        prompt: vec![
            LanguageModelV4Message::System {
                content: "judge".into(),
                provider_options: None,
            },
            user_text("{\"a\":\"ü \\\" \u{1} ✓\"}"),
        ],
        provider_options: json!({ "openai": { "reasoningEffort": "none" } })
            .as_object()
            .cloned(),
        max_output_tokens: Some(400),
        temperature: Some(0.000001),
        top_p: Some(1e-7),
        ..Default::default()
    };
    let third = LanguageModelV4CallOptions {
        prompt: vec![LanguageModelV4Message::User {
            content: vec![
                LanguageModelV4Part::File {
                    filename: None,
                    data: FileData::Data {
                        data: DataContent::Bytes(Bytes::from_static(&[1, 2, 3, 255])),
                    },
                    media_type: "image/png".into(),
                    provider_options: None,
                },
                LanguageModelV4Part::File {
                    filename: None,
                    data: FileData::Url {
                        url: url::Url::parse("https://example.com/a b.png")
                            .unwrap()
                            .to_string(),
                        original_url: None,
                    },
                    media_type: "image/png".into(),
                    provider_options: None,
                },
            ],
            provider_options: None,
        }],
        tools: Some(vec![
            LanguageModelV4Tool::Function(LanguageModelV4FunctionTool {
                name: "b".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "x": { "type": "integer", "minimum": -9007199254740991i64, "maximum": 9007199254740991i64 } }
                }),
                description: Some("d".into()),
                input_examples: Some(vec![ToolInputExample {
                    input: json!({ "x": 1 }),
                }]),
                provider_options: None,
                strict: Some(false),
            }),
            LanguageModelV4Tool::Provider(LanguageModelV4ProviderTool {
                name: "search".into(),
                id: crate::ai::providers::openai::tools::TOOL_SEARCH_ID.into(),
                args: json!({ "execution": "client" })
                    .as_object()
                    .cloned()
                    .unwrap(),
            }),
        ]),
        tool_choice: Some(LanguageModelV4ToolChoice::Tool {
            tool_name: "b".into(),
        }),
        seed: Some(42),
        stop_sequences: Some(vec!["\n\n".into()]),
        headers: Some(
            [("user-agent".to_string(), "ai/7.0.137".to_string())]
                .into_iter()
                .collect(),
        ),
        ..Default::default()
    };
    vec![first, second, third]
}

#[test]
fn derives_the_same_keys_as_agentic_evals() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for (i, call) in plain_calls().iter().enumerate() {
        let (key, bindings) = call_key(call, &[]).unwrap();
        assert_eq!(
            key,
            golden["plainKeys"][i].as_str().unwrap(),
            "key of call {i}"
        );
        assert!(bindings.is_empty());
    }
}

#[test]
fn reads_the_e2e_variables() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let variables = parse_variables(&golden["variables"].to_string()).unwrap();
    let names: Vec<&str> = variables.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, vec!["date", "time", "tmp", "uuid"]);
    let (text, bindings) = bind_variables(
        "Today's date (UTC): 2026-11-06 (Friday) at 2026-11-06T10:00:00.000Z, 11/6/2026, 10:00:00 AM, Nov 6, 2026, 10:00 AM GMT+2 in /tmp/x.y_z and /tmp/x.y_z",
        &variables,
    );
    assert_eq!(
        text,
        "Today's date (UTC): «date:1» at «time:1», «time:2», «time:3» in «tmp:1» and «tmp:1»"
    );
    assert_eq!(bindings.len(), 5);
    assert!(from_placeholders(&text, &bindings).contains("2026-11-06T10:00:00.000Z"));
}

#[test]
fn replaces_the_longest_value_first() {
    let bindings: Bindings = vec![
        ("ab".into(), "«x:1»".into()),
        ("abc".into(), "«x:2»".into()),
    ];
    assert_eq!(to_placeholders("abc ab", &bindings), "«x:2» «x:1»");
    assert_eq!(from_placeholders("«x:2» «x:1»", &bindings), "abc ab");
}

#[test]
fn turns_javascript_patterns_into_rust_ones() {
    assert_eq!(js_regex_source(r"\/tmp\/[\w.-]+"), "/tmp/[A-Za-z0-9_.-]+");
    assert_eq!(js_regex_source(r"\d{4}-\d{2}"), "[0-9]{4}-[0-9]{2}");
    assert_eq!(parse_mode(None).unwrap(), CacheMode::Record);
    assert_eq!(parse_mode(Some("replay")).unwrap(), CacheMode::Replay);
    assert_eq!(
        parse_mode(Some("nope")).unwrap_err().to_string(),
        "agentic-evals: unknown cache mode \"nope\". Use one of: record, replay, off."
    );
}

struct Echo {
    calls: parking_lot::Mutex<usize>,
}

#[async_trait]
impl LanguageModel for Echo {
    fn provider(&self) -> &str {
        "amazon-bedrock"
    }

    fn model_id(&self) -> &str {
        "global.anthropic.claude:x"
    }

    async fn do_generate(
        &self,
        _options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        *self.calls.lock() += 1;
        Ok(LanguageModelV4GenerateResult {
            content: vec![LanguageModelV4Content::Text {
                text: "thread 0f8fad5b-d9cb-469f-a165-70867728950e".into(),
                provider_metadata: None,
            }],
            finish_reason: LanguageModelV4FinishReason {
                unified: FinishReason::Stop,
                raw: Some("end_turn".into()),
            },
            usage: LanguageModelV4Usage::default(),
            provider_metadata: None,
            request: Some(crate::ai::provider::LanguageModelV4Request {
                body: Some(json!({ "big": true })),
            }),
            response: Some(crate::ai::provider::LanguageModelV4Response {
                id: Some("msg_1".into()),
                timestamp: Some(crate::support::from_ms(1_700_000_000_000)),
                model_id: Some("m".into()),
                headers: Some([("x".to_string(), "y".to_string())].into_iter().collect()),
                body: Some(json!({ "raw": 1 })),
            }),
            warnings: vec![],
        })
    }
}

fn call_with(uuid: &str) -> LanguageModelV4CallOptions {
    LanguageModelV4CallOptions {
        prompt: vec![user_text(&format!("thread {uuid}"))],
        ..Default::default()
    }
}

#[tokio::test]
async fn records_a_miss_and_replays_it_with_this_run_s_values() {
    let dir = tempfile::tempdir().unwrap();
    let variables = parse_variables(
        r#"{"uuid":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"}"#,
    )
    .unwrap();
    let middleware = Arc::new(CacheMiddleware::new(
        dir.path().to_path_buf(),
        CacheMode::Record,
        variables,
    ));
    let echo = Arc::new(Echo {
        calls: parking_lot::Mutex::new(0),
    });
    let model = wrap_language_model(WrapLanguageModelOptions {
        model: echo.clone(),
        middleware: middleware.clone() as Arc<dyn LanguageModelMiddleware>,
    });
    let before = cache_stats();

    let first = model
        .do_generate(call_with("0f8fad5b-d9cb-469f-a165-70867728950e"))
        .await
        .unwrap();
    assert_eq!(*echo.calls.lock(), 1);
    assert!(first.request.is_none());
    assert_eq!(
        first.response.as_ref().unwrap().id.as_deref(),
        Some("msg_1")
    );
    assert!(first.response.as_ref().unwrap().headers.is_none());

    let (key, _) = call_key(
        &call_with("0f8fad5b-d9cb-469f-a165-70867728950e"),
        &middleware.variables,
    )
    .unwrap();
    let file = dir
        .path()
        .join("amazon-bedrock")
        .join("global.anthropic.claude_x")
        .join(format!("{key}.json"));
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored["result"]["content"][0]["text"], "thread «uuid:1»");
    assert_eq!(
        stored["result"]["response"],
        json!({ "id": "msg_1", "timestamp": "2023-11-14T22:13:20.000Z", "modelId": "m" })
    );
    assert!(stored["result"].get("request").is_none());
    assert!(stored["timestamp"].is_i64() && stored["durationMs"].is_i64());
    assert!(std::fs::read_to_string(&file).unwrap().ends_with("}\n"));

    let replayed = model
        .do_generate(call_with("11111111-2222-3333-4444-555555555555"))
        .await
        .unwrap();
    assert_eq!(
        *echo.calls.lock(),
        1,
        "a call that differs only in a variable is a hit"
    );
    match &replayed.content[0] {
        LanguageModelV4Content::Text { text, .. } => {
            assert_eq!(text, "thread 11111111-2222-3333-4444-555555555555")
        }
        other => panic!("unexpected content {other:?}"),
    }
    let after = cache_stats();
    assert!(after.hits > before.hits && after.misses > before.misses);
}

#[tokio::test]
async fn refuses_a_miss_in_replay_mode() {
    let dir = tempfile::tempdir().unwrap();
    let middleware = Arc::new(CacheMiddleware::new(
        dir.path().to_path_buf(),
        CacheMode::Replay,
        Vec::new(),
    ));
    let echo = Arc::new(Echo {
        calls: parking_lot::Mutex::new(0),
    });
    let model = wrap_language_model(WrapLanguageModelOptions {
        model: echo.clone(),
        middleware: middleware as Arc<dyn LanguageModelMiddleware>,
    });
    let err = model.do_generate(call_with("x")).await.unwrap_err();
    assert!(err.to_string().starts_with(
        "agentic-evals: no cached response for amazon-bedrock/global.anthropic.claude:x (key "
    ));
    assert_eq!(*echo.calls.lock(), 0);
}

#[tokio::test]
async fn prunes_the_oldest_entries_past_the_size_limit() {
    let dir = tempfile::tempdir().unwrap();
    let cache = FileCache::new(dir.path().to_path_buf(), 200);
    for (i, key) in ["a", "b", "c"].iter().enumerate() {
        cache
            .set(
                key,
                &json!({ "timestamp": i, "durationMs": 0, "result": "x".repeat(60) }),
            )
            .await
            .unwrap();
    }
    assert!(cache.get("a").await.unwrap().is_none());
    assert!(cache.get("c").await.unwrap().is_some());
}
