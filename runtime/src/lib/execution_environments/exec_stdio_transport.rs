//! An MCP stdio transport that starts its server in the execution environment.
//!
//! A stdio transport that spawns the server as a child of this process only
//! works while the server's files are on this machine's filesystem. A plugin's
//! files belong to the environment, so the process does too: this one runs the
//! same command through `run_program` and speaks the same protocol over its pipes
//! — newline-delimited JSON, one message per line, which is what MCP stdio is.

use std::sync::{Arc, Weak};

use async_trait::async_trait;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::execution_environment::{
    ExecOutput, ExecProcess, ExecStdin, ExecutionEnvironment, RunOptions, Signal, StdinMode,
};
use crate::ai::mcp::{
    MCPTransport, MCPTransportCloseOptions, MCPTransportSendOptions, SharedCauseError,
    TransportHandlers,
};
use crate::log_debug;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecStdioServer {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

pub struct ExecStdioTransport {
    environment: Arc<dyn ExecutionEnvironment>,
    server: ExecStdioServer,
    process: Mutex<Option<Arc<dyn ExecProcess>>>,
    stdin: Arc<tokio::sync::Mutex<Option<ExecStdin>>>,
    /// The text after the last newline, waiting for the rest of its line.
    buffered: Mutex<String>,
    closed: Mutex<bool>,
    handlers: Mutex<Option<TransportHandlers>>,
    weak: Weak<Self>,
}

impl ExecStdioTransport {
    pub fn new(environment: Arc<dyn ExecutionEnvironment>, server: ExecStdioServer) -> Arc<Self> {
        Arc::new_cyclic(|weak| ExecStdioTransport {
            environment,
            server,
            process: Mutex::new(None),
            stdin: Arc::new(tokio::sync::Mutex::new(None)),
            buffered: Mutex::new(String::new()),
            closed: Mutex::new(false),
            handlers: Mutex::new(None),
            weak: weak.clone(),
        })
    }

    /// What the transport was asked to start.
    pub fn server(&self) -> &ExecStdioServer {
        &self.server
    }

    fn handlers(&self) -> Option<TransportHandlers> {
        self.handlers.lock().clone()
    }

    fn emit_error(&self, error: &anyhow::Error) {
        if let Some(handlers) = self.handlers() {
            (handlers.on_error)(error);
        }
    }

    /// Split the stream on newlines and hand each whole line up as a message.
    fn receive(&self, chunk: &str) {
        let lines = {
            let mut buffered = self.buffered.lock();
            buffered.push_str(chunk);
            let mut lines = Vec::new();
            while let Some(cut) = buffered.find('\n') {
                let line = crate::support::js::trim(&buffered[..cut]).to_string();
                buffered.drain(..=cut);
                if !line.is_empty() {
                    lines.push(line);
                }
            }
            lines
        };
        for line in lines {
            self.deliver(&line);
        }
    }

    /// One unreadable line is the server's bug, not the end of the session.
    fn deliver(&self, line: &str) {
        let delivered =
            crate::ai::mcp::json_parse(line).and_then(|message| match self.handlers() {
                Some(handlers) => (handlers.on_message)(message),
                None => Ok(()),
            });
        if let Err(error) = delivered {
            self.emit_error(&error);
        }
    }

    fn finish(&self) {
        {
            let mut closed = self.closed.lock();
            if *closed {
                return;
            }
            *closed = true;
        }
        if let Some(handlers) = self.handlers() {
            (handlers.on_close)();
        }
    }

    /// The server's stdout as text, decoded as UTF-8 across chunk boundaries,
    /// until it ends; then the process's end.
    async fn read_stdout(
        self: Arc<Self>,
        process: Arc<dyn ExecProcess>,
        stdout: Option<ExecOutput>,
    ) {
        if let Some(mut stdout) = stdout {
            let mut buffer = vec![0u8; 64 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                let read = match stdout.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                pending.extend_from_slice(&buffer[..read]);
                let text = take_utf8(&mut pending);
                if !text.is_empty() {
                    self.receive(&text);
                }
            }
            if !pending.is_empty() {
                let rest = String::from_utf8_lossy(&pending).into_owned();
                self.receive(&rest);
            }
        }
        let end = process.closed().await;
        if let Some(error) = end.error {
            self.emit_error(&anyhow::Error::new(SharedCauseError(error)));
        }
        self.finish();
    }
}

/// The longest prefix of `pending` that is whole UTF-8, decoded (invalid bytes
/// replaced); a sequence cut by the chunk boundary stays for the next chunk.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let complete = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(error) => match error.error_len() {
            // Invalid bytes in the middle: decode them as replacements.
            Some(_) => pending.len(),
            None => error.valid_up_to(),
        },
    };
    let text = String::from_utf8_lossy(&pending[..complete]).into_owned();
    pending.drain(..complete);
    text
}

