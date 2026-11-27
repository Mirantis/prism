//! One struct per Prisma model, named as the model, with its scalar fields in the
//! schema's order. A model serializes as `JSON.stringify` writes the row the Prisma
//! client returns: camelCase keys, dates as `toISOString()` text and `null` for an
//! empty column. `New<Model>` is the row to insert and `<Model>Changeset` a partial
//! update; the enums keep the text the schema stores.
//!
//! The Prisma client applies `@default(uuid())`, `@default(now())` and `@updatedAt`
//! itself rather than leaving them to the column defaults, so `New<Model>::new` and
//! the changesets' `Default` do the same here. A column default would write a date as
//! seconds text rather than milliseconds.
//!
//! An insert struct and a changeset hold a NOT NULL date as `DbDateTime` and NOT NULL
//! JSON as `DbJson` (see `crate::db::sql_types`); `.into()` converts either way.

use chrono::{DateTime, Utc};
use diesel::deserialize::{self, FromSql};
use diesel::prelude::*;
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::Text;
use diesel::sqlite::{Sqlite, SqliteValue};
use diesel::{AsExpression, FromSqlRow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::schema::*;
use super::sql_types::{DbDateTime, DbJson};

/// A stored enum text the schema does not declare, worded as the Prisma client words it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Value '{value}' not found in enum '{enum_name}'")]
pub struct UnknownEnumValue {
    pub enum_name: &'static str,
    pub value: String,
}

/// A Prisma enum: each member's stored text, `as_str`, `FromStr`, serde with the same
/// text, and a TEXT column binding.
macro_rules! prisma_enum {
    ($name:ident { $($variant:ident = $text:literal,)+ }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, AsExpression, FromSqlRow)]
        #[diesel(sql_type = Text)]
        pub enum $name {
            $(
                #[serde(rename = $text)]
                $variant,
            )+
        }

        impl $name {
            /// Every member, in the schema's order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The text the database stores.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text,)+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = UnknownEnumValue;

            fn from_str(text: &str) -> Result<Self, Self::Err> {
                match text {
                    $($text => Ok($name::$variant),)+
                    _ => Err(UnknownEnumValue { enum_name: stringify!($name), value: text.to_string() }),
                }
            }
        }

        impl ToSql<Text, Sqlite> for $name {
            fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
                out.set_value(self.as_str());
                Ok(IsNull::No)
            }
        }

        impl FromSql<Text, Sqlite> for $name {
            fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
                let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
                Ok(text.parse::<$name>()?)
            }
        }
    };
}

// ---------------------------------------------------------------- enums

prisma_enum!(AgentStatus {
    Idle = "IDLE",
    Running = "RUNNING",
});

prisma_enum!(AgentHeartbeatStatus {
    Enabled = "ENABLED",
    Stopped = "STOPPED",
});

prisma_enum!(AgentModelMode {
    Fixed = "FIXED",
    Auto = "AUTO",
});

prisma_enum!(MessageRole {
    User = "USER",
    Agent = "AGENT",
    System = "SYSTEM",
});

prisma_enum!(MessageTrigger {
    UserInput = "USER_INPUT",
    Heartbeat = "HEARTBEAT",
    CronTask = "CRON_TASK",
    Goal = "GOAL",
    Webhook = "WEBHOOK",
    AgentMessage = "AGENT_MESSAGE",
    // The runtime's report that background work the agent started in the
    // conversation has ended. It is stored as a hidden USER row and is never the person's.
    TaskNotification = "TASK_NOTIFICATION",
    System = "SYSTEM",
});

prisma_enum!(ThreadSource {
    Database = "DATABASE",
    Slack = "SLACK",
});

prisma_enum!(AgentType {
    Agent = "AGENT",
    Subagent = "SUBAGENT",
});

prisma_enum!(WebhookAuthType {
    None = "none",
    Token = "token",
    Hmac = "hmac",
});

prisma_enum!(WebhookAuthAlgorithm {
    Sha256 = "sha256",
    Sha1 = "sha1",
    Sha512 = "sha512",
});

prisma_enum!(WebhookAuthEncoding {
    Hex = "hex",
    Base64 = "base64",
});

prisma_enum!(SlackVerificationType {
    Dm = "DM",
    Channel = "CHANNEL",
});

prisma_enum!(TeamsVerificationType {
    Dm = "DM",
    Channel = "CHANNEL",
});

prisma_enum!(UpdateTrigger {
    Auto = "AUTO",
    Manual = "MANUAL",
});

prisma_enum!(UpdateOutcome {
    Pending = "PENDING",
    Success = "SUCCESS",
    Failure = "FAILURE",
});

