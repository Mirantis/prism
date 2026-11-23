//! Task Notification Service
//!
//! Owns the runtime's report that a coding task the agent started in a
//! conversation has ended. The report is stored in that conversation as a hidden
//! message under the task's id, and is then answered like any message there: a
//! turn running on the thread reads it at its next step, and otherwise a turn of
//! its own starts. The agent therefore ends its turn after it starts a task, and
//! the person can talk to it while the task runs.
//!
//! A channel that answers its messages in a queue of its own (the web socket's
//! one turn at a time) takes the stored report into that queue, the way it takes
//! a reply a restart interrupted, so the report waits behind another
//! conversation's turn like a person's message would.
//!
//! The task keeps its result until the report is stored, and the report is
//! stored at most once per task, so a restart in between sends it again exactly
//! once. From the store on, the report is a message owed an answer, which the
//! conversation engine keeps across a restart.

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_error;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata, StoredMessage, UserMessageInput,
};
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::inbound_message_service::find_message;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::types::TaskNotificationOrigin;

/// The conversation a task reports to, as the turn that started the task found it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotificationTarget {
    pub thread_id: String,
    pub agent_id: String,
    pub user_id: String,
    /// The channel the conversation's messages come from, as `collect_tools` names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel_id: Option<String>,
}

pub struct TaskNotificationService;

fn track(user_id: &str, agent_id: &str, thread_id: &str, task_id: &str, delivery: &str) {
    let mut props = IndexMap::new();
    props.insert("agent.id".to_string(), agent_id.to_string());
    props.insert("thread.id".to_string(), thread_id.to_string());
    props.insert("task.id".to_string(), task_id.to_string());
    props.insert("notification.delivery".to_string(), delivery.to_string());
    track_event("task notification delivered", Some(user_id), Some(props));
}

impl TaskNotificationService {
    /// Store the report `text` of task `task_id` and start or steer the turn that
    /// answers it. Resolves once the report is stored; the turn runs on.
    pub async fn deliver(
        &self,
        target: &TaskNotificationTarget,
        task_id: &str,
        text: &str,
    ) -> anyhow::Result<()> {
        if find_message(task_id).await?.is_some() {
            return Ok(());
        }

        let thread_id = CONVERSATION_SERVICE
            .writable_thread_id(&target.thread_id)
            .await?;
        let context = MESSAGE_DELIVERY_SERVICE
            .thread_context(
                &thread_id,
                target.origin_channel.as_deref(),
                target.origin_channel_id.as_deref(),
            )
            .await?;
        let metadata = ChatMetadata {
            channel: Some(context.context.channel),
            channel_id: context.context.channel_id.clone(),
            channel_thread_id: context.context.channel_thread_id.clone(),
            channel_label: context.channel_label.clone(),
            ..ChatMetadata::default()
        };
        let origin = TaskNotificationOrigin {
            task_id: task_id.to_string(),
        };
        let input = UserMessageInput {
            agent_id: target.agent_id.clone(),
            user_id: target.user_id.clone(),
            message: text.to_string(),
            metadata: Some(metadata.clone()),
            task_notification: Some(origin.clone()),
            ..UserMessageInput::default()
        };
        let stored = match CONVERSATION_ENGINE_SERVICE
            .accept_user_message(&input, &thread_id, Some(task_id))
            .await
        {
            Ok(stored) => stored,
            Err(err) => {
                // Returned: the task keeps its result, and the next boot reports it again.
                track(
                    &target.user_id,
                    &target.agent_id,
                    &thread_id,
                    task_id,
                    "failed",
                );
                return Err(err);
            }
        };

        if let Some(queue) = MESSAGE_DELIVERY_SERVICE.get_adapter(context.context.channel.as_str())
            && queue.answer_stored(&stored.message).is_some()
        {
            track(
                &target.user_id,
                &target.agent_id,
                &thread_id,
                task_id,
                "queued",
            );
            return Ok(());
        }
        let chat = ChatInput {
            agent_id: target.agent_id.clone(),
            user_id: target.user_id.clone(),
            message: text.to_string(),
            thread_id: Some(thread_id.clone()),
            stored: Some(StoredMessage {
                id: task_id.to_string(),
                title_set: None,
            }),
            task_notification: Some(origin),
            metadata: Some(metadata),
            ..ChatInput::default()
        };
        let (user_id, agent_id, task_id) = (
            target.user_id.clone(),
            target.agent_id.clone(),
            task_id.to_string(),
        );
        tokio::spawn(async move {
            match CONVERSATION_ENGINE_SERVICE.chat(chat).await {
                Ok(response) => {
                    let delivery = if response.steered == Some(true) {
                        "steered"
                    } else {
                        "turn"
                    };
                    track(&user_id, &agent_id, &thread_id, &task_id, delivery);
                }
                Err(err) => {
                    log_error!(
                        json!({ "err": err_json(&err), "threadId": thread_id, "taskId": task_id }),
                        "[TaskNotification] The turn that answers the notification failed"
                    );
                    track(&user_id, &agent_id, &thread_id, &task_id, "failed");
                }
            }
        });
        Ok(())
    }
}

pub static TASK_NOTIFICATION_SERVICE: LazyLock<TaskNotificationService> =
    LazyLock::new(|| TaskNotificationService);
