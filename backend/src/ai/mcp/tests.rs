//! The client against an in-memory server, and the HTTP transports against
//! local servers. The expected wire text and tool shapes were recorded from
//! `@ai-sdk/mcp` 2.0.73 talking to the same fake server.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::event_source::EventSourceParser;
use super::*;
use crate::ai::json::js_stringify;
use crate::ai::{ToModelOutputOptions, ToolExecutionOptions, ToolType, get_error_message};

/// A server in memory: answers `initialize`, pages of `tools/list` keyed by
/// cursor, and `tools/call`; records every message the client sends.
struct FakeServer {
    sent: Mutex<Vec<Value>>,
    handlers: Mutex<Option<TransportHandlers>>,
    capabilities: Value,
    protocol_version: &'static str,
    /// `tools/list` result per cursor (`""` for the first page).
    pages: Vec<(&'static str, Value)>,
    call: Mutex<Value>,
    /// Never answers `initialize`.
    silent: bool,
    closed: AtomicBool,
}

impl FakeServer {
    fn new(list: Value, call: Value) -> Arc<Self> {
        Self::build(
            json!({ "tools": {} }),
            "2025-06-18",
            vec![("", list)],
            call,
            false,
        )
    }

    fn build(
        capabilities: Value,
        protocol_version: &'static str,
        pages: Vec<(&'static str, Value)>,
        call: Value,
        silent: bool,
    ) -> Arc<Self> {
        Arc::new(FakeServer {
            sent: Mutex::new(Vec::new()),
            handlers: Mutex::new(None),
            capabilities,
            protocol_version,
            pages,
            call: Mutex::new(call),
            silent,
            closed: AtomicBool::new(false),
        })
    }

    fn sent_text(&self) -> Vec<String> {
        self.sent.lock().iter().map(js_stringify).collect()
    }

    /// Delivers a message from the server, as a transport does after a turn of
    /// the event loop.
    fn push(&self, message: Value) {
        let handlers = self.handlers.lock().clone().unwrap();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            let _ = (handlers.on_message)(message);
        });
    }
}

#[async_trait]
impl MCPTransport for FakeServer {
    fn set_handlers(&self, handlers: TransportHandlers) {
        *self.handlers.lock() = Some(handlers);
    }

    async fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn send(&self, message: Value, _options: MCPTransportSendOptions) -> anyhow::Result<()> {
        self.sent.lock().push(message.clone());
        let Some(id) = message.get("id").cloned() else {
            return Ok(());
        };
        if message.get("method").is_none() {
            return Ok(());
        }
        let result = match message["method"].as_str().unwrap() {
            "initialize" if self.silent => return Ok(()),
            "initialize" => json!({
                "protocolVersion": self.protocol_version,
                "capabilities": self.capabilities,
                "serverInfo": { "name": "s", "version": "1" },
            }),
            "tools/list" => {
                let cursor = message["params"]["cursor"].as_str().unwrap_or("");
                self.pages
                    .iter()
                    .find(|(c, _)| *c == cursor)
                    .map(|(_, page)| page.clone())
                    .unwrap()
            }
            "tools/call" => {
                let call = self.call.lock().clone();
                if call.is_null() {
                    return Ok(());
                }
                if call.get("error").is_some() {
                    self.push(json!({ "jsonrpc": "2.0", "id": id, "error": call["error"] }));
                    return Ok(());
                }
                call
            }
            _ => return Ok(()),
        };
        self.push(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        Ok(())
    }

    async fn close(&self, _options: MCPTransportCloseOptions) -> anyhow::Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        let handlers = self.handlers.lock().clone();
        if let Some(handlers) = handlers {
            (handlers.on_close)();
        }
        Ok(())
    }
}

async fn connect(server: &Arc<FakeServer>) -> MCPClient {
    let mut config = MCPClientConfig::new(MCPTransportConfig::Custom(server.clone()));
    config.client_name = Some("prism-agent".into());
    create_mcp_client(config).await.unwrap()
}

async fn run(tool: &crate::ai::Tool, input: Value) -> anyhow::Result<Value> {
    (tool.execute.as_ref().unwrap())(input, ToolExecutionOptions::default()).await
}

async fn model_output(tool: &crate::ai::Tool, output: Value) -> Value {
    let convert = tool.to_model_output.as_ref().unwrap();
    let converted = convert(ToModelOutputOptions {
        tool_call_id: "c1".into(),
        input: json!({ "a": 1 }),
        output,
    })
    .await
    .unwrap();
    serde_json::to_value(converted).unwrap()
}

