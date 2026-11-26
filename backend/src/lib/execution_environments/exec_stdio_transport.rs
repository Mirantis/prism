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
        if self.stdin.lock().await.is_none() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToolExecutionOptions;
    use crate::ai::mcp::{MCPClientConfig, MCPTransportConfig, create_mcp_client};
    use crate::lib::execution_environments::local::local_environment::create_local_environment;

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|out| out.status.success())
    }

    fn probe_server(cwd: &str) -> ExecStdioServer {
        ExecStdioServer {
            command: "node".into(),
            args: Some(vec![format!(
                "{}/../e2e/fixtures/plugin-mcp-probe.mjs",
                env!("CARGO_MANIFEST_DIR")
            )]),
            env: None,
            cwd: Some(cwd.to_string()),
        }
    }

    #[test]
    fn delivers_each_whole_line_and_reports_one_that_is_not_json() {
        let transport =
            ExecStdioTransport::new(create_local_environment(), ExecStdioServer::default());
        let messages = Arc::new(Mutex::new(Vec::<Value>::new()));
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        transport.set_handlers(TransportHandlers {
            on_message: Arc::new({
                let messages = messages.clone();
                move |message| {
                    messages.lock().push(message);
                    Ok(())
                }
            }),
            on_error: Arc::new({
                let errors = errors.clone();
                move |error| errors.lock().push(error.to_string())
            }),
            on_close: Arc::new(|| {}),
        });

        transport.receive("{\"a\":1}\n{\"b\"");
        transport.receive(":2.0}\r\n\n not json\n{\"c\"");

        assert_eq!(*messages.lock(), vec![json!({ "a": 1 }), json!({ "b": 2 })]);
        assert_eq!(errors.lock().len(), 1);
        assert_eq!(*transport.buffered.lock(), "{\"c\"");
    }

    #[test]
    fn keeps_a_utf8_sequence_cut_by_a_chunk_for_the_next_chunk() {
        let mut pending = vec![b'a', 0xC3];
        assert_eq!(take_utf8(&mut pending), "a");
        pending.push(0xA9);
        assert_eq!(take_utf8(&mut pending), "é");
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn runs_the_plugin_probe_server_and_calls_its_tool() {
        if !node_available() {
            eprintln!("node is not on PATH; skipping");
            return;
        }
        let cwd = tempfile::tempdir().unwrap();
        let transport = ExecStdioTransport::new(
            create_local_environment(),
            probe_server(&cwd.path().to_string_lossy()),
        );
        let mut config = MCPClientConfig::new(MCPTransportConfig::Custom(transport));
        config.client_name = Some("prism-agent".into());
        let client = create_mcp_client(config).await.unwrap();

        let tools = client.tools().await.unwrap();
        let tool = &tools["plugin_mcp_probe"];
        let output = (tool.execute.as_ref().unwrap())(json!({}), ToolExecutionOptions::default())
            .await
            .unwrap();

        assert_eq!(tools.len(), 1);
        assert_eq!(
            tool.description.as_deref(),
            Some("Returns a marker that only this server knows.")
        );
        assert_eq!(
            crate::ai::json::js_stringify(tool.input_schema.json_schema()),
            r#"{"type":"object","properties":{},"additionalProperties":false}"#
        );
        assert_eq!(
            crate::ai::json::js_stringify(&output),
            r#"{"content":[{"type":"text","text":"PLUGIN_MCP_TOOL_OK"}],"isError":false}"#
        );
        client.close().await.unwrap();
    }

    #[tokio::test]
    async fn fails_the_connect_of_a_command_that_does_not_exist() {
        let cwd = tempfile::tempdir().unwrap();
        let transport = ExecStdioTransport::new(
            create_local_environment(),
            ExecStdioServer {
                command: "prism-no-such-mcp-server".into(),
                cwd: Some(cwd.path().to_string_lossy().into_owned()),
                ..ExecStdioServer::default()
            },
        );
        let config = MCPClientConfig::new(MCPTransportConfig::Custom(transport));

        assert!(create_mcp_client(config).await.is_err());
    }
}