/// The server's diagnostics are its own; a line here is not a protocol message,
/// and an undrained pipe would eventually block the server.
async fn drain_stderr(command: String, mut stderr: ExecOutput) {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let text = String::from_utf8_lossy(&buffer[..read]);
        log_debug!(
            json!({ "command": command, "line": crate::support::js::trim_end(&text) }),
            "[PluginMCP] server"
        );
    }
}

#[async_trait]
impl MCPTransport for ExecStdioTransport {
    fn set_handlers(&self, handlers: TransportHandlers) {
        *self.handlers.lock() = Some(handlers);
    }

    /// Start the server: `run_program` with the environment's base env plus the
    /// server's own, stdin piped, stdout split into lines and delivered, stderr
    /// logged at debug (`[PluginMCP] server`). Fails with "the MCP server is
    /// already started" on a second call.
    async fn start(&self) -> anyhow::Result<()> {
        if self.process.lock().is_some() {
            anyhow::bail!("the MCP server is already started");
        }

        let mut env = self.environment.base_env();
        if let Some(server_env) = &self.server.env {
            for (key, value) in server_env {
                env.insert(key.clone(), value.clone());
            }
        }
        let process = self.environment.run_program(
            &self.server.command,
            self.server.args.as_deref().unwrap_or(&[]),
            RunOptions {
                cwd: self
                    .server
                    .cwd
                    .clone()
                    .unwrap_or_else(|| self.environment.workspace_root()),
                env,
                stdin: StdinMode::Pipe,
            },
        );
        *self.process.lock() = Some(process.clone());
        *self.stdin.lock().await = process.take_stdin();

        if let Some(stderr) = process.take_stderr() {
            tokio::spawn(drain_stderr(self.server.command.clone(), stderr));
        }
        if let Some(transport) = self.weak.upgrade() {
            let stdout = process.take_stdout();
            tokio::spawn(transport.read_stdout(process, stdout));
        }
        Ok(())
    }

    /// Write one message as a line. Fails with "the MCP server is not started"
    /// before `start`.
    async fn send(&self, message: Value, _options: MCPTransportSendOptions) -> anyhow::Result<()> {
        if self.process.lock().is_none() || self.stdin.lock().await.is_none() {
            anyhow::bail!("the MCP server is not started");
        }
        let line = format!("{}\n", crate::ai::json::js_stringify(&message));
        let stdin = self.stdin.clone();
        // The write finishes even when the caller stops waiting, so no half line
        // is left on the pipe.
        tokio::spawn(async move {
            let mut guard = stdin.lock().await;
            let Some(stdin) = guard.as_mut() else {
                anyhow::bail!("the MCP server is not started");
            };
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
            Ok(())
        })
        .await?
    }

    /// SIGTERM, then wait for `ended`, then close.
    async fn close(&self, _options: MCPTransportCloseOptions) -> anyhow::Result<()> {
        let Some(process) = self.process.lock().clone() else {
            return Ok(());
        };
        process.kill(Signal::SIGTERM);
        process.ended().await;
        self.finish();
        Ok(())
    }
}