#[tokio::test]
async fn sends_the_handshake_listing_and_call_as_the_sdk_does() {
    let server = FakeServer::new(
        json!({ "tools": [{
            "x": 1,
            "description": "d",
            "name": "t1",
            "inputSchema": {
                "required": ["a"],
                "properties": { "a": { "type": "number" } },
                "type": "object",
                "additionalProperties": true,
            },
        }] }),
        json!({
            "z": 2,
            "content": [
                { "type": "text", "text": "hi" },
                { "type": "image", "data": "aGk=", "mimeType": "image/png" },
                { "type": "resource_link", "name": "n", "uri": "u", "extra": 1 },
            ],
            "_meta": { "k": 1 },
        }),
    );
    let client = connect(&server).await;
    let tools = client.tools().await.unwrap();
    let tool = &tools["t1"];

    assert_eq!(tool.tool_type, ToolType::Dynamic);
    assert_eq!(tool.description.as_deref(), Some("d"));
    assert_eq!(tool.title, None);
    assert_eq!(
        js_stringify(&Value::Object(tool.metadata.clone().unwrap())),
        r#"{"clientName":"prism-agent","toolName":"t1"}"#
    );
    assert_eq!(
        js_stringify(tool.input_schema.json_schema()),
        r#"{"type":"object","properties":{"a":{"type":"number"}},"required":["a"],"additionalProperties":false}"#
    );

    let output = run(tool, json!({ "a": 1 })).await.unwrap();
    assert_eq!(
        js_stringify(&output),
        r#"{"_meta":{"k":1},"content":[{"type":"text","text":"hi"},{"type":"image","data":"aGk=","mimeType":"image/png"},{"type":"resource_link","uri":"u","name":"n","extra":1}],"isError":false,"z":2}"#
    );
    assert_eq!(
        model_output(tool, output).await,
        json!({
            "type": "content",
            "value": [
                { "type": "text", "text": "hi" },
                { "type": "file", "mediaType": "image/png", "data": { "type": "data", "data": "aGk=" } },
                { "type": "text", "text": "{\"type\":\"resource_link\",\"uri\":\"u\",\"name\":\"n\",\"extra\":1}" },
            ],
        })
    );

    assert_eq!(
        server.sent_text(),
        vec![
            r#"{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"prism-agent","version":"1.0.0"}},"jsonrpc":"2.0","id":0}"#,
            r#"{"method":"notifications/initialized","jsonrpc":"2.0"}"#,
            r#"{"method":"tools/list","jsonrpc":"2.0","id":1}"#,
            r#"{"method":"tools/call","params":{"name":"t1","arguments":{"a":1}},"jsonrpc":"2.0","id":2}"#,
        ]
    );
}

#[tokio::test]
async fn takes_the_title_and_annotations_into_the_metadata() {
    let server = FakeServer::new(
        json!({ "tools": [{
            "name": "t1",
            "title": "T",
            "annotations": { "readOnlyHint": true, "title": "AT", "foo": 1 },
            "_meta": { "m": 1 },
            "inputSchema": { "$schema": "x" },
        }] }),
        json!({ "structuredContent": { "b": 2, "a": 1 } }),
    );
    let client = connect(&server).await;
    let tools = client.tools().await.unwrap();
    let tool = &tools["t1"];

    assert_eq!(tool.title.as_deref(), Some("T"));
    assert_eq!(
        js_stringify(&Value::Object(tool.metadata.clone().unwrap())),
        r#"{"clientName":"prism-agent","toolName":"t1","title":"T","annotations":{"title":"AT","readOnlyHint":true}}"#
    );
    assert_eq!(
        js_stringify(tool.input_schema.json_schema()),
        r#"{"$schema":"x","properties":{},"additionalProperties":false}"#
    );

    let output = run(tool, json!({ "a": 1 })).await.unwrap();
    assert_eq!(
        js_stringify(&output),
        r#"{"content":[{"type":"text","text":"{\"b\":2,\"a\":1}"}],"structuredContent":{"b":2,"a":1},"isError":false}"#
    );
}

