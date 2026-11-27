//! `prism acp`: serve the Agent Client Protocol on stdio, for an editor or any
//! other ACP client that starts this process. stdout is the protocol's alone.

mod bridge;
mod content;
mod rpc;
mod runtime;

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use self::bridge::Bridge;
use self::rpc::{Outbox, RpcError};
use self::runtime::Runtime;
use crate::app::adapter::UPDATE_REQUIRED_NOTICE;
use crate::config::load_config;
use crate::ws_client::WsEvent;

const PROTOCOL_VERSION: u64 = 1;

pub async fn run_acp_command(version: &str) -> i32 {
    let cfg = load_config();
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    let runtime = Arc::new(Runtime::connect(&cfg.http_url, version, events_tx));
    let out = Outbox::start();
    let bridge = Bridge::new(runtime.clone(), out.clone());

    {
        let bridge = bridge.clone();
        let runtime = runtime.clone();
        tokio::spawn(async move {
            while let Some(event) = events_rx.recv().await {
                if let WsEvent::Unsupported = event {
                    eprintln!("prism acp: {UPDATE_REQUIRED_NOTICE}");
                    runtime.close();
                    std::process::exit(1);
                }
                bridge.on_ws(event);
            }
        });
    }

    // The client closing stdin ends the session.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(method) = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match message.get("id").cloned() {
            Some(id) => {
                let bridge = bridge.clone();
                let out = out.clone();
                let version = version.to_string();
                tokio::spawn(async move {
                    let result = handle_request(&bridge, &method, &params, &version).await;
                    out.respond(id, result);
                });
            }
            None => {
                if method == "session/cancel"
                    && let Some(session_id) = params.get("sessionId").and_then(Value::as_str)
                {
                    bridge.cancel(session_id);
                }
            }
        }
    }
    runtime.close();
    0
}

fn param<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid_params(&format!("{name} is required")))
}

async fn handle_request(
    bridge: &Arc<Bridge>,
    method: &str,
    params: &Value,
    version: &str,
) -> Result<Value, RpcError> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "agentInfo": { "name": "prism", "title": "Prism", "version": version },
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true },
                "sessionCapabilities": { "list": {}, "resume": {} },
            },
            "authMethods": [],
        })),
        "session/new" => Ok(json!({ "sessionId": bridge.create(param(params, "cwd")?).await? })),
        "session/load" => {
            bridge.attach(param(params, "sessionId")?, true).await?;
            Ok(json!({}))
        }
        "session/resume" => {
            bridge.attach(param(params, "sessionId")?, false).await?;
            Ok(json!({}))
        }
        "session/list" => bridge.list(params.get("cwd").and_then(Value::as_str)).await,
        "session/prompt" => {
            let blocks = params
                .get("prompt")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            bridge.prompt(param(params, "sessionId")?, &blocks).await
        }
        other => Err(RpcError::method_not_found(other)),
    }
}
