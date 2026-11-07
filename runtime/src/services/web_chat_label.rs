//! How the web chat appears in the agent's system prompt, for the channel
//! participation instructions it gets once a second person writes there.

use diesel::prelude::*;

use crate::db::schema::conversation_threads::dsl as t;
use crate::services::conversation_service::CONVERSATION_SERVICE;

pub const WEB_CHAT_LABEL: &str = "this agent's web chat, which every person who opens the agent sees, and where you address people by name, because the chat shows a token as text";

/// The label for a web conversation that two or more people wrote in. Read from
/// the thread's rows, so every turn on it agrees and the system prompt changes once.
/// A thread that a channel keeps its own id for is that channel's, and gets none.
pub async fn web_chat_label(thread_id: &str) -> anyhow::Result<Option<String>> {
    let id = thread_id.to_string();
    let thread = crate::db::run(move |conn| {
        Ok(t::conversation_threads
            .filter(t::id.eq(id))
            .select(t::external_thread_id)
            .first::<Option<String>>(conn)
            .optional()?)
    })
    .await?;
    // A missing thread, or one with an external id (an empty id is no id).
    let Some(external_thread_id) = thread else {
        return Ok(None);
    };
    if external_thread_id.is_some_and(|id| !id.is_empty()) {
        return Ok(None);
    }
    Ok(CONVERSATION_SERVICE
        .has_several_senders(thread_id)
        .await?
        .then(|| WEB_CHAT_LABEL.to_string()))
}
