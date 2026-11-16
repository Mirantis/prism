//! Continue the replies a restart interrupted: one exchange per thread, which
//! answers every message the thread was owed. A channel with a queue of its own
//! (`ChannelAdapter::continue_reply`) takes the reply into that queue. Every other
//! thread's turn starts at once.

use std::collections::{HashMap, HashSet};

use diesel::prelude::*;
use indexmap::IndexMap;
use serde_json::json;

use crate::db::models::ConversationMessage;
use crate::db::schema::conversation_messages::dsl as m;
use crate::lib::log_redaction::err_json;
use crate::prompts::agent_message_prompt::{AgentMessageColumns, agent_message_origin};
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatWork, StoredMessage, UserMessageInput,
};
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::services::pending_work_service::{
    PENDING_WORK_SERVICE, PendingWorkItem, PendingWorkKind,
};
use crate::types::ResumedReply;
use crate::{log_error, log_info, log_warn};

/// The columns of a stored message that name another agent as its sender.
fn origin_columns(message: &ConversationMessage) -> AgentMessageColumns {
    AgentMessageColumns {
        triggered_by: Some(message.triggered_by.as_str().to_string()),
        trigger_name: message.trigger_name.clone(),
        sender_external_id: message.sender_external_id.clone(),
        sender_name: message.sender_name.clone(),
        external_message_id: message.external_message_id.clone(),
    }
}

/// The `chat` owner's boot step: one resumed exchange per thread that was owed a
/// reply.
pub async fn resume_replies(items: Vec<PendingWorkItem>) -> anyhow::Result<()> {
    if items.is_empty() {
        return Ok(());
    }

    let mut work: HashMap<String, ChatWork> = HashMap::new();
    for item in &items {
        work.insert(
            item.key.clone(),
            serde_json::from_value(item.payload.clone())?,
        );
    }
    let keys: Vec<String> = items.iter().map(|item| item.key.clone()).collect();
    let found: Vec<String> = {
        let keys = keys.clone();
        crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::id.eq_any(&keys))
                .select(m::id)
                .load(conn)?)
        })
        .await?
    };
    let mut stored: HashSet<String> = found.into_iter().collect();
    for item in &items {
        let owed = &work[&item.key];
        if stored.contains(&item.key) {
            link_uploads(&item.key, owed).await;
        } else if store_message(&item.key, owed).await {
            stored.insert(item.key.clone());
        }
    }
    // A row whose message cannot be stored has nothing to answer: its thread is gone.
    PENDING_WORK_SERVICE.end(
        PendingWorkKind::Chat,
        keys.iter()
            .filter(|key| !stored.contains(*key))
            .cloned()
            .collect::<Vec<String>>(),
    );

    let owed: Vec<ConversationMessage> = {
        let ids: Vec<String> = stored.iter().cloned().collect();
        crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::id.eq_any(&ids))
                .order(m::created_at.asc())
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await?
    };
    let mut threads: IndexMap<String, Vec<ConversationMessage>> = IndexMap::new();
    for message in owed {
        threads
            .entry(message.thread_id.clone())
            .or_default()
            .push(message);
    }
    for (thread_id, messages) in threads {
        // A turn reads the thread that holds the messages. Single-thread mode hides every
        // other web thread and answers in the one conversation, which does not hold them.
        if CONVERSATION_SERVICE.writable_thread_id(&thread_id).await? != thread_id {
            log_info!(
                "Not continuing the reply on thread {}: single-thread mode hides it",
                thread_id
            );
            PENDING_WORK_SERVICE.end(
                PendingWorkKind::Chat,
                messages
                    .iter()
                    .map(|message| message.id.clone())
                    .collect::<Vec<String>>(),
            );
            continue;
        }
        let Some(newest) = messages.last() else {
            continue;
        };
        let newest_work = work[&newest.id].clone();
        let message_ids: Vec<String> = messages.iter().map(|message| message.id.clone()).collect();
        let unsaved = message_ids
            .iter()
            .flat_map(|id| {
                work.get(id)
                    .and_then(|owed| owed.unsaved.clone())
                    .unwrap_or_default()
            })
            .collect();
        // A restart while a resumed exchange moves these to its first row lists some twice.
        let mut unsent_attachment_ids: Vec<String> = Vec::new();
        for id in message_ids.iter().flat_map(|id| {
            work.get(id)
                .and_then(|owed| owed.unsent_attachment_ids.clone())
                .unwrap_or_default()
        }) {
            if !unsent_attachment_ids.contains(&id) {
                unsent_attachment_ids.push(id);
            }
        }
        log_info!(
            "Continuing the reply to {} message(s) on thread {}",
            message_ids.len(),
            thread_id
        );
        let resumed = ResumedReply {
            message_ids,
            unsaved,
            unsent_attachment_ids,
        };

        let queue = newest_work
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.channel)
            .and_then(|channel| MESSAGE_DELIVERY_SERVICE.get_adapter(channel.as_str()));
        if let Some(queue) = queue
            && queue.continue_reply(newest, &resumed).is_some()
        {
            continue;
        }
        let input = ChatInput {
            agent_id: newest_work.agent_id.clone(),
            user_id: newest_work.user_id.clone(),
            thread_id: Some(thread_id.clone()),
            message: newest.content.clone(),
            stored: Some(StoredMessage {
                id: newest.id.clone(),
                title_set: None,
            }),
            resumed: Some(resumed),
            metadata: newest_work.metadata.clone(),
            agent_message: agent_message_origin(&origin_columns(newest)),
            ..ChatInput::default()
        };
        tokio::spawn(async move {
            if let Err(err) = CONVERSATION_ENGINE_SERVICE.chat(input).await {
                log_error!(
                    json!({ "err": err_json(&err), "threadId": thread_id }),
                    "Could not continue the interrupted reply"
                );
            }
        });
    }
    Ok(())
}

/// Link the uploads of a stored message, which a restart between its insert and
/// the link leaves unlinked. The link claims only uploads that no message holds.
async fn link_uploads(id: &str, work: &ChatWork) {
    let uploads = work
        .message
        .as_ref()
        .and_then(|message| message.attachment_ids.clone())
        .unwrap_or_default();
    if uploads.is_empty() {
        return;
    }
    if let Err(err) = ATTACHMENT_SERVICE
        .link_to_message(&uploads, id, &work.thread_id)
        .await
    {
        log_warn!(
            json!({ "err": err_json(&err), "messageId": id }),
            "Could not link the uploads of a message a restart interrupted"
        );
    }
}

/// Store a message a restart stopped before its insert, from its row. False when
/// it cannot be stored.
async fn store_message(id: &str, work: &ChatWork) -> bool {
    let Some(message) = &work.message else {
        return false;
    };
    let input = UserMessageInput {
        agent_id: work.agent_id.clone(),
        user_id: work.user_id.clone(),
        metadata: work.metadata.clone(),
        message: message.message.clone(),
        attachment_ids: message.attachment_ids.clone(),
        agent_message: message.agent_message.clone(),
        runtime_written: message.runtime_written,
    };
    match CONVERSATION_ENGINE_SERVICE
        .accept_user_message(&input, &work.thread_id, Some(id))
        .await
    {
        Ok(_) => true,
        Err(err) => {
            log_warn!(
                json!({ "err": err_json(&err), "messageId": id }),
                "Could not store a message a restart interrupted"
            );
            false
        }
    }
}
