//! The MCP servers the runtime connects for the agent, as one list a coding
//! agent's adapter can hand to its agent: the Lens Agents endpoint and every
//! server an installed plugin declares.

use sha2::{Digest, Sha256};

use crate::lib::coding_agents::coding_agent::CodingAgentMcpServer;

/// The name the Lens Agents endpoint has in the list.
const NEXUS_SERVER_NAME: &str = "nexus";

/// A plugin's server is named `<plugin id>__<server name>`, sanitized as the
/// agent's own names for its tools are. Sanitizing can map two plugin ids to one
/// name, so a name already taken gets a digest of the server's own ids
/// (`<name>_<first 7 hex of sha256("<plugin id>/<server name>")>`).
///
/// The Lens Agents endpoint comes first, as an `http` server named `nexus` with
/// no headers, when `config.nexus_mcp_url` is set. The plugin servers follow in
/// `PLUGIN_MCP_SERVICE.configured_servers()` order.
///
/// A plugin's stdio server runs where the plugin's files are, in the
/// deployment's execution environment, so it is left out for a process rooted
/// in a `workdir` that environment does not serve.
pub fn agent_mcp_servers(workdir: Option<&str>) -> Vec<CodingAgentMcpServer> {
    todo!()
}

fn digest(text: &str) -> String {
    let hex = hex::encode(Sha256::digest(text.as_bytes()));
    hex[..7].to_string()
}
