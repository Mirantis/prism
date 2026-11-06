//! MCP clients (`@ai-sdk/mcp`): stdio, Streamable HTTP and legacy SSE transports, and
//! the server's tools as AI SDK tools.

use crate::ai::ToolSet;

/// `MCPClient`: one connection to one MCP server.
pub struct MCPClient {}

impl MCPClient {
    /// `client.tools()`: every tool the server lists, as AI SDK tools.
    pub async fn tools(&self) -> anyhow::Result<ToolSet> {
        todo!()
    }

    /// `client.close()`.
    pub async fn close(&self) -> anyhow::Result<()> {
        todo!()
    }
}
