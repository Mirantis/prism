//! JSON-RPC 2.0 over newline-delimited JSON on stdio, the ACP transport.

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn internal(detail: &str) -> RpcError {
        RpcError {
            code: -32603,
            message: format!("Internal error: {detail}"),
            data: None,
        }
    }

    pub fn session_not_found(session_id: &str) -> RpcError {
        RpcError {
            code: -32002,
            message: "Resource not found".into(),
            data: Some(json!({ "sessionId": session_id })),
        }
    }

    pub fn method_not_found(method: &str) -> RpcError {
        RpcError {
            code: -32601,
            message: format!("\"Method not found\": {method}"),
            data: Some(json!({ "method": method })),
        }
    }

    pub fn invalid_params(detail: &str) -> RpcError {
        RpcError {
            code: -32602,
            message: format!("Invalid params: {detail}"),
            data: None,
        }
    }

    fn to_json(&self) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        error
    }
}

enum Out {
    Message(Value),
    /// Answered once every message before it is written.
    Flush(oneshot::Sender<()>),
}

/// Writes messages to the client, one line each, in the order they are sent.
#[derive(Clone)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<Out>,
}

impl Outbox {
    pub fn start() -> Outbox {
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut stdout = tokio::io::stdout();
            let mut broken = false;
            while let Some(out) = rx.recv().await {
                match out {
                    Out::Message(_) if broken => {}
                    Out::Message(message) => {
                        let mut line = message.to_string();
                        line.push('\n');
                        broken = stdout.write_all(line.as_bytes()).await.is_err();
                        let _ = stdout.flush().await;
                    }
                    Out::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Outbox { tx }
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.tx.send(Out::Message(
            json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        ));
    }

    pub fn respond(&self, id: Value, result: Result<Value, RpcError>) {
        let message = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error.to_json() }),
        };
        let _ = self.tx.send(Out::Message(message));
    }

    /// Wait until every message sent so far is written.
    pub async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(Out::Flush(done)).is_ok() {
            let _ = wait.await;
        }
    }
}
