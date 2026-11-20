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

use async_trait::async_trait;
use futures::StreamExt;
use futures::future::BoxFuture;

use crate::lib::coding_agents::coding_agent::{
    CodingAgentEvents, CodingAgentMcpServer, CodingAgentRun, CodingAgentTask,
};
use crate::lib::coding_agents::deferred_run::aborted;
use crate::lib::execution_environments::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ProcessMark,
};
use crate::lib::log_redaction::err_json;
use crate::log_warn;

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
    let files = environment.files();
    let via_sh = environment.id() != ExecutionEnvironmentName::Local || !cfg!(windows);
    let dir = files.make_temp_dir(DIR_PREFIX).await?;
    let remove: RemoveConfig = {
        let files = files.clone();
        let dir = dir.clone();
        let task_id = task.task_id.clone();
        Box::new(move || {
            Box::pin(async move {
                if let Err(err) = files.remove(&dir).await {
                    log_warn!(
                        json!({ "err": err_json(&err), "taskId": task_id, "dir": dir }),
                        "[AgentTask] could not remove the MCP config"
                    );
                }
            })
        })
    };
    let written: anyhow::Result<Arc<dyn CodingAgentRun>> = async {
        let config_path = format!("{}/{FILE_NAME}", dir.trim_end_matches('/'));
        let ClaudeMcpConfig { document, left_out } = claude_mcp_config(&task.mcp_servers, via_sh);
        if !left_out.is_empty() {
            log_warn!(
                json!({ "taskId": task.task_id, "servers": left_out }),
                "[AgentTask] MCP servers left out: a value holds ${{…}} text that Claude Code would replace"
            );
        }
        files.write_text(&config_path, &document, Some(0o600)).await?;
        if signal.is_cancelled() {
            return Err(aborted());
        }
        Ok(launch(config_path))
    }
    .await;
    let run = match written {
        Ok(run) => run,
        Err(err) => {
            remove().await;
            return Err(err);
        }
    };
    let events = run
        .take_events()
        .map(|events| removed_after(events, remove));
    Ok(Arc::new(ConfigRun {
        events: parking_lot::Mutex::new(events),
        run,
    }))
}

/// Removes the task's config directory.
type RemoveConfig = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;

/// The events of `events`, with the config removed once they end, or once the
/// reader drops them before that.
fn removed_after(events: CodingAgentEvents, remove: RemoveConfig) -> CodingAgentEvents {
    struct Pending(Option<RemoveConfig>);
    impl Drop for Pending {
        fn drop(&mut self) {
            if let Some(remove) = self.0.take()
                && let Ok(runtime) = tokio::runtime::Handle::try_current()
            {
                runtime.spawn(remove());
            }
        }
    }
    futures::stream::unfold(
        (Some(events), Pending(Some(remove))),
        |(events, mut pending)| async move {
            let mut events = events?;
            match events.next().await {
                Some(event) => Some((event, (Some(events), pending))),
                None => {
                    if let Some(remove) = pending.0.take() {
                        remove().await;
                    }
                    None
                }
            }
        },
    )
    .boxed()
}