// ---------------------------------------------------------------- AgentWorkspace

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = agent_workspaces, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub agent_type: AgentType,
    pub soul_md: String,
    pub user_md: String,
    pub memory_md: String,
    pub heartbeat_md: String,
    pub vision_md: String,
    pub agent_md: String,
    pub bootstrap_md: String,
    pub heartbeat_interval_ms: i64,
    pub heartbeat_status: AgentHeartbeatStatus,
    /// Where a heartbeat run may post: `DELIVER_TARGETS`. `heartbeatChannelIds`
    /// lists the linked channels of that target's channel; null = all of them.
    pub heartbeat_deliver_to: String,
    pub heartbeat_channel_ids: Option<String>,
    pub timezone: String,
    pub model: Option<String>,
    pub heartbeat_model: Option<String>,
    pub cron_model: Option<String>,
    /// Null in any of the four falls back to the deployment default
    /// (`MODEL_MODE`, `AUTO_MODEL_SMALL|MEDIUM|LARGE`).
    pub model_mode: Option<AgentModelMode>,
    pub small_model: Option<String>,
    pub medium_model: Option<String>,
    pub large_model: Option<String>,
    pub daily_reset_hour: i64,
    pub idle_timeout_mins: Option<i64>,
    /// The Webhooks page receiver switch opens the dedicated port while enabled.
    pub webhooks_enabled: bool,
    /// When false (default), only the final text step of a multi-step chat turn
    /// is delivered to the channel; intermediate steps are persisted but not
    /// published. When true, every text step is delivered as it arrives.
    pub verbose: bool,
    /// Locked-in mode (the Profile page toggle). Off by default; while on, the
    /// agent's own tools cannot rewrite the workspace markdown fields (soulMd,
    /// memoryMd, userMd, visionMd, heartbeatMd, bootstrapMd) — those tools are
    /// withheld and their writes refused. Vector memory, behavioural settings and
    /// renames stay editable, and the human REST/UI toggle always works.
    pub locked_in: bool,
    pub nexus_mcp_agent_token: Option<String>,
    pub nexus_agent_token_id: Option<String>,
    pub status: AgentStatus,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_heartbeat: Option<DateTime<Utc>>,
    /// When the next heartbeat check is due. Written by every recorded cycle and
    /// by a cadence change, and read at boot so the next process arms the same
    /// deadline. Distinct from lastHeartbeat, which is the last check that really
    /// ran: a cadence change moves the deadline without claiming a run. Null on a
    /// row that predates the column, and then the deadline comes off lastHeartbeat.
    #[serde(with = "crate::support::serde_iso::option")]
    pub next_heartbeat_at: Option<DateTime<Utc>>,
    pub current_session_id: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `AgentWorkspace` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = agent_workspaces, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewAgentWorkspace {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub agent_type: AgentType,
    pub soul_md: String,
    pub user_md: String,
    pub memory_md: String,
    pub heartbeat_md: String,
    pub vision_md: String,
    pub agent_md: String,
    pub bootstrap_md: String,
    pub heartbeat_interval_ms: i64,
    pub heartbeat_status: AgentHeartbeatStatus,
    pub heartbeat_deliver_to: String,
    pub heartbeat_channel_ids: Option<String>,
    pub timezone: String,
    pub model: Option<String>,
    pub heartbeat_model: Option<String>,
    pub cron_model: Option<String>,
    pub model_mode: Option<AgentModelMode>,
    pub small_model: Option<String>,
    pub medium_model: Option<String>,
    pub large_model: Option<String>,
    pub daily_reset_hour: i64,
    pub idle_timeout_mins: Option<i64>,
    pub webhooks_enabled: bool,
    pub verbose: bool,
    pub locked_in: bool,
    pub nexus_mcp_agent_token: Option<String>,
    pub nexus_agent_token_id: Option<String>,
    pub status: AgentStatus,
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub next_heartbeat_at: Option<DateTime<Utc>>,
    pub current_session_id: Option<String>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewAgentWorkspace {
    pub fn new(
        user_id: impl Into<String>,
        soul_md: impl Into<String>,
        user_md: impl Into<String>,
        memory_md: impl Into<String>,
        heartbeat_md: impl Into<String>,
        bootstrap_md: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            user_id: user_id.into(),
            name: "Prism Agent".to_string(),
            agent_type: AgentType::Agent,
            soul_md: soul_md.into(),
            user_md: user_md.into(),
            memory_md: memory_md.into(),
            heartbeat_md: heartbeat_md.into(),
            vision_md: "".to_string(),
            agent_md: "".to_string(),
            bootstrap_md: bootstrap_md.into(),
            heartbeat_interval_ms: 28800000,
            heartbeat_status: AgentHeartbeatStatus::Enabled,
            heartbeat_deliver_to: "all".to_string(),
            heartbeat_channel_ids: None,
            timezone: "UTC".to_string(),
            model: None,
            heartbeat_model: None,
            cron_model: None,
            model_mode: None,
            small_model: None,
            medium_model: None,
            large_model: None,
            daily_reset_hour: 4,
            idle_timeout_mins: None,
            webhooks_enabled: false,
            verbose: false,
            locked_in: false,
            nexus_mcp_agent_token: None,
            nexus_agent_token_id: None,
            status: AgentStatus::Idle,
            last_heartbeat: None,
            next_heartbeat_at: None,
            current_session_id: None,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `AgentWorkspace` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = agent_workspaces, check_for_backend(Sqlite))]
pub struct AgentWorkspaceChangeset {
    pub user_id: Option<String>,
    pub name: Option<String>,
    pub agent_type: Option<AgentType>,
    pub soul_md: Option<String>,
    pub user_md: Option<String>,
    pub memory_md: Option<String>,
    pub heartbeat_md: Option<String>,
    pub vision_md: Option<String>,
    pub agent_md: Option<String>,
    pub bootstrap_md: Option<String>,
    pub heartbeat_interval_ms: Option<i64>,
    pub heartbeat_status: Option<AgentHeartbeatStatus>,
    pub heartbeat_deliver_to: Option<String>,
    pub heartbeat_channel_ids: Option<Option<String>>,
    pub timezone: Option<String>,
    pub model: Option<Option<String>>,
    pub heartbeat_model: Option<Option<String>>,
    pub cron_model: Option<Option<String>>,
    pub model_mode: Option<Option<AgentModelMode>>,
    pub small_model: Option<Option<String>>,
    pub medium_model: Option<Option<String>>,
    pub large_model: Option<Option<String>>,
    pub daily_reset_hour: Option<i64>,
    pub idle_timeout_mins: Option<Option<i64>>,
    pub webhooks_enabled: Option<bool>,
    pub verbose: Option<bool>,
    pub locked_in: Option<bool>,
    pub nexus_mcp_agent_token: Option<Option<String>>,
    pub nexus_agent_token_id: Option<Option<String>>,
    pub status: Option<AgentStatus>,
    pub last_heartbeat: Option<Option<DateTime<Utc>>>,
    pub next_heartbeat_at: Option<Option<DateTime<Utc>>>,
    pub current_session_id: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for AgentWorkspaceChangeset {
    fn default() -> Self {
        Self {
            user_id: None,
            name: None,
            agent_type: None,
            soul_md: None,
            user_md: None,
            memory_md: None,
            heartbeat_md: None,
            vision_md: None,
            agent_md: None,
            bootstrap_md: None,
            heartbeat_interval_ms: None,
            heartbeat_status: None,
            heartbeat_deliver_to: None,
            heartbeat_channel_ids: None,
            timezone: None,
            model: None,
            heartbeat_model: None,
            cron_model: None,
            model_mode: None,
            small_model: None,
            medium_model: None,
            large_model: None,
            daily_reset_hour: None,
            idle_timeout_mins: None,
            webhooks_enabled: None,
            verbose: None,
            locked_in: None,
            nexus_mcp_agent_token: None,
            nexus_agent_token_id: None,
            status: None,
            last_heartbeat: None,
            next_heartbeat_at: None,
            current_session_id: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- AgentWorkspaceRevision

/// One snapshot of one identity document, written by every accepted write to
/// `soulMd`, `userMd`, `memoryMd`, `heartbeatMd`, `visionMd`, `agentMd` or
/// `bootstrapMd`. Append-only: a restore writes a new row rather than removing
/// the rows after it, so no step of the history is lost.
///
/// `field` is the column name, `actor` is `agent` or `user`, and `method` is
/// `seed`, `replace`, `edit`, `clear`, `rest` or `rollback` — the same words
/// the `agent config updated` event already carries.
///
/// Each document keeps its 500 newest revisions. The insert deletes anything
/// older in the same transaction (`services/document_revision_service.rs`).
#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = agent_workspace_revisions, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRevision {
    pub id: String,
    pub agent_id: String,
    pub field: String,
    pub content: String,
    pub actor: String,
    pub method: String,
    pub reason: String,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `AgentWorkspaceRevision` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = agent_workspace_revisions, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewAgentWorkspaceRevision {
    pub id: String,
    pub agent_id: String,
    pub field: String,
    pub content: String,
    pub actor: String,
    pub method: String,
    pub reason: String,
    pub created_at: DbDateTime,
}

impl NewAgentWorkspaceRevision {
    pub fn new(
        agent_id: impl Into<String>,
        field: impl Into<String>,
        content: impl Into<String>,
        actor: impl Into<String>,
        method: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            field: field.into(),
            content: content.into(),
            actor: actor.into(),
            method: method.into(),
            reason: reason.into(),
            created_at: now.into(),
        }
    }
}

/// A partial update of one `AgentWorkspaceRevision` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = agent_workspace_revisions, check_for_backend(Sqlite))]
pub struct AgentWorkspaceRevisionChangeset {
    pub agent_id: Option<String>,
    pub field: Option<String>,
    pub content: Option<String>,
    pub actor: Option<String>,
    pub method: Option<String>,
    pub reason: Option<String>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- ConversationThread

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = conversation_threads, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ConversationThread {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub title: Option<String>,
    pub external_thread_id: Option<String>,
    pub thread_source: ThreadSource,
    pub external_channel_id: Option<String>,
    /// Optional working directory this conversation is rooted in, set once at
    /// creation (e.g. the CLI's launch cwd). Shell tools use it as their cwd when
    /// present, else fall back to the global SHELL_WORKSPACE_ROOT. Never changed
    /// after create.
    pub workspace_root: Option<String>,
    pub compaction_summary: Option<String>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub compacted_at: Option<DateTime<Utc>>,
    /// Provider-native compaction watermark: the position up to which this
    /// thread's history is folded into `compactionSummary`. SLACK threads store
    /// the Slack ts of the newest compacted reply — the live conversations.replies
    /// read passes it as `oldest`. DATABASE threads store the newest compacted
    /// row's createdAt as ISO text (informational; the per-row isCompacted flag
    /// is authoritative there). A string because Slack ts and wall-clock DateTime
    /// don't share a clock.
    pub compacted_through_ts: Option<String>,
    /// Last measured prompt size for this thread, written once per turn: the
    /// provider-reported input tokens (already inclusive of cache reads/writes)
    /// plus that step's output tokens. A per-turn SNAPSHOT, not a running total —
    /// do not sum it. Drives the context-usage indicator, which recomputes the
    /// percentage against `contextModel`'s window on read so a stale number is
    /// never reinterpreted against a different model.
    pub context_tokens: Option<i64>,
    pub context_model: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `ConversationThread` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = conversation_threads, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewConversationThread {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub title: Option<String>,
    pub external_thread_id: Option<String>,
    pub thread_source: ThreadSource,
    pub external_channel_id: Option<String>,
    pub workspace_root: Option<String>,
    pub compaction_summary: Option<String>,
    pub compacted_at: Option<DateTime<Utc>>,
    pub compacted_through_ts: Option<String>,
    pub context_tokens: Option<i64>,
    pub context_model: Option<String>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewConversationThread {
    pub fn new(agent_id: impl Into<String>, user_id: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            user_id: user_id.into(),
            title: None,
            external_thread_id: None,
            thread_source: ThreadSource::Database,
            external_channel_id: None,
            workspace_root: None,
            compaction_summary: None,
            compacted_at: None,
            compacted_through_ts: None,
            context_tokens: None,
            context_model: None,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `ConversationThread` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = conversation_threads, check_for_backend(Sqlite))]
pub struct ConversationThreadChangeset {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub title: Option<Option<String>>,
    pub external_thread_id: Option<Option<String>>,
    pub thread_source: Option<ThreadSource>,
    pub external_channel_id: Option<Option<String>>,
    pub workspace_root: Option<Option<String>>,
    pub compaction_summary: Option<Option<String>>,
    pub compacted_at: Option<Option<DateTime<Utc>>>,
    pub compacted_through_ts: Option<Option<String>>,
    pub context_tokens: Option<Option<i64>>,
    pub context_model: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for ConversationThreadChangeset {
    fn default() -> Self {
        Self {
            agent_id: None,
            user_id: None,
            title: None,
            external_thread_id: None,
            thread_source: None,
            external_channel_id: None,
            workspace_root: None,
            compaction_summary: None,
            compacted_at: None,
            compacted_through_ts: None,
            context_tokens: None,
            context_model: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- ConversationMessage

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = conversation_messages, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub thread_id: String,
    pub role: MessageRole,
    pub content: String,
    pub triggered_by: MessageTrigger,
    /// The webhook subscription that produced a WEBHOOK message. The model's
    /// history names it; clients show the content alone. On an AGENT_MESSAGE row it
    /// is the kind: `message`, `ask` (the sender waits for an answer) or `notice`.
    pub trigger_name: Option<String>,
    pub tool_calls: Option<Value>,
    pub blocks: Option<Value>,
    pub sender_external_id: Option<String>,
    pub sender_name: Option<String>,
    pub external_message_id: Option<String>,
    pub is_compacted: bool,
    /// Concise mode persists intermediate multi-step text as its own AGENT row but
    /// does not deliver it to the channel. `internalStep` marks such rows so client
    /// history reads hide them, while the model-context read still replays them.
    pub internal_step: bool,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `ConversationMessage` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = conversation_messages, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewConversationMessage {
    pub id: String,
    pub thread_id: String,
    pub role: MessageRole,
    pub content: String,
    pub triggered_by: MessageTrigger,
    pub trigger_name: Option<String>,
    pub tool_calls: Option<Value>,
    pub blocks: Option<Value>,
    pub sender_external_id: Option<String>,
    pub sender_name: Option<String>,
    pub external_message_id: Option<String>,
    pub is_compacted: bool,
    pub internal_step: bool,
    pub created_at: DbDateTime,
}

impl NewConversationMessage {
    pub fn new(
        thread_id: impl Into<String>,
        role: MessageRole,
        content: impl Into<String>,
        triggered_by: MessageTrigger,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.into(),
            role,
            content: content.into(),
            triggered_by,
            trigger_name: None,
            tool_calls: None,
            blocks: None,
            sender_external_id: None,
            sender_name: None,
            external_message_id: None,
            is_compacted: false,
            internal_step: false,
            created_at: now.into(),
        }
    }
}

/// A partial update of one `ConversationMessage` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = conversation_messages, check_for_backend(Sqlite))]
pub struct ConversationMessageChangeset {
    pub thread_id: Option<String>,
    pub role: Option<MessageRole>,
    pub content: Option<String>,
    pub triggered_by: Option<MessageTrigger>,
    pub trigger_name: Option<Option<String>>,
    pub tool_calls: Option<Option<Value>>,
    pub blocks: Option<Option<Value>>,
    pub sender_external_id: Option<Option<String>>,
    pub sender_name: Option<Option<String>>,
    pub external_message_id: Option<Option<String>>,
    pub is_compacted: Option<bool>,
    pub internal_step: Option<bool>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- MessageAttachment

/// Shared files uploaded by users (web drag-and-drop or Slack attachments).
/// Bytes are stored as a BLOB in this DB (safer than disk; survives restarts).
/// `messageId` is nullable: web uploads land before the message is sent, then
/// get linked at send time. `externalTs` re-associates Slack channel files with
/// the live-read history (the SlackThreadProvider keys messages by Slack ts and
/// never reads our message rows). `category` is denormalized so the context
/// loader doesn't re-sniff the mediaType on every turn.
#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = message_attachments, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub id: String,
    pub message_id: Option<String>,
    pub thread_id: Option<String>,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: String,
    /// Legacy BLOB storage. New rows keep bytes on disk (storagePath below) and
    /// leave this null; a boot-time backfill migrates old rows. Both null =
    /// content expired (the 168h TTL sweep) — the metadata row stays for history.
    #[serde(with = "crate::db::sql_types::uint8_array::option")]
    pub data: Option<Vec<u8>>,
    /// Basename of the content file under `<dataDir>/media` (see `lib/media_store.rs`).
    pub storage_path: Option<String>,
    pub source: String,
    /// Unique so concurrent Slack event redeliveries (at-least-once) can't insert
    /// the same file twice — the `exists_by_slack_file_id()` pre-check is a TOCTOU
    /// fast-path, not the guarantee. Nullable web uploads are unconstrained
    /// (SQLite treats NULLs as distinct). One Slack workspace per container, so a
    /// single-column unique is sufficient (no per-connection scoping needed).
    pub slack_file_id: Option<String>,
    pub external_ts: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `MessageAttachment` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = message_attachments, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewMessageAttachment {
    pub id: String,
    pub message_id: Option<String>,
    pub thread_id: Option<String>,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: String,
    pub data: Option<Vec<u8>>,
    pub storage_path: Option<String>,
    pub source: String,
    pub slack_file_id: Option<String>,
    pub external_ts: Option<String>,
    pub created_at: DbDateTime,
}

impl NewMessageAttachment {
    pub fn new(
        filename: impl Into<String>,
        media_type: impl Into<String>,
        size_bytes: i64,
        category: impl Into<String>,
        source: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            message_id: None,
            thread_id: None,
            filename: filename.into(),
            media_type: media_type.into(),
            size_bytes,
            category: category.into(),
            data: None,
            storage_path: None,
            source: source.into(),
            slack_file_id: None,
            external_ts: None,
            created_at: now.into(),
        }
    }
}

/// A partial update of one `MessageAttachment` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = message_attachments, check_for_backend(Sqlite))]
pub struct MessageAttachmentChangeset {
    pub message_id: Option<Option<String>>,
    pub thread_id: Option<Option<String>>,
    pub filename: Option<String>,
    pub media_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub category: Option<String>,
    pub data: Option<Option<Vec<u8>>>,
    pub storage_path: Option<Option<String>>,
    pub source: Option<String>,
    pub slack_file_id: Option<Option<String>>,
    pub external_ts: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- ConversationParticipant

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = conversation_participants, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct ConversationParticipant {
    pub id: String,
    pub thread_id: String,
    pub external_user_id: String,
    pub display_name: Option<String>,
    pub channel: String,
    #[serde(with = "crate::support::serde_iso")]
    pub joined_at: DateTime<Utc>,
}

/// One `ConversationParticipant` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = conversation_participants, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewConversationParticipant {
    pub id: String,
    pub thread_id: String,
    pub external_user_id: String,
    pub display_name: Option<String>,
    pub channel: String,
    pub joined_at: DbDateTime,
}

impl NewConversationParticipant {
    pub fn new(
        thread_id: impl Into<String>,
        external_user_id: impl Into<String>,
        channel: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            thread_id: thread_id.into(),
            external_user_id: external_user_id.into(),
            display_name: None,
            channel: channel.into(),
            joined_at: now.into(),
        }
    }
}

/// A partial update of one `ConversationParticipant` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = conversation_participants, check_for_backend(Sqlite))]
pub struct ConversationParticipantChangeset {
    pub thread_id: Option<String>,
    pub external_user_id: Option<String>,
    pub display_name: Option<Option<String>>,
    pub channel: Option<String>,
    pub joined_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- CronTask

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = cron_tasks, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub name: String,
    pub schedule: String,
    pub instruction: String,
    pub is_active: bool,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub next_run_at: Option<DateTime<Utc>>,
    /// When set, this (one-shot) task continues the originating conversation in
    /// its own thread instead of the user's latest thread — the "wait & resume
    /// here" capability.
    pub thread_id: Option<String>,
    pub origin_channel: Option<String>,
    pub origin_channel_id: Option<String>,
    /// Where a task that continues no conversation delivers its result:
    /// `DELIVER_TARGETS`. `channelIds` lists the linked channels of that target's
    /// channel it posts to; null = the channel's default destination.
    pub deliver_to: String,
    pub channel_ids: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `CronTask` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = cron_tasks, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewCronTask {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub name: String,
    pub schedule: String,
    pub instruction: String,
    pub is_active: bool,
    pub last_run_at: Option<DateTime<Utc>>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub thread_id: Option<String>,
    pub origin_channel: Option<String>,
    pub origin_channel_id: Option<String>,
    pub deliver_to: String,
    pub channel_ids: Option<String>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewCronTask {
    pub fn new(
        agent_id: impl Into<String>,
        user_id: impl Into<String>,
        name: impl Into<String>,
        schedule: impl Into<String>,
        instruction: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            user_id: user_id.into(),
            name: name.into(),
            schedule: schedule.into(),
            instruction: instruction.into(),
            is_active: true,
            last_run_at: None,
            next_run_at: None,
            thread_id: None,
            origin_channel: None,
            origin_channel_id: None,
            deliver_to: "all".to_string(),
            channel_ids: None,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `CronTask` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = cron_tasks, check_for_backend(Sqlite))]
pub struct CronTaskChangeset {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub name: Option<String>,
    pub schedule: Option<String>,
    pub instruction: Option<String>,
    pub is_active: Option<bool>,
    pub last_run_at: Option<Option<DateTime<Utc>>>,
    pub next_run_at: Option<Option<DateTime<Utc>>>,
    pub thread_id: Option<Option<String>>,
    pub origin_channel: Option<Option<String>>,
    pub origin_channel_id: Option<Option<String>>,
    pub deliver_to: Option<String>,
    pub channel_ids: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for CronTaskChangeset {
    fn default() -> Self {
        Self {
            agent_id: None,
            user_id: None,
            name: None,
            schedule: None,
            instruction: None,
            is_active: None,
            last_run_at: None,
            next_run_at: None,
            thread_id: None,
            origin_channel: None,
            origin_channel_id: None,
            deliver_to: None,
            channel_ids: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- Goal

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = goals, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: String,
    pub objective: String,
    /// active | complete | blocked | budget_limited | turn_limited | paused | stopped
    pub status: String,
    pub token_budget: Option<i64>,
    pub tokens_used: i64,
    pub turn_count: i64,
    pub max_turns: i64,
    /// Consecutive zero-progress turns; goal is blocked once this hits GOAL_MAX_STALL_TURNS.
    pub stall_count: i64,
    /// Latest loop/gate reason (why it continued, blocked, or stopped) — surfaced in status.
    pub last_reason: Option<String>,
    /// Originating channel (REQUIRED) used for scoped delivery of goal-turn output.
    /// 'slack' | 'websocket'
    pub origin_channel: String,
    /// Nullable: absent for Slack DMs (delivery falls back to the DM mapping).
    pub origin_channel_id: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// One `Goal` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = goals, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewGoal {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: String,
    pub objective: String,
    pub status: String,
    pub token_budget: Option<i64>,
    pub tokens_used: i64,
    pub turn_count: i64,
    pub max_turns: i64,
    pub stall_count: i64,
    pub last_reason: Option<String>,
    pub origin_channel: String,
    pub origin_channel_id: Option<String>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
    pub completed_at: Option<DateTime<Utc>>,
}

impl NewGoal {
    pub fn new(
        agent_id: impl Into<String>,
        user_id: impl Into<String>,
        thread_id: impl Into<String>,
        objective: impl Into<String>,
        max_turns: i64,
        origin_channel: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            user_id: user_id.into(),
            thread_id: thread_id.into(),
            objective: objective.into(),
            status: "active".to_string(),
            token_budget: None,
            tokens_used: 0,
            turn_count: 0,
            max_turns,
            stall_count: 0,
            last_reason: None,
            origin_channel: origin_channel.into(),
            origin_channel_id: None,
            created_at: now.into(),
            updated_at: now.into(),
            completed_at: None,
        }
    }
}

/// A partial update of one `Goal` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = goals, check_for_backend(Sqlite))]
pub struct GoalChangeset {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub thread_id: Option<String>,
    pub objective: Option<String>,
    pub status: Option<String>,
    pub token_budget: Option<Option<i64>>,
    pub tokens_used: Option<i64>,
    pub turn_count: Option<i64>,
    pub max_turns: Option<i64>,
    pub stall_count: Option<i64>,
    pub last_reason: Option<Option<String>>,
    pub origin_channel: Option<String>,
    pub origin_channel_id: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
    pub completed_at: Option<Option<DateTime<Utc>>>,
}

impl Default for GoalChangeset {
    fn default() -> Self {
        Self {
            agent_id: None,
            user_id: None,
            thread_id: None,
            objective: None,
            status: None,
            token_budget: None,
            tokens_used: None,
            turn_count: None,
            max_turns: None,
            stall_count: None,
            last_reason: None,
            origin_channel: None,
            origin_channel_id: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
            completed_at: None,
        }
    }
}

// ---------------------------------------------------------------- LlmCall

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = llm_calls, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct LlmCall {
    pub id: String,
    /// Who paid: always the agent this runtime owns, and what reads filter on.
    pub agent_id: String,
    /// Which subagent the call ran for; a plain id, so a deletion keeps the row.
    pub subagent_id: Option<String>,
    /// What the call was for; `LLM_CALL_PURPOSES` is the list.
    pub purpose: String,
    pub model: String,
    pub thread_id: Option<String>,
    /// The request the call served: the user message a chat turn answers, or the run's own id.
    pub request_id: Option<String>,
    /// What started the request: `chat`, `heartbeat`, `cron`, `webhook`, `goal`, `voice-chat`, `meeting` or `dictation`.
    pub source_kind: Option<String>,
    /// The scheduled task, webhook or goal that started it, where the kind has one.
    pub source_id: Option<String>,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub no_cache_tokens: i64,
    /// The audio part of `no_cache_tokens`.
    pub audio_input_tokens: i64,
    /// The audio part of `output_tokens`.
    pub audio_output_tokens: i64,
    /// Estimated cost in millionths of a US dollar; `None` when no price is known for the model.
    pub cost_micro_usd: Option<i64>,
    /// Where the cost came from: `catalog`, `reported` or `subscription`.
    pub cost_source: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    /// `created_at` cut down to its 15-minute bucket, which period totals group by.
    #[serde(with = "crate::support::serde_iso")]
    pub bucket: DateTime<Utc>,
}

/// One `LlmCall` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = llm_calls, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewLlmCall {
    pub id: String,
    pub agent_id: String,
    pub subagent_id: Option<String>,
    pub purpose: String,
    pub model: String,
    pub thread_id: Option<String>,
    pub request_id: Option<String>,
    pub source_kind: Option<String>,
    pub source_id: Option<String>,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub no_cache_tokens: i64,
    pub audio_input_tokens: i64,
    pub audio_output_tokens: i64,
    pub cost_micro_usd: Option<i64>,
    pub cost_source: Option<String>,
    pub created_at: DbDateTime,
    pub bucket: DbDateTime,
}

impl NewLlmCall {
    pub fn new(
        agent_id: impl Into<String>,
        purpose: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            subagent_id: None,
            purpose: purpose.into(),
            model: model.into(),
            thread_id: None,
            request_id: None,
            source_kind: None,
            source_id: None,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            no_cache_tokens: 0,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
            cost_micro_usd: None,
            cost_source: None,
            created_at: now.into(),
            bucket: llm_call_bucket(now).into(),
        }
    }
}

/// The 15-minute bucket `llm_calls.bucket` stores for a call made at `at`.
pub fn llm_call_bucket(at: DateTime<Utc>) -> DateTime<Utc> {
    const BUCKET_MS: i64 = 15 * 60 * 1000;
    let ms = at.timestamp_millis();
    crate::support::from_ms(ms - ms.rem_euclid(BUCKET_MS))
}

/// A partial update of one `LlmCall` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = llm_calls, check_for_backend(Sqlite))]
pub struct LlmCallChangeset {
    pub agent_id: Option<String>,
    pub subagent_id: Option<Option<String>>,
    pub purpose: Option<String>,
    pub model: Option<String>,
    pub thread_id: Option<Option<String>>,
    pub request_id: Option<Option<String>>,
    pub source_kind: Option<Option<String>>,
    pub source_id: Option<Option<String>>,
    pub total_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub no_cache_tokens: Option<i64>,
    pub audio_input_tokens: Option<i64>,
    pub audio_output_tokens: Option<i64>,
    pub cost_micro_usd: Option<Option<i64>>,
    pub cost_source: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub bucket: Option<DbDateTime>,
}

// ---------------------------------------------------------------- MemoryEntry

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = memory_entries, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub agent_id: String,
    pub content: String,
    pub category: String,
    pub importance: i64,
    #[serde(with = "crate::db::sql_types::uint8_array::option")]
    pub embedding: Option<Vec<u8>>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `MemoryEntry` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = memory_entries, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewMemoryEntry {
    pub id: String,
    pub agent_id: String,
    pub content: String,
    pub category: String,
    pub importance: i64,
    pub embedding: Option<Vec<u8>>,
    pub created_at: DbDateTime,
}

impl NewMemoryEntry {
    pub fn new(
        agent_id: impl Into<String>,
        content: impl Into<String>,
        category: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            content: content.into(),
            category: category.into(),
            importance: 5,
            embedding: None,
            created_at: now.into(),
        }
    }
}

/// A partial update of one `MemoryEntry` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = memory_entries, check_for_backend(Sqlite))]
pub struct MemoryEntryChangeset {
    pub agent_id: Option<String>,
    pub content: Option<String>,
    pub category: Option<String>,
    pub importance: Option<i64>,
    pub embedding: Option<Option<Vec<u8>>>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- SlackMapping

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = slack_mappings, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct SlackMapping {
    pub id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub slack_user_id: Option<String>,
    pub lens_user_id: Option<String>,
    pub dm_channel_id: Option<String>,
    pub slack_channel_id: Option<String>,
    pub slack_channel_name: Option<String>,
    /// Team mode: the agent's "main" channel — where heartbeat alerts (and
    /// scheduled tasks with no resolvable origin channel) are posted. At most one
    /// channel mapping per agent is flagged; delivery falls back to the oldest
    /// linked channel when none is flagged (see `SLACK_MAPPING_SERVICE.get_main_channel`).
    pub is_main_channel: bool,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `SlackMapping` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = slack_mappings, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewSlackMapping {
    pub id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub slack_user_id: Option<String>,
    pub lens_user_id: Option<String>,
    pub dm_channel_id: Option<String>,
    pub slack_channel_id: Option<String>,
    pub slack_channel_name: Option<String>,
    pub is_main_channel: bool,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewSlackMapping {
    pub fn new(connection_id: impl Into<String>, agent_id: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            connection_id: connection_id.into(),
            agent_id: agent_id.into(),
            slack_user_id: None,
            lens_user_id: None,
            dm_channel_id: None,
            slack_channel_id: None,
            slack_channel_name: None,
            is_main_channel: false,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `SlackMapping` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = slack_mappings, check_for_backend(Sqlite))]
pub struct SlackMappingChangeset {
    pub connection_id: Option<String>,
    pub agent_id: Option<String>,
    pub slack_user_id: Option<Option<String>>,
    pub lens_user_id: Option<Option<String>>,
    pub dm_channel_id: Option<Option<String>>,
    pub slack_channel_id: Option<Option<String>>,
    pub slack_channel_name: Option<Option<String>>,
    pub is_main_channel: Option<bool>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for SlackMappingChangeset {
    fn default() -> Self {
        Self {
            connection_id: None,
            agent_id: None,
            slack_user_id: None,
            lens_user_id: None,
            dm_channel_id: None,
            slack_channel_id: None,
            slack_channel_name: None,
            is_main_channel: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- SlackVerificationCode

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = slack_verification_codes, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct SlackVerificationCode {
    pub id: String,
    pub code: String,
    #[diesel(column_name = type_)]
    pub r#type: SlackVerificationType,
    pub lens_user_id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub agent_name: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub expires_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `SlackVerificationCode` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = slack_verification_codes, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewSlackVerificationCode {
    pub id: String,
    pub code: String,
    #[diesel(column_name = type_)]
    pub r#type: SlackVerificationType,
    pub lens_user_id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub expires_at: DbDateTime,
    pub created_at: DbDateTime,
}

impl NewSlackVerificationCode {
    pub fn new(
        code: impl Into<String>,
        r#type: SlackVerificationType,
        lens_user_id: impl Into<String>,
        connection_id: impl Into<String>,
        agent_id: impl Into<String>,
        expires_at: DateTime<Utc>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            code: code.into(),
            r#type,
            lens_user_id: lens_user_id.into(),
            connection_id: connection_id.into(),
            agent_id: agent_id.into(),
            agent_name: None,
            expires_at: expires_at.into(),
            created_at: now.into(),
        }
    }
}

/// A partial update of one `SlackVerificationCode` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = slack_verification_codes, check_for_backend(Sqlite))]
pub struct SlackVerificationCodeChangeset {
    pub code: Option<String>,
    #[diesel(column_name = type_)]
    pub r#type: Option<SlackVerificationType>,
    pub lens_user_id: Option<String>,
    pub connection_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<Option<String>>,
    pub expires_at: Option<DbDateTime>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- TeamsMapping

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = teams_mappings, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct TeamsMapping {
    pub id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub tenant_id: Option<String>,
    /// Personal (DM) mapping: the Teams user (AAD object id when present, else
    /// the Bot Framework id) linked to a Lens user, plus the personal-scope
    /// conversation id — the target every proactive DM send is addressed to.
    pub teams_user_id: Option<String>,
    pub lens_user_id: Option<String>,
    pub dm_conversation_id: Option<String>,
    /// Team mode: a linked channel. The conversation id is stored WITHOUT any
    /// ";messageid=" thread suffix so lookups and broadcast targeting stay stable.
    pub channel_conversation_id: Option<String>,
    pub channel_name: Option<String>,
    /// Team mode: the agent's "main" channel — where heartbeat alerts (and
    /// scheduled tasks with no resolvable origin channel) are posted. At most one
    /// channel mapping per agent is flagged; delivery falls back to the oldest
    /// linked channel when none is flagged (see `TEAMS_MAPPING_SERVICE.get_main_channel`).
    pub is_main_channel: bool,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `TeamsMapping` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = teams_mappings, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewTeamsMapping {
    pub id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub tenant_id: Option<String>,
    pub teams_user_id: Option<String>,
    pub lens_user_id: Option<String>,
    pub dm_conversation_id: Option<String>,
    pub channel_conversation_id: Option<String>,
    pub channel_name: Option<String>,
    pub is_main_channel: bool,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewTeamsMapping {
    pub fn new(connection_id: impl Into<String>, agent_id: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            connection_id: connection_id.into(),
            agent_id: agent_id.into(),
            tenant_id: None,
            teams_user_id: None,
            lens_user_id: None,
            dm_conversation_id: None,
            channel_conversation_id: None,
            channel_name: None,
            is_main_channel: false,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `TeamsMapping` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = teams_mappings, check_for_backend(Sqlite))]
pub struct TeamsMappingChangeset {
    pub connection_id: Option<String>,
    pub agent_id: Option<String>,
    pub tenant_id: Option<Option<String>>,
    pub teams_user_id: Option<Option<String>>,
    pub lens_user_id: Option<Option<String>>,
    pub dm_conversation_id: Option<Option<String>>,
    pub channel_conversation_id: Option<Option<String>>,
    pub channel_name: Option<Option<String>>,
    pub is_main_channel: Option<bool>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for TeamsMappingChangeset {
    fn default() -> Self {
        Self {
            connection_id: None,
            agent_id: None,
            tenant_id: None,
            teams_user_id: None,
            lens_user_id: None,
            dm_conversation_id: None,
            channel_conversation_id: None,
            channel_name: None,
            is_main_channel: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- TeamsVerificationCode

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = teams_verification_codes, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct TeamsVerificationCode {
    pub id: String,
    pub code: String,
    #[diesel(column_name = type_)]
    pub r#type: TeamsVerificationType,
    pub lens_user_id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub agent_name: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub expires_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `TeamsVerificationCode` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = teams_verification_codes, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewTeamsVerificationCode {
    pub id: String,
    pub code: String,
    #[diesel(column_name = type_)]
    pub r#type: TeamsVerificationType,
    pub lens_user_id: String,
    pub connection_id: String,
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub expires_at: DbDateTime,
    pub created_at: DbDateTime,
}

impl NewTeamsVerificationCode {
    pub fn new(
        code: impl Into<String>,
        r#type: TeamsVerificationType,
        lens_user_id: impl Into<String>,
        connection_id: impl Into<String>,
        agent_id: impl Into<String>,
        expires_at: DateTime<Utc>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            code: code.into(),
            r#type,
            lens_user_id: lens_user_id.into(),
            connection_id: connection_id.into(),
            agent_id: agent_id.into(),
            agent_name: None,
            expires_at: expires_at.into(),
            created_at: now.into(),
        }
    }
}

/// A partial update of one `TeamsVerificationCode` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = teams_verification_codes, check_for_backend(Sqlite))]
pub struct TeamsVerificationCodeChangeset {
    pub code: Option<String>,
    #[diesel(column_name = type_)]
    pub r#type: Option<TeamsVerificationType>,
    pub lens_user_id: Option<String>,
    pub connection_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<Option<String>>,
    pub expires_at: Option<DbDateTime>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- AgentSubagent

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = agent_subagents, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AgentSubagent {
    pub id: String,
    pub parent_agent_id: String,
    pub child_agent_id: String,
    pub description: String,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `AgentSubagent` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = agent_subagents, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewAgentSubagent {
    pub id: String,
    pub parent_agent_id: String,
    pub child_agent_id: String,
    pub description: String,
    pub created_at: DbDateTime,
}

impl NewAgentSubagent {
    pub fn new(parent_agent_id: impl Into<String>, child_agent_id: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            parent_agent_id: parent_agent_id.into(),
            child_agent_id: child_agent_id.into(),
            description: "".to_string(),
            created_at: now.into(),
        }
    }
}

/// A partial update of one `AgentSubagent` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = agent_subagents, check_for_backend(Sqlite))]
pub struct AgentSubagentChangeset {
    pub parent_agent_id: Option<String>,
    pub child_agent_id: Option<String>,
    pub description: Option<String>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- SlackHeartbeatTrigger

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = slack_heartbeat_triggers, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct SlackHeartbeatTrigger {
    pub id: String,
    pub connection_id: String,
    pub slack_channel_id: String,
    pub slack_channel_name: Option<String>,
    pub agent_id: String,
    pub user_id: String,
    pub is_active: bool,
    pub throttle_seconds: i64,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_triggered_at: Option<DateTime<Utc>>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `SlackHeartbeatTrigger` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = slack_heartbeat_triggers, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewSlackHeartbeatTrigger {
    pub id: String,
    pub connection_id: String,
    pub slack_channel_id: String,
    pub slack_channel_name: Option<String>,
    pub agent_id: String,
    pub user_id: String,
    pub is_active: bool,
    pub throttle_seconds: i64,
    pub last_triggered_at: Option<DateTime<Utc>>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewSlackHeartbeatTrigger {
    pub fn new(
        connection_id: impl Into<String>,
        slack_channel_id: impl Into<String>,
        agent_id: impl Into<String>,
        user_id: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            connection_id: connection_id.into(),
            slack_channel_id: slack_channel_id.into(),
            slack_channel_name: None,
            agent_id: agent_id.into(),
            user_id: user_id.into(),
            is_active: true,
            throttle_seconds: 60,
            last_triggered_at: None,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `SlackHeartbeatTrigger` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = slack_heartbeat_triggers, check_for_backend(Sqlite))]
pub struct SlackHeartbeatTriggerChangeset {
    pub connection_id: Option<String>,
    pub slack_channel_id: Option<String>,
    pub slack_channel_name: Option<Option<String>>,
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub is_active: Option<bool>,
    pub throttle_seconds: Option<i64>,
    pub last_triggered_at: Option<Option<DateTime<Utc>>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for SlackHeartbeatTriggerChangeset {
    fn default() -> Self {
        Self {
            connection_id: None,
            slack_channel_id: None,
            slack_channel_name: None,
            agent_id: None,
            user_id: None,
            is_active: None,
            throttle_seconds: None,
            last_triggered_at: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- PendingSlackMessage

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = pending_slack_messages, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct PendingSlackMessage {
    pub id: String,
    pub agent_id: String,
    pub sender: String,
    pub text: String,
    pub timestamp: String,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One `PendingSlackMessage` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = pending_slack_messages, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewPendingSlackMessage {
    pub id: String,
    pub agent_id: String,
    pub sender: String,
    pub text: String,
    pub timestamp: String,
    pub created_at: DbDateTime,
}

impl NewPendingSlackMessage {
    pub fn new(
        agent_id: impl Into<String>,
        sender: impl Into<String>,
        text: impl Into<String>,
        timestamp: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            sender: sender.into(),
            text: text.into(),
            timestamp: timestamp.into(),
            created_at: now.into(),
        }
    }
}

/// A partial update of one `PendingSlackMessage` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = pending_slack_messages, check_for_backend(Sqlite))]
pub struct PendingSlackMessageChangeset {
    pub agent_id: Option<String>,
    pub sender: Option<String>,
    pub text: Option<String>,
    pub timestamp: Option<String>,
    pub created_at: Option<DbDateTime>,
}

// ---------------------------------------------------------------- WebhookSubscription

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = webhook_subscriptions, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct WebhookSubscription {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: Option<String>,
    /// comma-separated allowlist; null/empty = all events
    pub events: Option<String>,
    /// template; null/empty = raw payload dump
    pub prompt: Option<String>,
    /// 'all' | 'chat' | 'slack' | 'teams' | 'none'
    pub deliver_to: String,
    /// Comma-separated linked Slack channel ids a 'slack' delivery posts to;
    /// null = the DM, else the main channel.
    pub slack_channel_ids: Option<String>,
    pub deliver_only: bool,
    pub is_active: bool,
    /// Seconds after an agent-mode delivery in which later deliveries join its run;
    /// null = one run per delivery.
    pub coalesce_seconds: Option<i64>,
    pub auth_type: WebhookAuthType,
    /// header carrying the token/signature
    pub auth_header: Option<String>,
    /// literal stripped before comparing (e.g. 'sha256=')
    pub auth_prefix: Option<String>,
    /// hmac only
    pub auth_algorithm: WebhookAuthAlgorithm,
    /// hmac only
    pub auth_encoding: WebhookAuthEncoding,
    /// hmac only: URL the sender signs after the body
    pub auth_signed_url: Option<String>,
    /// shared token / HMAC key; never leaves the process
    pub secret: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `WebhookSubscription` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = webhook_subscriptions, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewWebhookSubscription {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: Option<String>,
    pub events: Option<String>,
    pub prompt: Option<String>,
    pub deliver_to: String,
    pub slack_channel_ids: Option<String>,
    pub deliver_only: bool,
    pub is_active: bool,
    pub coalesce_seconds: Option<i64>,
    pub auth_type: WebhookAuthType,
    pub auth_header: Option<String>,
    pub auth_prefix: Option<String>,
    pub auth_algorithm: WebhookAuthAlgorithm,
    pub auth_encoding: WebhookAuthEncoding,
    pub auth_signed_url: Option<String>,
    pub secret: Option<String>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewWebhookSubscription {
    pub fn new(agent_id: impl Into<String>, name: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            name: name.into(),
            description: None,
            events: None,
            prompt: None,
            deliver_to: "all".to_string(),
            slack_channel_ids: None,
            deliver_only: false,
            is_active: true,
            coalesce_seconds: None,
            auth_type: WebhookAuthType::Token,
            auth_header: None,
            auth_prefix: None,
            auth_algorithm: WebhookAuthAlgorithm::Sha256,
            auth_encoding: WebhookAuthEncoding::Hex,
            auth_signed_url: None,
            secret: None,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `WebhookSubscription` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = webhook_subscriptions, check_for_backend(Sqlite))]
pub struct WebhookSubscriptionChangeset {
    pub agent_id: Option<String>,
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub events: Option<Option<String>>,
    pub prompt: Option<Option<String>>,
    pub deliver_to: Option<String>,
    pub slack_channel_ids: Option<Option<String>>,
    pub deliver_only: Option<bool>,
    pub is_active: Option<bool>,
    pub coalesce_seconds: Option<Option<i64>>,
    pub auth_type: Option<WebhookAuthType>,
    pub auth_header: Option<Option<String>>,
    pub auth_prefix: Option<Option<String>>,
    pub auth_algorithm: Option<WebhookAuthAlgorithm>,
    pub auth_encoding: Option<WebhookAuthEncoding>,
    pub auth_signed_url: Option<Option<String>>,
    pub secret: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for WebhookSubscriptionChangeset {
    fn default() -> Self {
        Self {
            agent_id: None,
            name: None,
            description: None,
            events: None,
            prompt: None,
            deliver_to: None,
            slack_channel_ids: None,
            deliver_only: None,
            is_active: None,
            coalesce_seconds: None,
            auth_type: None,
            auth_header: None,
            auth_prefix: None,
            auth_algorithm: None,
            auth_encoding: None,
            auth_signed_url: None,
            secret: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- WebhookRun

/// One webhook event the runtime accepted: an agent run or a deliver-only
/// publish, read by the Activity page. `name` is the subscription's name at the
/// time, with no relation to the subscription, so deleting one keeps its runs.
/// Bounded at `MAX_WEBHOOK_RUNS`, trimmed at insert.
#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = webhook_runs, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct WebhookRun {
    /// the runId the receiver answered with
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub event: String,
    /// `WEBHOOK_RUN_STATUSES`
    pub status: String,
    pub error: Option<String>,
    /// The message the run delivered, if it delivered one.
    pub message_id: Option<String>,
    /// The id of the earlier event whose agent run also handled this one; null when the
    /// event led its own run.
    pub coalesced_into: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub finished_at: Option<DateTime<Utc>>,
}

/// One `WebhookRun` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = webhook_runs, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewWebhookRun {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub event: String,
    pub status: String,
    pub error: Option<String>,
    pub message_id: Option<String>,
    pub coalesced_into: Option<String>,
    pub created_at: DbDateTime,
    pub finished_at: Option<DateTime<Utc>>,
}

impl NewWebhookRun {
    pub fn new(
        id: impl Into<String>,
        agent_id: impl Into<String>,
        name: impl Into<String>,
        event: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: id.into(),
            agent_id: agent_id.into(),
            name: name.into(),
            event: event.into(),
            status: status.into(),
            error: None,
            message_id: None,
            coalesced_into: None,
            created_at: now.into(),
            finished_at: None,
        }
    }
}

/// A partial update of one `WebhookRun` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = webhook_runs, check_for_backend(Sqlite))]
pub struct WebhookRunChangeset {
    pub agent_id: Option<String>,
    pub name: Option<String>,
    pub event: Option<String>,
    pub status: Option<String>,
    pub error: Option<Option<String>>,
    pub message_id: Option<Option<String>>,
    pub coalesced_into: Option<Option<String>>,
    pub created_at: Option<DbDateTime>,
    pub finished_at: Option<Option<DateTime<Utc>>>,
}

// ---------------------------------------------------------------- RemoteComputer

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = remote_computers, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct RemoteComputer {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    /// A UUID the client creates once per installation, so adding the same
    /// installation again finds its own row rather than another one's name.
    pub installation_id: Option<String>,
    /// macos | windows | linux, from the last `initialize`
    pub platform: Option<String>,
    pub client_version: Option<String>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_connected_at: Option<DateTime<Utc>>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `RemoteComputer` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = remote_computers, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewRemoteComputer {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub installation_id: Option<String>,
    pub platform: Option<String>,
    pub client_version: Option<String>,
    pub last_connected_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewRemoteComputer {
    pub fn new(agent_id: impl Into<String>, name: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            agent_id: agent_id.into(),
            name: name.into(),
            installation_id: None,
            platform: None,
            client_version: None,
            last_connected_at: None,
            last_seen_at: None,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `RemoteComputer` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = remote_computers, check_for_backend(Sqlite))]
pub struct RemoteComputerChangeset {
    pub agent_id: Option<String>,
    pub name: Option<String>,
    pub installation_id: Option<Option<String>>,
    pub platform: Option<Option<String>>,
    pub client_version: Option<Option<String>>,
    pub last_connected_at: Option<Option<DateTime<Utc>>>,
    pub last_seen_at: Option<Option<DateTime<Utc>>>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for RemoteComputerChangeset {
    fn default() -> Self {
        Self {
            agent_id: None,
            name: None,
            installation_id: None,
            platform: None,
            client_version: None,
            last_connected_at: None,
            last_seen_at: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- UpdateAttempt

#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = update_attempts, check_for_backend(Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct UpdateAttempt {
    pub id: String,
    pub version_from: String,
    pub version_to: String,
    pub trigger: UpdateTrigger,
    pub outcome: UpdateOutcome,
    /// download_failed | asset_not_found | verify_failed | swap_failed | spawn_failed | restart_version_mismatch
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub finished_at: Option<DateTime<Utc>>,
}

/// One `UpdateAttempt` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = update_attempts, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewUpdateAttempt {
    pub id: String,
    pub version_from: String,
    pub version_to: String,
    pub trigger: UpdateTrigger,
    pub outcome: UpdateOutcome,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    pub started_at: DbDateTime,
    pub finished_at: Option<DateTime<Utc>>,
}

impl NewUpdateAttempt {
    pub fn new(
        version_from: impl Into<String>,
        version_to: impl Into<String>,
        trigger: UpdateTrigger,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            version_from: version_from.into(),
            version_to: version_to.into(),
            trigger,
            outcome: UpdateOutcome::Pending,
            error_code: None,
            error_detail: None,
            started_at: now.into(),
            finished_at: None,
        }
    }
}

/// A partial update of one `UpdateAttempt` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
#[derive(Debug, Clone, Default, PartialEq, AsChangeset)]
#[diesel(table_name = update_attempts, check_for_backend(Sqlite))]
pub struct UpdateAttemptChangeset {
    pub version_from: Option<String>,
    pub version_to: Option<String>,
    pub trigger: Option<UpdateTrigger>,
    pub outcome: Option<UpdateOutcome>,
    pub error_code: Option<Option<String>>,
    pub error_detail: Option<Option<String>>,
    pub started_at: Option<DbDateTime>,
    pub finished_at: Option<Option<DateTime<Utc>>>,
}

// ---------------------------------------------------------------- RuntimeState

/// Deployment state, keyed by name: what this install was doing last time,
/// rather than anything about the agent. `lastExecutionEnvironment` holds
/// `local` or `docker`. `singleThread` holds the id of single-thread mode's one
/// conversation, so no later write to another thread moves it.
/// `codingAgentSubscription:<agent>` holds `on` while that coding agent's tasks
/// run on the user's own subscription (`lib/coding_agents/subscription_switch.rs`).
///
/// The table exists to make the storage migration run once per change of environment.
/// That migration copies only what the destination lacks, so repeating it would
/// overwrite nothing — except that a file deleted on one side is still on the
/// other, and a repeat copies it back. Recording where the last run happened is
/// what keeps a deletion deleted.
///
/// A table rather than a column on `AgentWorkspace`, because `index.rs` reads
/// it about ninety lines before `resolve_or_bootstrap_single_agent` creates the row
/// a column would sit on.
#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = runtime_state, check_for_backend(Sqlite), primary_key(key))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    /// What the value is about, e.g. `lastExecutionEnvironment`.
    pub key: String,
    /// The value itself, e.g. `docker`.
    pub value: String,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `RuntimeState` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = runtime_state, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewRuntimeState {
    pub key: String,
    pub value: String,
    pub updated_at: DbDateTime,
}

impl NewRuntimeState {
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            key: key.into(),
            value: value.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `RuntimeState` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = runtime_state, check_for_backend(Sqlite))]
pub struct RuntimeStateChangeset {
    pub value: Option<String>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for RuntimeStateChangeset {
    fn default() -> Self {
        Self {
            value: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}

// ---------------------------------------------------------------- PendingWork

/// Work the agent has accepted and not finished: a reply it owes, a webhook
/// run, a coding task. The owner writes the row before the work starts and
/// deletes it when the work ends, so a row the boot finds is work a restart
/// interrupted. `PENDING_WORK_SERVICE` gives it back to its owner, which
/// continues it.
#[derive(Debug, Clone, PartialEq, Queryable, Selectable, Identifiable, Serialize, Deserialize)]
#[diesel(table_name = pending_work, check_for_backend(Sqlite), primary_key(kind, key))]
#[serde(rename_all = "camelCase")]
pub struct PendingWork {
    /// The owner, e.g. `chat`.
    pub kind: String,
    /// The owner's id for the work, unique within its kind.
    pub key: String,
    /// What the owner needs to continue the work.
    pub payload: Value,
    /// How many boots have given this work back. Work that stops its own process
    /// every time is dropped after `MAX_RESUME_ATTEMPTS`.
    pub attempts: i64,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
}

/// One `PendingWork` row to insert. [`Self::new`] takes the fields the schema requires
/// without a default and applies every `@default`, as the Prisma client does.
#[derive(Debug, Clone, PartialEq, Insertable)]
#[diesel(table_name = pending_work, check_for_backend(Sqlite), treat_none_as_default_value = false)]
pub struct NewPendingWork {
    pub kind: String,
    pub key: String,
    pub payload: DbJson,
    pub attempts: i64,
    pub created_at: DbDateTime,
    pub updated_at: DbDateTime,
}

impl NewPendingWork {
    pub fn new(kind: impl Into<String>, key: impl Into<String>, payload: Value) -> Self {
        let now = Utc::now();
        Self {
            kind: kind.into(),
            key: key.into(),
            payload: payload.into(),
            attempts: 0,
            created_at: now.into(),
            updated_at: now.into(),
        }
    }
}

/// A partial update of one `PendingWork` row: a `None` field is left as it is, and
/// `Some(None)` writes NULL.
/// [`Default`] stamps `updated_at`, as `@updatedAt` does.
#[derive(Debug, Clone, PartialEq, AsChangeset)]
#[diesel(table_name = pending_work, check_for_backend(Sqlite))]
pub struct PendingWorkChangeset {
    pub payload: Option<DbJson>,
    pub attempts: Option<i64>,
    pub created_at: Option<DbDateTime>,
    pub updated_at: Option<DbDateTime>,
}

impl Default for PendingWorkChangeset {
    fn default() -> Self {
        Self {
            payload: None,
            attempts: None,
            created_at: None,
            updated_at: Some(DbDateTime::now()),
        }
    }
}
