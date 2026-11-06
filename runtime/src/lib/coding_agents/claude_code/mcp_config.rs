//! The MCP servers of a Claude Code task, given to the CLI as a `--mcp-config`
//! file.
//!
//! A server's env values and headers can be credentials, so they travel in a
//! file rather than on the command line: written 0600 into a directory of the
//! task's own that only this user can open, and removed with that directory
//! before the run's stream ends.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::lib::coding_agents::coding_agent::{
    CodingAgentMcpServer, CodingAgentRun, CodingAgentTask,
};
use crate::lib::execution_environments::execution_environment::ExecutionEnvironment;

pub const DIR_PREFIX: &str = "prism-claude-code-";
pub const FILE_NAME: &str = "mcp.json";

/// Changes to the server's own directory, then runs it. The CLI starts a stdio
/// server in the task's working directory and has no field for another one.
pub const IN_SERVER_DIR: &str = "cd \"$0\" && exec \"$@\"";

/// Text the CLI replaces with a variable from its own environment, in any value
/// of a server, while the runtime passes it to the server unchanged. No escape
/// holds for every value: Claude Code 2.1.296 replaces a header value more than
/// once.
static CLI_EXPANDED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}").unwrap());

/// The CLI's `mcpServers` document, and the servers left out of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeMcpConfig {
    pub document: String,
    pub left_out: Vec<String>,
}

/// The CLI's `mcpServers` document for these servers. With `via_sh` a stdio
/// server starts in its own directory; without it, in the task's. A server whose
/// values hold text the CLI would replace is left out and named in `left_out`, so
/// it never receives the CLI's environment.
pub fn claude_mcp_config(servers: &[CodingAgentMcpServer], via_sh: bool) -> ClaudeMcpConfig {
    let mut mcp_servers = Map::new();
    let mut left_out = Vec::new();
    for server in servers {
        let entry = entry_for(server, via_sh);
        if CLI_EXPANDED.is_match(&serde_json::to_string(&entry).unwrap_or_default()) {
            left_out.push(server.name().to_string());
        } else {
            mcp_servers.insert(server.name().to_string(), entry);
        }
    }
    let document = serde_json::to_string(&json!({ "mcpServers": Value::Object(mcp_servers) }))
        .unwrap_or_default();
    ClaudeMcpConfig { document, left_out }
}

fn entry_for(server: &CodingAgentMcpServer, via_sh: bool) -> Value {
    match server {
        CodingAgentMcpServer::Http { url, headers, .. }
        | CodingAgentMcpServer::Sse { url, headers, .. } => {
            json!({ "type": server.kind(), "url": url, "headers": headers })
        }
        CodingAgentMcpServer::Stdio {
            command,
            args,
            env,
            cwd,
            ..
        } => {
            if !via_sh {
                return json!({ "type": "stdio", "command": command, "args": args, "env": env });
            }
            let mut sh_args = vec![
                "-c".to_string(),
                IN_SERVER_DIR.to_string(),
                cwd.clone(),
                command.clone(),
            ];
            sh_args.extend(args.iter().cloned());
            json!({ "type": "stdio", "command": "sh", "args": sh_args, "env": env })
        }
    }
}

/// Starts the CLI on the config file at the given path.
pub type LaunchWithConfig = Box<dyn FnOnce(String) -> Arc<dyn CodingAgentRun> + Send>;

/// Write the task's config and start the CLI on it through `launch`. The run
/// removes the config once its stream has ended; a config that is not written,
/// or a `signal` that fires first, removes it before anything starts
/// (`[AgentTask] could not remove the MCP config` when the removal fails).
///
/// Native Windows puts no `sh` on the path; the container and macOS and Linux
/// hosts do.
pub async fn start_with_mcp_config(
    task: &CodingAgentTask,
    environment: Arc<dyn ExecutionEnvironment>,
    signal: CancellationToken,
    launch: LaunchWithConfig,
) -> anyhow::Result<Arc<dyn CodingAgentRun>> {
    todo!()
}
