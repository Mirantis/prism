//! The MCP servers the runtime connects for the agent, as one list a coding
//! agent's adapter can hand to its agent: the Mirantis Agent Platform endpoint and every
//! server an installed plugin declares.

use std::collections::HashSet;

use indexmap::IndexMap;
use sha2::{Digest, Sha256};

use crate::config::CONFIG;
use crate::lib::coding_agents::coding_agent::CodingAgentMcpServer;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::tool_names::sanitize_tool_name_segment;
use crate::services::plugin_mcp_config::ResolvedServer;
use crate::services::plugin_mcp_service::{ConfiguredServer, PLUGIN_MCP_SERVICE};

/// The name the Mirantis Agent Platform endpoint has in the list.
const NEXUS_SERVER_NAME: &str = "nexus";

/// A plugin's server is named `<plugin id>__<server name>`, sanitized as the
/// agent's own names for its tools are. Sanitizing can map two plugin ids to one
/// name, so a name already taken gets a digest of the server's own ids.
///
/// A plugin's stdio server runs where the plugin's files are, in the
/// deployment's execution environment, so it is left out for a process rooted
/// in a `workdir` that environment does not serve.
pub fn agent_mcp_servers(workdir: Option<&str>) -> Vec<CodingAgentMcpServer> {
    let stdio_reachable = match workdir.filter(|w| !w.is_empty()) {
        None => true,
        Some(workdir) => get_execution_environment().serves_path(workdir),
    };
    list_servers(
        CONFIG.nexus_mcp_url.as_deref(),
        PLUGIN_MCP_SERVICE.configured_servers(),
        stdio_reachable,
    )
}

fn list_servers(
    nexus_mcp_url: Option<&str>,
    configured: Vec<ConfiguredServer>,
    stdio_reachable: bool,
) -> Vec<CodingAgentMcpServer> {
    let mut servers: Vec<CodingAgentMcpServer> = Vec::new();
    if let Some(url) = nexus_mcp_url.filter(|u| !u.is_empty()) {
        servers.push(CodingAgentMcpServer::Http {
            name: NEXUS_SERVER_NAME.to_string(),
            url: url.to_string(),
            headers: IndexMap::new(),
        });
    }
    let mut taken: HashSet<String> = servers.iter().map(|s| s.name().to_string()).collect();
    for ConfiguredServer { plugin_id, server } in configured {
        if matches!(server, ResolvedServer::Stdio { .. }) && !stdio_reachable {
            continue;
        }
        let mut name = [plugin_id.as_str(), server.name()]
            .iter()
            .map(|segment| sanitize_tool_name_segment(segment))
            .collect::<Vec<_>>()
            .join("__");
        if taken.contains(&name) {
            name = format!(
                "{name}_{}",
                digest(&format!("{plugin_id}/{}", server.name()))
            );
        }
        taken.insert(name.clone());
        servers.push(match server {
            ResolvedServer::Stdio {
                command,
                args,
                env,
                cwd,
                ..
            } => CodingAgentMcpServer::Stdio {
                name,
                command,
                args,
                env,
                cwd,
            },
            ResolvedServer::Http { url, headers, .. } => {
                CodingAgentMcpServer::Http { name, url, headers }
            }
            ResolvedServer::Sse { url, headers, .. } => {
                CodingAgentMcpServer::Sse { name, url, headers }
            }
        });
    }
    servers
}

fn digest(text: &str) -> String {
    let hex = hex::encode(Sha256::digest(text.as_bytes()));
    hex[..7].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio() -> ResolvedServer {
        ResolvedServer::Stdio {
            name: "probe".into(),
            command: "node".into(),
            args: vec![],
            env: IndexMap::new(),
            cwd: "/prism/plugins/demo".into(),
        }
    }

    fn remote() -> ResolvedServer {
        ResolvedServer::Http {
            name: "remote".into(),
            url: "https://remote.example.test/mcp".into(),
            headers: IndexMap::new(),
        }
    }

    fn configured(entries: &[(&str, ResolvedServer)]) -> Vec<ConfiguredServer> {
        entries
            .iter()
            .map(|(plugin_id, server)| ConfiguredServer {
                plugin_id: plugin_id.to_string(),
                server: server.clone(),
            })
            .collect()
    }

    fn names(servers: &[CodingAgentMcpServer]) -> Vec<String> {
        servers.iter().map(|s| s.name().to_string()).collect()
    }

    fn demo() -> Vec<ConfiguredServer> {
        configured(&[("demo", remote()), ("demo", stdio())])
    }

    #[test]
    fn names_each_plugin_server_after_its_plugin() {
        assert_eq!(
            names(&list_servers(None, demo(), true)),
            vec!["demo__remote", "demo__probe"]
        );
    }

    #[test]
    fn puts_the_platform_endpoint_first_with_no_credential() {
        let servers = list_servers(
            Some("https://gateway.example.test/projects/p/mcp"),
            demo(),
            true,
        );
        assert_eq!(
            servers[0],
            CodingAgentMcpServer::Http {
                name: "nexus".into(),
                url: "https://gateway.example.test/projects/p/mcp".into(),
                headers: IndexMap::new(),
            }
        );
    }

    #[test]
    fn keeps_both_servers_when_two_plugin_ids_sanitize_to_one_name() {
        let both = || configured(&[("foo.bar", remote()), ("foo_bar", remote())]);
        let names = names(&list_servers(None, both(), true));
        assert_eq!(names[0], "foo_bar__remote");
        let suffix = names[1].strip_prefix("foo_bar__remote_").unwrap();
        assert_eq!(suffix.len(), 7);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
        // The same on every call, so a resumed task sees the same names.
        assert_eq!(
            super::tests::names(&list_servers(None, both(), true)),
            names
        );
    }

    #[test]
    fn is_empty_with_no_endpoint_and_no_plugin_server() {
        assert!(list_servers(None, vec![], true).is_empty());
    }

    #[test]
    fn leaves_the_stdio_server_out_for_a_task_its_environment_does_not_serve() {
        assert_eq!(
            names(&list_servers(None, demo(), false)),
            vec!["demo__remote"]
        );
    }
}
