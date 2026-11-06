//! Tool Lifecycle Events
//!
//! Wraps each tool's `execute` to report when it starts and finishes, for live
//! progress UI, such as a channel's working indicator.
//! Purely observational: listener panics are swallowed, and the wrapper never
//! changes a tool's arguments, result, or returned error.

use crate::ai::ToolSet;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Which edge of a tool's execution an event reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolLifecycleEventType {
    Started,
    Completed,
}

impl ToolLifecycleEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLifecycleEvent {
    #[serde(rename = "type")]
    pub kind: ToolLifecycleEventType,
    pub tool_name: String,
}

/// Called around every tool execution.
pub type ToolLifecycleListener = Arc<dyn Fn(ToolLifecycleEvent) + Send + Sync>;

/// Wrap every executable tool so `on_tool_event` fires around its execution.
/// `completed` fires however the call ends — a tool that fails still reports, so a
/// progress UI never sticks on a failed tool. Without a listener the tools
/// are returned untouched.
pub fn with_tool_lifecycle_events(
    tools: ToolSet,
    on_tool_event: Option<ToolLifecycleListener>,
) -> ToolSet {
    let Some(on_tool_event) = on_tool_event else {
        return tools;
    };
    // For each tool with an `execute`: replace it with one that calls
    // `notify(started)`, awaits the original, then `notify(completed)` on every
    // path (a guard, so a cancelled future reports too). A tool without `execute`
    // is kept as it is.
    todo!()
}

/// Progress UI only — a listener bug must not fail the tool call.
fn notify(listener: &ToolLifecycleListener, event: ToolLifecycleEvent) {
    let listener = listener.clone();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || listener(event)));
}
