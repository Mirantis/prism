//! Thread Message Provider Interface
//!
//! Abstracts how conversation messages are read from different sources.
//! Write operations (add a message, compaction) remain DB-only.
//! Thread metadata (CRUD, listing) remains DB-only.
//!
//! `DatabaseThreadProvider` reads the database and serves every thread by default.
//! A channel that keeps a thread's history in the channel itself registers a
//! live-read provider for its `ThreadSource` with
//! `CONVERSATION_SERVICE.register_thread_provider`. A live-read provider's message
//! ids (`external_message_id`) sort as numbers, oldest first.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::db::models::ConversationMessage;

/// Which projection of a thread a read returns.
///
/// - `Model` (the default): what the LLM replays. Every persisted step is
///   returned — concise-mode internal steps included — but compacted history is
///   hidden, since its content lives in the thread's compaction summary.
/// - `Client`: what users scroll. Compacted rows stay visible (compaction
///   only changes what the model sees) while concise-mode internal steps are
///   dropped.
///
/// The mechanics differ per provider for the same semantic:
/// - `DatabaseThreadProvider`: WHERE-clause filters on `isCompacted` (model view)
///   vs `internalStep` (client view).
/// - A live-read provider: the model view fetches only replies after the
///   thread's `compactedThroughTs` watermark (row flags can't hide messages read
///   live); the client view does NOT merge the persisted internal rows into the
///   replay (they were never posted to the channel).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageView {
    #[default]
    Model,
    Client,
}

impl MessageView {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageView::Model => "model",
            MessageView::Client => "client",
        }
    }
}

/// Read options shared by both providers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReadOptions {
    /// Which projection to read; see [`MessageView`]. Default: `Model`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<MessageView>,
    /// `get_recent_messages` only: a message id of this view. The read ends just
    /// before it, so a client pages back through history. An id the view does not
    /// hold reads no messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[async_trait]
pub trait ThreadMessageProvider: Send + Sync {
    /// Get a thread's messages in chronological order (see `MessageReadOptions`
    /// for which view).
    async fn get_messages(
        &self,
        thread_id: &str,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>>;

    /// Get the most recent messages for a thread, in chronological order (see
    /// `MessageReadOptions` for which view).
    async fn get_recent_messages(
        &self,
        thread_id: &str,
        limit: i64,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>>;
}