#[tokio::test]
async fn returns_a_legacy_tool_result_and_an_error_result_as_the_server_sent_them() {
    let server = FakeServer::new(
        json!({ "tools": [{ "name": "t1", "inputSchema": { "type": "object" } }] }),
        json!({ "toolResult": { "q": 1 } }),
    );
    let client = connect(&server).await;
    let tools = client.tools().await.unwrap();
    let tool = &tools["t1"];

    let output = run(tool, json!({})).await.unwrap();
    assert_eq!(js_stringify(&output), r#"{"toolResult":{"q":1}}"#);
    assert_eq!(
        model_output(tool, output).await,
        json!({ "type": "json", "value": { "toolResult": { "q": 1 } } })
    );

    *server.call.lock() = json!({ "content": [{ "type": "audio", "data": "x" }], "isError": true });
    let output = run(tool, json!({})).await.unwrap();
    assert_eq!(
        js_stringify(&output),
        r#"{"content":[{"type":"audio","data":"x"}],"isError":true}"#
    );
    assert_eq!(
        model_output(tool, output).await,
        json!({ "type": "content", "value": [{ "type": "text", "text": "{\"type\":\"audio\",\"data\":\"x\"}" }] })
    );
}

#[tokio::test]
async fn lists_every_page_of_tools() {
    let server = FakeServer::build(
        json!({ "tools": {} }),
        "2025-06-18",
        vec![
            (
                "",
                json!({ "tools": [{ "name": "a", "inputSchema": {} }], "nextCursor": "p2" }),
            ),
            (
                "p2",
                json!({ "tools": [{ "name": "b", "inputSchema": {} }] }),
            ),
        ],
        json!({}),
        false,
    );
    let client = connect(&server).await;

    let tools = client.tools().await.unwrap();

    assert_eq!(tools.keys().collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(
        server.sent_text()[3],
        r#"{"method":"tools/list","params":{"cursor":"p2"},"jsonrpc":"2.0","id":2}"#
    );
}

#[tokio::test]
async fn fails_a_call_with_the_servers_json_rpc_error() {
    let server = FakeServer::new(
        json!({ "tools": [{ "name": "t1", "inputSchema": {} }] }),
        json!({ "error": { "code": -32602, "message": "bad arguments" } }),
    );
    let client = connect(&server).await;
    let tools = client.tools().await.unwrap();

    let error = run(&tools["t1"], json!({})).await.unwrap_err();

    assert_eq!(
        error.downcast_ref::<MCPClientError>().unwrap().code,
        Some(-32602)
    );
    assert_eq!(get_error_message(&error), "MCPClientError: bad arguments");
}

#[tokio::test]
async fn refuses_to_list_tools_on_a_server_without_them() {
    let server = FakeServer::build(json!({}), "2025-06-18", vec![], json!({}), false);
    let client = connect(&server).await;

    let error = client.tools().await.unwrap_err();

    assert_eq!(error.to_string(), "Server does not support tools");
}

#[tokio::test]
async fn refuses_a_protocol_version_it_does_not_support_and_closes_the_transport() {
    let server = FakeServer::build(
        json!({ "tools": {} }),
        "1999-01-01",
        vec![],
        json!({}),
        false,
    );
    let config = MCPClientConfig::new(MCPTransportConfig::Custom(server.clone()));

    let error = create_mcp_client(config).await.unwrap_err();

    assert_eq!(
        error.to_string(),
        "Server's protocol version is not supported: 1999-01-01"
    );
    assert!(server.closed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn times_out_an_initialization_the_server_never_answers() {
    let server = FakeServer::build(
        json!({ "tools": {} }),
        "2025-06-18",
        vec![],
        json!({}),
        true,
    );
    let mut config = MCPClientConfig::new(MCPTransportConfig::Custom(server.clone()));
    config.initialization_options = Some(RequestOptions {
        timeout: Some(50),
        ..RequestOptions::default()
    });

    let error = create_mcp_client(config).await.unwrap_err();

    assert_eq!(
        error.to_string(),
        "MCP client initialization timed out after 50ms"
    );
}

#[tokio::test]
async fn fails_waiting_requests_when_the_client_closes() {
    // `null` makes the server leave every call unanswered.
    let server = FakeServer::new(json!({ "tools": [] }), Value::Null);
    let client = connect(&server).await;
    let pending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_tool("t", json!({}), RequestOptions::default())
                .await
        }
    });
    while server.sent.lock().len() < 3 {
        tokio::task::yield_now().await;
    }

    client.close().await.unwrap();

    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.to_string(), "Connection closed");
    let after = client
        .call_tool("t", json!({}), RequestOptions::default())
        .await
        .unwrap_err();
    assert_eq!(
        after.to_string(),
        "Attempted to send a request from a closed client"
    );
}

