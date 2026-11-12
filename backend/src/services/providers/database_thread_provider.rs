//! Database Thread Provider
//!
//! Reads conversation messages from the database.
//! This is the default provider for web chat threads (`ThreadSource::Database`).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::Sqlite;

use crate::db::models::ConversationMessage;
use crate::db::schema::conversation_messages as m;
use crate::db::sql_types::DbDateTime;
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
        let client = client_order(opts);
        let thread_id = thread_id.to_string();
        crate::db::run(move |conn| {
            let query = m::table.filter(m::thread_id.eq(thread_id)).into_boxed();
            let query = if client {
                query
                    .filter(m::internal_step.eq(false))
                    .order((m::created_at.asc(), m::id.asc()))
            } else {
                query
                    .filter(m::is_compacted.eq(false))
                    .order(m::created_at.asc())
            };
            Ok(query.select(ConversationMessage::as_select()).load(conn)?)
        })
        .await
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
        let client = client_order(opts);
        let before = opts.and_then(|o| o.before.clone());
        let thread_id = thread_id.to_string();
        let mut messages = crate::db::run(move |conn| {
            let view = |query: m::BoxedQuery<'static, Sqlite>| {
                if client {
                    query.filter(m::internal_step.eq(false))
                } else {
                    query.filter(m::is_compacted.eq(false))
                }
            };
            let mut cursor: Option<(DateTime<Utc>, String)> = None;
            if let Some(before) = before {
                cursor = view(
                    m::table
                        .filter(m::id.eq(before))
                        .filter(m::thread_id.eq(thread_id.clone()))
                        .into_boxed(),
                )
                .select((m::created_at, m::id))
                .first(conn)
                .optional()?;
                if cursor.is_none() {
                    return Ok(Vec::new());
                }
            }
            let mut query = view(m::table.filter(m::thread_id.eq(thread_id)).into_boxed());
            // Strictly before the cursor in the client order: (createdAt, id).
            if let Some((created_at, id)) = cursor {
                query = query.filter(
                    m::created_at
                        .lt(DbDateTime(created_at))
                        .or(m::created_at.eq(DbDateTime(created_at)).and(m::id.lt(id))),
                );
            }
            let query = if client {
                query.order((m::created_at.desc(), m::id.desc()))
            } else {
                query.order(m::created_at.desc())
            };
            Ok(query
                .limit(limit)
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await?;
        messages.reverse(); // Return in chronological order
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{
        MessageRole, MessageTrigger, NewAgentWorkspace, NewConversationMessage,
        NewConversationThread,
    };
    use crate::db::schema::{agent_workspaces, conversation_threads};

    async fn seed() {
        let same_moment = crate::support::parse_iso("2026-10-20T08:00:00.000Z").unwrap();
        crate::db::run(move |conn| {
            let mut agent = NewAgentWorkspace::new("user-1", "", "", "", "", "");
            agent.id = "agent-1".into();
            diesel::insert_into(agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;
            let mut thread = NewConversationThread::new("agent-1", "user-1");
            thread.id = "thread-1".into();
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            // Written in this order, in one millisecond, with ids that sort the other way.
            for (id, role) in [
                ("message-b", MessageRole::Agent),
                ("message-a", MessageRole::User),
            ] {
                let mut row =
                    NewConversationMessage::new("thread-1", role, id, MessageTrigger::UserInput);
                row.id = id.into();
                row.created_at = DbDateTime(same_moment);
                diesel::insert_into(m::table).values(&row).execute(conn)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    }

    fn ids(messages: Vec<ConversationMessage>) -> Vec<String> {
        messages.into_iter().map(|m| m.id).collect()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_rows_of_one_millisecond_for_the_model_in_the_order_they_were_written() {
        let _db = crate::db::testing::test_db();
        seed().await;
        let provider = DatabaseThreadProvider::new();
        assert_eq!(
            ids(provider.get_messages("thread-1", None).await.unwrap()),
            ["message-b", "message-a"]
        );
        assert_eq!(
            ids(provider
                .get_recent_messages("thread-1", 10, None)
                .await
                .unwrap()),
            ["message-b", "message-a"]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_rows_of_one_millisecond_for_a_client_by_id() {
        let _db = crate::db::testing::test_db();
        seed().await;
        let provider = DatabaseThreadProvider::new();
        let view = MessageReadOptions {
            view: Some(MessageView::Client),
            before: None,
        };
        assert_eq!(
            ids(provider
                .get_messages("thread-1", Some(&view))
                .await
                .unwrap()),
            ["message-a", "message-b"]
        );
        assert_eq!(
            ids(provider
                .get_recent_messages("thread-1", 10, Some(&view))
                .await
                .unwrap()),
            ["message-a", "message-b"]
        );
        let before = MessageReadOptions {
            before: Some("message-b".into()),
            ..view.clone()
        };
        assert_eq!(
            ids(provider
                .get_recent_messages("thread-1", 10, Some(&before))
                .await
                .unwrap()),
            ["message-a"]
        );
        let unknown = MessageReadOptions {
            before: Some("message-z".into()),
            ..view
        };
        assert!(
            provider
                .get_recent_messages("thread-1", 10, Some(&unknown))
                .await
                .unwrap()
                .is_empty()
        );
    }
}
