//! What the ChatGPT subscription provider sends and returns, against responses
//! recorded on a ChatGPT subscription.

use std::sync::Arc;

use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::chatgpt_provider;
use crate::ai::providers::openai::api::{FetchFunction, FetchResponse};
use crate::ai::{
    GenerateTextOptions, GenerateTextResult, Prompt, Tool, ToolSet, execute_fn, generate_text,
    json_schema, step_count_is, tool,
};

// A gpt-6.2-sol stream recorded on a ChatGPT subscription, account identifiers replaced.
const RECORDED_STREAM: &str = include_str!("fixtures/tool-call-stream.sse");

// Two steps of one gpt-6.2-sol turn: reasoning and a tool call, then the answer.
const REASONING_STEP: &str = include_str!("fixtures/reasoning-tool-call-stream.sse");
const ANSWER_STEP: &str = include_str!("fixtures/reasoning-answer-stream.sse");

fn add(execute: bool) -> ToolSet {
    let mut definition = Tool {
        description: Some("add two numbers".into()),
        input_schema: json_schema(json!({
            "type": "object",
            "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
            "required": ["a", "b"],
        })),
        ..Default::default()
    };
    if execute {
        definition.execute = Some(execute_fn(|input, _| async move {
            let sum = input["a"].as_f64().unwrap_or(0.0) + input["b"].as_f64().unwrap_or(0.0);
            Ok(json!(sum.to_string()))
        }));
    }
    ToolSet::from([("add".to_string(), tool(definition))])
}

/// A `fetch` that answers the nth request with the nth body, the last body after
/// that, and records each request body.
fn answer_with(bodies: &[&str]) -> (FetchFunction, Arc<Mutex<Vec<Value>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let sink = requests.clone();
    let bodies: Vec<Bytes> = bodies.iter().map(|b| Bytes::from(b.to_string())).collect();
    let fetch: FetchFunction = Arc::new(move |request| {
        let mut sent = sink.lock();
        sent.push(serde_json::from_str(&request.body).unwrap());
        let body = bodies[sent.len().min(bodies.len()) - 1].clone();
        let response = FetchResponse {
            status: 200,
            status_text: "OK".to_string(),
            headers: [("content-type".to_string(), "text/event-stream".to_string())]
                .into_iter()
                .collect(),
            body,
        };
        Box::pin(async move { Ok(response) })
    });
    (fetch, requests)
}

async fn generate(
    fetch: FetchFunction,
    tools: ToolSet,
    configure: impl FnOnce(&mut GenerateTextOptions),
) -> anyhow::Result<GenerateTextResult> {
    let provider = chatgpt_provider("https://api.openai.com/v1", fetch);
    let mut options = GenerateTextOptions::new(provider.model("gpt-6.2-sol")?);
    options.prompt = Some(Prompt::Text("hi".into()));
    options.tools = Some(tools);
    configure(&mut options);
    generate_text(options).await
}

// The API answers 400 "Store must be set to false" and "Stream must be set to
// true" to a subscription token that asks otherwise.
#[tokio::test]
async fn sends_a_non_streaming_call_as_a_stream_with_store_false() {
    let (fetch, requests) = answer_with(&[RECORDED_STREAM]);

    generate(fetch, add(false), |_| {}).await.unwrap();

    let requests = requests.lock();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["store"], json!(false));
    assert_eq!(requests[0]["stream"], json!(true));
}

#[tokio::test]
async fn returns_the_text_and_tool_call_the_stream_carried() {
    let (fetch, _) = answer_with(&[RECORDED_STREAM]);

    let result = generate(fetch, add(false), |_| {}).await.unwrap();

    assert_eq!(result.text(), "adding");
    let calls: Vec<(String, Value)> = result
        .final_step()
        .tool_calls()
        .into_iter()
        .map(|call| (call.tool_name.clone(), call.input.clone()))
        .collect();
    assert_eq!(calls, vec![("add".to_string(), json!({ "a": 2, "b": 3 }))]);
    assert_eq!(result.finish_reason().as_str(), "tool-calls");
    assert_eq!(result.usage().total_tokens, Some(91));
}

#[tokio::test]
async fn fails_a_stream_that_closes_before_the_response_finished() {
    let truncated = &RECORDED_STREAM[..RECORDED_STREAM.find("event: response.completed").unwrap()];
    let (fetch, _) = answer_with(&[truncated]);

    let err = generate(fetch, add(false), |options| options.max_retries = Some(0))
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("before the response finished"),
        "{err}"
    );
}

#[tokio::test(start_paused = true)]
async fn retries_a_retryable_error_that_arrives_after_output_started() {
    let after_text = RECORDED_STREAM
        .find("event: response.output_text.done")
        .unwrap();
    let error = json!({
        "type": "error",
        "code": "server_error",
        "message": "The server had an error while processing your request.",
        "param": null,
        "sequence_number": 6,
    });
    let failed = format!(
        "{}event: error\ndata: {error}\n\n",
        &RECORDED_STREAM[..after_text]
    );
    let (fetch, requests) = answer_with(&[&failed, RECORDED_STREAM]);

    let result = generate(fetch, add(false), |_| {}).await.unwrap();

    assert_eq!(requests.lock().len(), 2);
    assert_eq!(result.text(), "adding");
}

// With store off, the API keeps no reasoning between steps: the next step sends it
// back encrypted, or the model reasons without it.
#[tokio::test]
async fn sends_a_steps_encrypted_reasoning_back_with_the_next_step() {
    let (fetch, requests) = answer_with(&[REASONING_STEP, ANSWER_STEP]);

    generate(fetch, add(true), |options| {
        options.stop_when = Some(vec![step_count_is(2)]);
    })
    .await
    .unwrap();

    let requests = requests.lock();
    assert_eq!(requests.len(), 2);
    let input = requests[1]["input"].as_array().unwrap();
    assert!(
        input.iter().any(|item| item["type"] == "reasoning"
            && item["encrypted_content"] == "encrypted-reasoning-example"),
        "{input:?}"
    );
}