#[tokio::test]
async fn aborts_a_call_whose_signal_fires() {
    let server = FakeServer::new(json!({ "tools": [] }), json!({}));
    let client = connect(&server).await;
    let signal = CancellationToken::new();
    signal.cancel();

    let error = client
        .call_tool(
            "t",
            json!({}),
            RequestOptions {
                signal: Some(signal),
                ..RequestOptions::default()
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.to_string(), "This operation was aborted");
}

#[tokio::test]
async fn answers_a_ping_and_reports_a_server_notification() {
    let server = FakeServer::new(json!({ "tools": [] }), json!({}));
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut config = MCPClientConfig::new(MCPTransportConfig::Custom(server.clone()));
    config.on_uncaught_error = Some(Arc::new({
        let reported = reported.clone();
        move |error: &anyhow::Error| reported.lock().push(error.to_string())
    }));
    let _client = create_mcp_client(config).await.unwrap();

    server.push(json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }));
    server.push(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }));
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }

    assert!(
        server
            .sent_text()
            .contains(&r#"{"jsonrpc":"2.0","id":7,"result":{}}"#.to_string())
    );
    assert_eq!(
        *reported.lock(),
        vec!["Unsupported message type".to_string()]
    );
}

#[test]
fn parses_server_sent_events_across_chunks() {
    let mut parser = EventSourceParser::new();
    let mut events = parser.feed(b"\xEF\xBB\xBFevent: endpoint\r");
    events.extend(parser.feed(b"\ndata: /messages?x=1\r\n\r\n: comment\nid: 4\ndata: a\ndata:b\n"));
    events.extend(parser.feed(b"\nevent:message\ndata: {\"x\":\"\xC3"));
    events.extend(parser.feed(b"\xA9\"}\n\ndata: unfinished"));

    assert_eq!(
        events,
        vec![
            EventSourceMessage {
                id: None,
                event: Some("endpoint".into()),
                data: "/messages?x=1".into(),
            },
            EventSourceMessage {
                id: Some("4".into()),
                event: None,
                data: "a\nb".into(),
            },
            EventSourceMessage {
                id: None,
                event: Some("message".into()),
                data: "{\"x\":\"é\"}".into(),
            },
        ]
    );
}

#[test]
fn encodes_a_header_value_that_is_not_plain_ascii() {
    assert_eq!(encode_mcp_header_value("read_file"), "read_file");
    assert_eq!(
        encode_mcp_header_value(" padded"),
        "=?base64?IHBhZGRlZA==?="
    );
    assert_eq!(encode_mcp_header_value("é"), "=?base64?w6k=?=");
}

#[test]
fn checks_json_rpc_messages_as_the_schema_does() {
    assert!(validate_jsonrpc_message(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).is_ok());
    assert!(
        validate_jsonrpc_message(json!({ "jsonrpc": "2.0", "id": 1.5, "result": {} })).is_err()
    );
    assert!(
        validate_jsonrpc_message(json!({ "jsonrpc": "2.0", "id": 1, "result": {}, "extra": 1 }))
            .is_err()
    );
    let error = validate_jsonrpc_message(json!({
        "jsonrpc": "2.0",
        "error": { "code": -1, "message": "m", "extra": true },
    }))
    .unwrap();
    assert_eq!(
        js_stringify(&error),
        r#"{"jsonrpc":"2.0","error":{"code":-1,"message":"m"}}"#
    );
}

