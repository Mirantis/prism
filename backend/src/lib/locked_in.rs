//! Locked-in mode refusals, shared by every tool the lock covers.
//!
//! Kept out of the tool modules so the workspace-markdown writers
//! (`tools/agent_config.rs`) and the long-term memory writers
//! (`tools/memory.rs`) return the same shape and emit the same one event.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::lib::telemetry::track_event;

/// Lock-protected targets used for telemetry and error text — not agentWorkspace column names (`memoryEntry` is a logical discriminator).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LockedField {
    #[serde(rename = "soulMd")]
    SoulMd,
    #[serde(rename = "memoryMd")]
    MemoryMd,
    #[serde(rename = "userMd")]
    UserMd,
    #[serde(rename = "heartbeatMd")]
    HeartbeatMd,
    #[serde(rename = "visionMd")]
    VisionMd,
    #[serde(rename = "bootstrapMd")]
    BootstrapMd,
    #[serde(rename = "memoryEntry")]
    MemoryEntry,
}

impl LockedField {
    pub fn as_str(&self) -> &'static str {
        match self {
            LockedField::SoulMd => "soulMd",
            LockedField::MemoryMd => "memoryMd",
            LockedField::UserMd => "userMd",
            LockedField::HeartbeatMd => "heartbeatMd",
            LockedField::VisionMd => "visionMd",
            LockedField::BootstrapMd => "bootstrapMd",
            LockedField::MemoryEntry => "memoryEntry",
        }
    }
}

/// A refused write as the tool returns it: `{ success: false, error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockedWriteRefusal {
    /// Always `false`.
    pub success: bool,
    pub error: String,
}

/// Refusal returned to the model when a workspace-markdown write is attempted
/// while locked-in mode is on.
const LOCKED_IN_WORKSPACE_REFUSAL: &str = "Locked-in mode is on, so your workspace files are read-only and this change was not saved. Tell the user what you would have changed and that they can turn locked-in mode off in their agent settings.";

/// Refusal for the long-term memory writers. Separate text because those tools
/// write vector-memory entries, not workspace files, and a message about files
/// would send the model looking for a file to edit instead.
const LOCKED_IN_MEMORY_REFUSAL: &str = "Locked-in mode is on, so your long-term memory is read-only and this change was not saved. You can still search memory. Tell the user what you would have remembered or removed and that they can turn locked-in mode off in their agent settings.";

/// The one emitter for the refused-write event, so a refusal is never
/// double-counted.
pub fn refuse_locked_write(agent_id: &str, field: LockedField) -> LockedWriteRefusal {
    let mut properties = IndexMap::new();
    properties.insert("agent.id".to_string(), agent_id.to_string());
    properties.insert("config.field".to_string(), field.as_str().to_string());
    track_event("agent locked write refused", None, Some(properties));
    LockedWriteRefusal {
        success: false,
        error: if field == LockedField::MemoryEntry {
            LOCKED_IN_MEMORY_REFUSAL
        } else {
            LOCKED_IN_WORKSPACE_REFUSAL
        }
        .to_string(),
    }
}