/// The CLI's run, with its events read through `removed_after`.
struct ConfigRun {
    run: Arc<dyn CodingAgentRun>,
    events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for ConfigRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        self.run.exited()
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.run.mark()
    }

    async fn started(&self) {
        self.run.started().await
    }

    fn stop(&self) {
        self.run.stop()
    }
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use super::*;

    fn map(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn entries(servers: &[CodingAgentMcpServer], via_sh: bool) -> Value {
        let document: Value =
            serde_json::from_str(&claude_mcp_config(servers, via_sh).document).unwrap();
        document["mcpServers"].clone()
    }

    fn probe() -> CodingAgentMcpServer {
        CodingAgentMcpServer::Stdio {
            name: "demo__probe".to_string(),
            command: "node".to_string(),
            args: vec!["server.js".into(), "--port".into(), "0".into()],
            env: map(&[("PLUGIN_ROOT", "/plugins/demo"), ("TOKEN", "t")]),
            cwd: "/plugins/demo".to_string(),
        }
    }

    fn stdio(
        name: &str,
        command: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
    ) -> CodingAgentMcpServer {
        CodingAgentMcpServer::Stdio {
            name: name.to_string(),
            command: command.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: map(env),
            cwd: cwd.to_string(),
        }
    }

    #[test]
    fn writes_a_remote_server_as_its_transport_url_and_headers() {
        assert_eq!(
            entries(
                &[
                    CodingAgentMcpServer::Http {
                        name: "nexus".into(),
                        url: "https://nexus.example.test/mcp".into(),
                        headers: IndexMap::new(),
                    },
                    CodingAgentMcpServer::Sse {
                        name: "demo__events".into(),
                        url: "https://events.example.test/sse".into(),
                        headers: map(&[("X-Api-Key", "k")]),
                    },
                ],
                true
            ),
            json!({
                "nexus": { "type": "http", "url": "https://nexus.example.test/mcp", "headers": {} },
                "demo__events": {
                    "type": "sse",
                    "url": "https://events.example.test/sse",
                    "headers": { "X-Api-Key": "k" }
                }
            })
        );
    }

    #[test]
    fn writes_a_stdio_server_with_its_env_started_from_its_own_directory() {
        let entries = entries(&[probe()], true);
        let entry = &entries["demo__probe"];
        assert_eq!(entry["type"], "stdio");
        assert_eq!(
            entry["env"],
            json!({ "PLUGIN_ROOT": "/plugins/demo", "TOKEN": "t" })
        );
        let args = entry["args"].as_array().unwrap();
        assert_eq!(
            args[args.len() - 5..],
            [
                json!("/plugins/demo"),
                json!("node"),
                json!("server.js"),
                json!("--port"),
                json!("0")
            ]
        );
    }

    #[test]
    fn writes_a_stdio_server_as_its_own_command_line_where_there_is_no_sh() {
        assert_eq!(
            entries(&[probe()], false),
            json!({
                "demo__probe": {
                    "type": "stdio",
                    "command": "node",
                    "args": ["server.js", "--port", "0"],
                    "env": { "PLUGIN_ROOT": "/plugins/demo", "TOKEN": "t" }
                }
            })
        );
    }

    #[test]
    fn leaves_out_a_server_whose_values_hold_text_the_cli_would_replace() {
        // The forms Claude Code 2.1.296 replaced in a real run: `${NAME}` and
        // `${NAME:-default}`, in an arg, an env value and a header.
        let servers = [
            stdio(
                "in_arg",
                "node",
                &["--home=${HOME}"],
                &[("PLUGIN_ROOT", "/plugins/demo")],
                "/plugins/demo",
            ),
            stdio(
                "in_env",
                "node",
                &["server.js"],
                &[("KEY", "${TOKEN}")],
                "/plugins/demo",
            ),
            CodingAgentMcpServer::Http {
                name: "in_header".into(),
                url: "https://remote.example.test/mcp".into(),
                headers: map(&[("X-Key", "pre-${TOKEN:-none}-post")]),
            },
            // Text the CLI keeps as it is.
            stdio(
                "kept",
                "node",
                &["$HOME", "${1}", "${}"],
                &[],
                "/plugins/demo",
            ),
        ];

        let ClaudeMcpConfig { document, left_out } = claude_mcp_config(&servers, true);

        assert_eq!(left_out, ["in_arg", "in_env", "in_header"]);
        let document: Value = serde_json::from_str(&document).unwrap();
        let names: Vec<&String> = document["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(names, ["kept"]);
    }

    #[test]
    fn writes_no_server_when_the_runtime_connects_none() {
        assert_eq!(entries(&[], true), json!({}));
    }

    #[cfg(unix)]
    fn run_entry(entry: &Value, cwd: Option<&std::path::Path>) -> String {
        let args: Vec<String> = entry["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect();
        let mut command = std::process::Command::new(entry["command"].as_str().unwrap());
        command.args(&args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        String::from_utf8(command.output().unwrap().stdout).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn starts_the_server_in_its_directory_whatever_the_clis_own_is() {
        // A space and a quote in the name, which the wrapper takes as an argument.
        let dir = tempfile::Builder::new()
            .prefix("prism mcp 'probe' ")
            .tempdir()
            .unwrap();
        let server_dir = dir.path().to_string_lossy().into_owned();
        let entries = entries(&[stdio("probe", "pwd", &[], &[], &server_dir)], true);
        let out = run_entry(&entries["probe"], Some(&std::env::temp_dir()));
        assert_eq!(
            std::fs::canonicalize(out.trim()).unwrap(),
            std::fs::canonicalize(dir.path()).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn hands_the_server_its_arguments_unchanged() {
        let dir = tempfile::Builder::new()
            .prefix("prism mcp 'probe' ")
            .tempdir()
            .unwrap();
        let server_dir = dir.path().to_string_lossy().into_owned();
        let entries = entries(
            &[stdio(
                "probe",
                "printf",
                &["%s|", "two words", "$HOME", "\"q\""],
                &[],
                &server_dir,
            )],
            true,
        );
        assert_eq!(run_entry(&entries["probe"], None), "two words|$HOME|\"q\"|");
    }
}
