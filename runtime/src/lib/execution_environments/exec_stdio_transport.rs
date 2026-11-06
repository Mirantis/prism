//! An MCP stdio transport that starts its server in the execution environment.
//!
//! The SDK's own stdio transport spawns the server as a child of this process,
//! which only works while the server's files are on this machine's filesystem.
//! A plugin's files belong to the environment, so the process does too: this
//! one runs the same command through `run_program` and speaks the same protocol
//! over its pipes — newline-delimited JSON, one message per line, which is what
//! MCP stdio is.
//!
//! Messages are JSON-RPC 2.0 objects (`JSONRPCMessage` in the MCP SDK), carried
//! as `serde_json::Value`. The transport trait of `crate::ai::mcp` is implemented
//! over these inherent methods.

use std::sync::Arc;

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::execution_environment::{ExecProcess, ExecStdin, ExecutionEnvironment};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecStdioServer {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Called with each message the server sends.
pub type OnMessage = Arc<dyn Fn(Value) + Send + Sync>;
/// Called with a launch failure or a line that is not JSON.
pub type OnError = Arc<dyn Fn(anyhow::Error) + Send + Sync>;
/// Called once, when the server's output has ended.
pub type OnClose = Arc<dyn Fn() + Send + Sync>;

pub struct ExecStdioTransport {
    environment: Arc<dyn ExecutionEnvironment>,
    server: ExecStdioServer,
    process: Mutex<Option<Arc<dyn ExecProcess>>>,
    stdin: tokio::sync::Mutex<Option<ExecStdin>>,
    /// The text after the last newline, waiting for the rest of its line.
    buffered: Mutex<String>,
    closed: Mutex<bool>,
    pub onmessage: Mutex<Option<OnMessage>>,
    pub onerror: Mutex<Option<OnError>>,
    pub onclose: Mutex<Option<OnClose>>,
}

impl ExecStdioTransport {
    pub fn new(environment: Arc<dyn ExecutionEnvironment>, server: ExecStdioServer) -> Self {
        ExecStdioTransport {
            environment,
            server,
            process: Mutex::new(None),
            stdin: tokio::sync::Mutex::new(None),
            buffered: Mutex::new(String::new()),
            closed: Mutex::new(false),
            onmessage: Mutex::new(None),
            onerror: Mutex::new(None),
            onclose: Mutex::new(None),
        }
    }

    /// Start the server: `run_program` with the environment's base env plus the
    /// server's own, `stdin: Pipe`, stdout split into lines and delivered, stderr
    /// logged at debug (`[PluginMCP] server`). Fails with
    /// "the MCP server is already started" on a second call.
    pub async fn start(self: &Arc<Self>) -> anyhow::Result<()> {
        todo!()
    }

    /// Write one message as a line. Fails with "the MCP server is not started"
    /// before `start`.
    pub async fn send(&self, message: &Value) -> anyhow::Result<()> {
        todo!()
    }

    /// SIGTERM, then wait for `ended`, then close.
    pub async fn close(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Split the stream on newlines and hand each whole line up as a message.
    fn receive(&self, chunk: &str) {
        todo!()
    }

    /// One unreadable line is the server's bug, not the end of the session.
    fn deliver(&self, line: &str) {
        todo!()
    }

    fn finish(&self) {
        todo!()
    }
}
