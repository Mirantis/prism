//! A model server that answers the Anthropic Messages API at once, so a benchmark
//! measures the runtime and not the model.
//!
//! Every request gets an immediate reply:
//! - a request that forces a tool (`tool_choice.type == "tool"`) gets that tool,
//!   with an input built from its schema (structured output and the gates);
//! - a conversation whose newest user text contains `BENCH_TOOL` and holds no tool
//!   result yet gets a `list_scheduled_tasks` call;
//! - every other request gets the text `ok`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::{Json, Router, extract::State, routing::post};
use serde_json::{Value, json};

#[derive(Default)]
pub struct MockStats {
    pub requests: AtomicU64,
    pub request_bytes: AtomicU64,
}

pub async fn serve(port: u16) -> anyhow::Result<(SocketAddr, Arc<MockStats>)> {
    let stats = Arc::new(MockStats::default());
    let app = Router::new()
        .route("/v1/messages", post(messages))
        .with_state(stats.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((addr, stats))
}

async fn messages(State(stats): State<Arc<MockStats>>, body: String) -> Json<Value> {
    stats.requests.fetch_add(1, Ordering::Relaxed);
    stats
        .request_bytes
        .fetch_add(body.len() as u64, Ordering::Relaxed);
    let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let model = request["model"].as_str().unwrap_or("mock").to_string();
    let input_tokens = (body.len() / 4) as u64;

    if request["tool_choice"]["type"] == "tool" {
        let name = request["tool_choice"]["name"].as_str().unwrap_or_default();
        let schema = request["tools"]
            .as_array()
            .and_then(|tools| tools.iter().find(|t| t["name"] == name))
            .map(|t| t["input_schema"].clone())
            .unwrap_or(Value::Null);
        return Json(reply(
            &model,
            vec![tool_use(name, sample(&schema))],
            "tool_use",
            input_tokens,
        ));
    }

    let messages = request["messages"].as_array().cloned().unwrap_or_default();
    let has_tool_result = messages.iter().any(|m| {
        m["content"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|p| p["type"] == "tool_result"))
    });
    let last_user_text = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .map(text_of)
        .unwrap_or_default();
    let has_tool = |name: &str| {
        request["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|t| t["name"] == name))
    };
    if last_user_text.contains("BENCH_TOOL") && !has_tool_result && has_tool("list_scheduled_tasks")
    {
        return Json(reply(
            &model,
            vec![tool_use("list_scheduled_tasks", json!({}))],
            "tool_use",
            input_tokens,
        ));
    }
    Json(reply(
        &model,
        vec![json!({ "type": "text", "text": "ok" })],
        "end_turn",
        input_tokens,
    ))
}

fn text_of(message: &Value) -> String {
    match &message["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tool_use(name: &str, input: Value) -> Value {
    json!({
        "type": "tool_use",
        "id": format!("toolu_{}", uuid::Uuid::new_v4().simple()),
        "name": name,
        "input": input,
    })
}

fn reply(model: &str, content: Vec<Value>, stop_reason: &str, input_tokens: u64) -> Value {
    json!({
        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": 4,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    })
}

/// A value that satisfies a JSON Schema's required properties.
fn sample(schema: &Value) -> Value {
    if let Some(values) = schema["enum"].as_array() {
        return values.first().cloned().unwrap_or(Value::Null);
    }
    if let Some(any_of) = schema["anyOf"]
        .as_array()
        .or_else(|| schema["oneOf"].as_array())
    {
        return any_of.first().map(sample).unwrap_or(Value::Null);
    }
    match schema["type"].as_str() {
        Some("object") => {
            let mut out = serde_json::Map::new();
            let required: Vec<&str> = schema["required"]
                .as_array()
                .map(|r| r.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if let Some(props) = schema["properties"].as_object() {
                for (key, prop) in props {
                    if required.contains(&key.as_str()) {
                        out.insert(key.clone(), sample(prop));
                    }
                }
            }
            Value::Object(out)
        }
        Some("array") => json!([]),
        Some("string") => json!("ok"),
        Some("boolean") => json!(false),
        Some("integer") | Some("number") => json!(0),
        _ => json!({}),
    }
}
