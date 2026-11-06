//! Database Thread Provider
//!
//! Reads conversation messages from the database.
//! This is the default provider for web chat threads (`ThreadSource::Database`).

use async_trait::async_trait;

use crate::db::models::ConversationMessage;
use crate::services::thread_provider_interface::{
    MessageReadOptions, MessageView, ThreadMessageProvider,
};

/// The order rows are read in. A client's view breaks a tie on the timestamp by
/// id — the same rule every chat client applies to messages as they arrive live —
/// so two devices can never show the same moment in different orders. The model's
/// view keeps the order rows were written in, which a tie-break would change for
/// rows written in the same millisecond, and with it the prompt.
///
/// True when the read orders by `(createdAt, id)` rather than by `createdAt` alone.
fn client_order(opts: Option<&MessageReadOptions>) -> bool {
    opts.and_then(|o| o.view) == Some(MessageView::Client)
}

#[derive(Debug, Clone, Copy, Default)]
pub struct DatabaseThreadProvider;

impl DatabaseThreadProvider {
    pub fn new() -> Self {
        DatabaseThreadProvider
    }
}

#[async_trait]
impl ThreadMessageProvider for DatabaseThreadProvider {
    /// The model view hides compacted rows (their content lives in the thread's
    /// compaction summary) but keeps internal steps; the client view keeps
    /// compacted rows but hides internal steps.
    async fn get_messages(
        &self,
        thread_id: &str,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }

    /// Same two views as `get_messages`. Filters live in the WHERE clause (not
    /// post-fetch) so the limit yields `limit` *visible* rows — a long turn's
    /// hidden steps must not crowd the window. With `before`, the read ends
    /// strictly before that row in the client order `(createdAt, id)`; an id the
    /// view does not hold reads no messages. Returned in chronological order.
    async fn get_recent_messages(
        &self,
        thread_id: &str,
        limit: i64,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }
}
