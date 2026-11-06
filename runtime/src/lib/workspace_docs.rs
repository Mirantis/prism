//! The seven identity documents, and the actor and method words a revision uses.
//!
//! One owner for the list, so the write path, the revision table and the
//! templates agree on what an identity document is. `src/lib/locked_in.rs` keeps
//! its own list: that one is the set the lock covers, six fields plus a logical
//! discriminator for vector memory, and it answers a different question.

use serde::{Deserialize, Serialize};
use std::fmt;

/// An `AgentWorkspace` column that holds an identity document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WorkspaceDocField {
    #[serde(rename = "agentMd")]
    AgentMd,
    #[serde(rename = "soulMd")]
    SoulMd,
    #[serde(rename = "userMd")]
    UserMd,
    #[serde(rename = "heartbeatMd")]
    HeartbeatMd,
    #[serde(rename = "memoryMd")]
    MemoryMd,
    #[serde(rename = "visionMd")]
    VisionMd,
    #[serde(rename = "bootstrapMd")]
    BootstrapMd,
}

/// The `AgentWorkspace` columns that hold an identity document, in the order the
/// Profile page shows them.
pub const WORKSPACE_DOC_FIELDS: [WorkspaceDocField; 7] = [
    WorkspaceDocField::AgentMd,
    WorkspaceDocField::SoulMd,
    WorkspaceDocField::UserMd,
    WorkspaceDocField::HeartbeatMd,
    WorkspaceDocField::MemoryMd,
    WorkspaceDocField::VisionMd,
    WorkspaceDocField::BootstrapMd,
];

/// What each document is called where a person reads it: a tool's confirmation
/// message and a log line naming the document that drifted.
pub const WORKSPACE_DOC_LABELS: [(WorkspaceDocField, &str); 7] = [
    (WorkspaceDocField::AgentMd, "Agent Guide"),
    (WorkspaceDocField::SoulMd, "Soul"),
    (WorkspaceDocField::UserMd, "User profile"),
    (WorkspaceDocField::HeartbeatMd, "Heartbeat config"),
    (WorkspaceDocField::MemoryMd, "Memory summary"),
    (WorkspaceDocField::VisionMd, "Vision"),
    (WorkspaceDocField::BootstrapMd, "Bootstrap"),
];

impl WorkspaceDocField {
    /// The column's name, as the API and the revision table write it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentMd => "agentMd",
            Self::SoulMd => "soulMd",
            Self::UserMd => "userMd",
            Self::HeartbeatMd => "heartbeatMd",
            Self::MemoryMd => "memoryMd",
            Self::VisionMd => "visionMd",
            Self::BootstrapMd => "bootstrapMd",
        }
    }

    /// The document's label from [`WORKSPACE_DOC_LABELS`].
    pub fn label(self) -> &'static str {
        match self {
            Self::AgentMd => "Agent Guide",
            Self::SoulMd => "Soul",
            Self::UserMd => "User profile",
            Self::HeartbeatMd => "Heartbeat config",
            Self::MemoryMd => "Memory summary",
            Self::VisionMd => "Vision",
            Self::BootstrapMd => "Bootstrap",
        }
    }

    /// Narrow a path segment or a request field to one of the seven columns.
    pub fn parse(value: &str) -> Option<Self> {
        WORKSPACE_DOC_FIELDS
            .into_iter()
            .find(|field| field.as_str() == value)
    }
}

impl fmt::Display for WorkspaceDocField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Narrow a path segment or a request field to one of the seven columns.
pub fn is_workspace_doc_field(value: &str) -> bool {
    WorkspaceDocField::parse(value).is_some()
}

/// Who wrote a revision. A heartbeat write and a chat write are both the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentWriteActor {
    Agent,
    User,
}

impl DocumentWriteActor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::User => "user",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "agent" => Some(Self::Agent),
            "user" => Some(Self::User),
            _ => None,
        }
    }
}

impl fmt::Display for DocumentWriteActor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How a revision was written. The middle four are the words the
/// `agent config updated` event already carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentWriteMethod {
    Seed,
    Replace,
    Edit,
    Clear,
    Rest,
    Rollback,
}

impl DocumentWriteMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seed => "seed",
            Self::Replace => "replace",
            Self::Edit => "edit",
            Self::Clear => "clear",
            Self::Rest => "rest",
            Self::Rollback => "rollback",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "seed" => Some(Self::Seed),
            "replace" => Some(Self::Replace),
            "edit" => Some(Self::Edit),
            "clear" => Some(Self::Clear),
            "rest" => Some(Self::Rest),
            "rollback" => Some(Self::Rollback),
            _ => None,
        }
    }
}

impl fmt::Display for DocumentWriteMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrows_only_the_seven_columns() {
        assert_eq!(
            WorkspaceDocField::parse("soulMd"),
            Some(WorkspaceDocField::SoulMd)
        );
        assert!(!is_workspace_doc_field("name"));
        for (field, label) in WORKSPACE_DOC_LABELS {
            assert_eq!(field.label(), label);
        }
    }
}