mod http {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post};
    use std::time::Duration;

    /// A server speaking the stateless protocol: it answers `server/discover`,
    /// streams each response as server-sent events, and records request headers.
    #[derive(Default)]
    struct Stateless {
        headers: Mutex<Vec<(String, Option<String>, Option<String>)>>,
        bodies: Mutex<Vec<Value>>,
    }

    async fn stateless(
        State(server): State<Arc<Stateless>>,
        headers: HeaderMap,
        body: String,
    ) -> Response {
        let message: Value = serde_json::from_str(&body).unwrap();
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        server.headers.lock().push((
            header("mcp-protocol-version").unwrap_or_default(),
            header("mcp-method"),
            header("mcp-session-id"),
        ));
        server.bodies.lock().push(message.clone());
        let result = match message["method"].as_str().unwrap_or_default() {
            "server/discover" => json!({
                "resultType": "complete",
                "supportedVersions": [LATEST_PROTOCOL_VERSION],
                "capabilities": { "tools": {} },
            }),
            "tools/list" => json!({
                "resultType": "complete",
                "tools": [{ "name": "echo", "inputSchema": { "type": "object" } }],
            }),
            "tools/call" => json!({
                "resultType": "complete",
                "content": [{ "type": "text", "text": "echoed" }],
            }),
            _ => return StatusCode::ACCEPTED.into_response(),
        };
        let event = format!(
            "event: message\ndata: {}\n\n",
            json!({ "jsonrpc": "2.0", "id": message["id"], "result": result })
        );
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(event))
            .unwrap()
    }

    async fn listen(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn speaks_the_stateless_protocol_to_a_server_that_discovers() {
        let server = Arc::new(Stateless::default());
        let base = listen(
            Router::new()
                .route("/mcp", post(stateless))
                .with_state(server.clone()),
        )
        .await;
        let mut config = MCPClientConfig::new(MCPTransportConfig::Http {
            url: format!("{base}/mcp"),
            headers: None,
        });
        config.client_name = Some("prism-agent".into());
        let client = create_mcp_client(config).await.unwrap();
        let tools = client.tools().await.unwrap();

        let output = run(&tools["echo"], json!({})).await.unwrap();

        assert_eq!(
            js_stringify(&output),
            r#"{"resultType":"complete","content":[{"type":"text","text":"echoed"}],"isError":false}"#
        );
        let headers = server.headers.lock().clone();
        assert_eq!(
            headers,
            vec![
                (
                    LATEST_PROTOCOL_VERSION.to_string(),
                    Some("server/discover".to_string()),
                    None
                ),
                (
                    LATEST_PROTOCOL_VERSION.to_string(),
                    Some("tools/list".to_string()),
                    None
                ),
                (
                    LATEST_PROTOCOL_VERSION.to_string(),
                    Some("tools/call".to_string()),
                    None
                ),
            ]
        );
        let call = server.bodies.lock()[2].clone();
        assert_eq!(
            js_stringify(&call),
            r#"{"method":"tools/call","params":{"name":"echo","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"prism-agent","version":"1.0.0"}}},"jsonrpc":"2.0","id":2}"#
        );
    }

    /// A legacy HTTP+SSE server: the GET stream names the endpoint, and every
    /// response to a POST arrives on that stream.
    #[derive(Default)]
    struct Legacy {
        stream: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
        posts: AtomicUsize,
    }

    async fn legacy_stream(State(server): State<Arc<Legacy>>) -> Response {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send("event: endpoint\ndata: /messages?session=1\n\n".to_string())
            .unwrap();
        *server.stream.lock() = Some(tx);
        let body = futures::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|chunk| (Ok::<_, std::io::Error>(chunk), rx))
        });
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(body))
            .unwrap()
    }

    async fn legacy_post(State(server): State<Arc<Legacy>>, body: String) -> StatusCode {
        server.posts.fetch_add(1, Ordering::SeqCst);
        let message: Value = serde_json::from_str(&body).unwrap();
        let result = match message["method"].as_str().unwrap_or_default() {
            "initialize" => json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "legacy", "version": "1" },
            }),
            "tools/list" => json!({ "tools": [{ "name": "old", "inputSchema": {} }] }),
            _ => return StatusCode::ACCEPTED,
        };
        let response = json!({ "jsonrpc": "2.0", "id": message["id"], "result": result });
        let stream = server.stream.lock().clone().unwrap();
        stream.send(format!("data: {response}\n\n")).unwrap();
        StatusCode::ACCEPTED
    }

    #[tokio::test]
    async fn speaks_to_a_legacy_sse_server() {
        let server = Arc::new(Legacy::default());
        let base = listen(
            Router::new()
                .route("/sse", get(legacy_stream))
                .route("/messages", post(legacy_post))
                .with_state(server.clone()),
        )
        .await;
        let config = MCPClientConfig::new(MCPTransportConfig::Sse {
            url: format!("{base}/sse"),
            headers: None,
        });
        let client = tokio::time::timeout(Duration::from_secs(5), create_mcp_client(config))
            .await
            .unwrap()
            .unwrap();

        let tools = client.tools().await.unwrap();

        assert_eq!(tools.keys().collect::<Vec<_>>(), vec!["old"]);
        assert_eq!(client.server_info()["name"], "legacy");
        assert_eq!(server.posts.load(Ordering::SeqCst), 3);
        client.close().await.unwrap();
    }
}
