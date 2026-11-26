//! The timeouts of Node's global `fetch` (undici's defaults), which the model and
//! MCP clients keep.

use std::time::Duration;

/// How long a request waits for a connection.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a request waits for the response headers, and between two body chunks.
pub const READ_TIMEOUT: Duration = Duration::from_secs(300);
