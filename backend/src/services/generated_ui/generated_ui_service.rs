//! Generated UI as a message of its own: checking a spec against the catalog, the
//! images and the channel, posting it, and taking the first press of a button.
//!
//! The UI is stored on its message. Every lookup reads the first block, so a UI is
//! the only block on its message.

use std::sync::LazyLock;

use chrono::Utc;
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::db::schema::{conversation_messages, conversation_threads};
use crate::db::sql_types::DbJson;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_error;
use crate::protocol::chat_protocol::{
    GeneratedUiBlock, GeneratedUiElement, GeneratedUiPress, QuestionCardPerson,
};
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::channel_adapter_interface::{ChannelContext, ChannelName};
use crate::services::inbound_message_service::{
    INBOUND_MESSAGE_SERVICE, InboundMessage, InboundMessageError, InboundSender,
};
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::pending_work_service::{PENDING_WORK_SERVICE, PendingWorkKind};

use super::generated_ui_schema::{ParsedSpec, image_attachment_ids, parse_block, parse_spec};
use super::generated_ui_text::generated_ui_text;

/// The `trigger_name` of a stored message that is the press of a button.
pub const PRESS_TRIGGER_NAME: &str = "generated_ui_press";

/// The image media types every channel shows.
const IMAGE_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/gif"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedUiCaller {
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: String,
    pub origin_channel: ChannelName,
}

/// The spec did not pass, with what to fix.
#[derive(Debug, Clone, thiserror::Error)]
#[error("The UI was not shown. Fix these issues and call show_ui again:\n- {}", .issues.join("\n- "))]
pub struct GeneratedUiInvalid {
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PressOutcome {
    Pressed(GeneratedUiBlock),
    /// The press is stored and the next boot starts the turn, since the message could not be accepted.
    ReplyPending(GeneratedUiBlock),
    Closed(GeneratedUiBlock),
    Invalid(String),
    NotFound,
}

fn props(pairs: &[(&str, String)]) -> IndexMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

fn blocks_of(block: &GeneratedUiBlock) -> Value {
    json!([serde_json::to_value(block).expect("a generated UI serializes")])
}

/// The stored UI of a row, or `None` when its first block is not one.
fn ui_of(row: &ConversationMessage) -> Option<GeneratedUiBlock> {
    parse_block(row.blocks.as_ref()?.get(0)?)
}

/// The block after the press of `element_id`, or why that is not a press.
pub fn pressed_block(
    block: &GeneratedUiBlock,
    element_id: &str,
    by: Option<QuestionCardPerson>,
) -> Result<GeneratedUiBlock, &'static str> {
    let Some(GeneratedUiElement::Button { props }) = block.elements.get(element_id) else {
        return Err("That is not a button of this UI.");
    };
    Ok(GeneratedUiBlock {
        pressed: Some(GeneratedUiPress {
            element_id: element_id.to_string(),
            label: props.label.clone(),
            by,
        }),
        ..block.clone()
    })
}

/// Replaces the row's UI with `block` when no button of the stored one was pressed.
/// Answers whether it did.
pub fn replace_unpressed(
    conn: &mut SqliteConnection,
    row_id: &str,
    block: &GeneratedUiBlock,
) -> anyhow::Result<bool> {
    let current: Option<Option<Value>> = conversation_messages::table
        .find(row_id)
        .select(conversation_messages::blocks)
        .first(conn)
        .optional()?;
    let open = current
        .flatten()
        .as_ref()
        .and_then(|blocks| blocks.get(0))
        .and_then(parse_block)
        .is_some_and(|stored| stored.pressed.is_none());
    if !open {
        return Ok(false);
    }
    diesel::update(conversation_messages::table.find(row_id))
        .set(conversation_messages::blocks.eq(Some(DbJson(blocks_of(block)))))
        .execute(conn)?;
    Ok(true)
}

pub struct GeneratedUiService;

impl GeneratedUiService {
    /// The spec as a UI, after the catalog, the images and the channel's limits.
    pub async fn check(
        &self,
        caller: &GeneratedUiCaller,
        input: &Value,
    ) -> Result<ParsedSpec, GeneratedUiInvalid> {
        let checked = match parse_spec(input) {
            Ok(spec) => self.check_images(spec).await,
            Err(issues) => Err(issues),
        };
        let checked = checked.and_then(|spec| {
            let issues = MESSAGE_DELIVERY_SERVICE
                .get_adapter(caller.origin_channel.as_str())
                .map(|adapter| adapter.generated_ui_issues(&spec.root, &spec.elements))
                .unwrap_or_default();
            if issues.is_empty() {
                Ok(spec)
            } else {
                Err(issues)
            }
        });
        checked.map_err(|issues| {
            track_event(
                "generated ui invalid",
                Some(&caller.user_id),
                Some(props(&[
                    ("agent.id", caller.agent_id.clone()),
                    ("thread.id", caller.thread_id.clone()),
                    ("channel", caller.origin_channel.as_str().to_string()),
                    ("issues", issues.len().to_string()),
                ])),
            );
            GeneratedUiInvalid { issues }
        })
    }

    /// Each image names a file shared in this turn and not yet on a message, of a type every channel shows.
    async fn check_images(&self, spec: ParsedSpec) -> Result<ParsedSpec, Vec<String>> {
        let mut issues = Vec::new();
        for id in image_attachment_ids(&spec.elements) {
            let row = ATTACHMENT_SERVICE.get_by_id(&id).await.ok().flatten();
            let usable = row.as_ref().is_some_and(|row| {
                row.message_id.is_none() && IMAGE_TYPES.contains(&row.media_type.as_str())
            });
            if !usable {
                issues.push(format!(
                    "attachment:{id}: is not a PNG, JPEG or GIF that you shared with share_file in this turn"
                ));
            }
        }
        if issues.is_empty() {
            Ok(spec)
        } else {
            Err(issues)
        }
    }

    /// Posts the UI as a message of its own, with its images, and no feedback prompt.
    pub async fn publish(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        channel_context: Option<ChannelContext>,
        spec: ParsedSpec,
    ) -> anyhow::Result<ConversationMessage> {
        let content = generated_ui_text(&spec.root, &spec.elements);
        let attachment_ids = image_attachment_ids(&spec.elements);
        let block = spec.into_block(uuid::Uuid::new_v4().to_string());
        let channel = channel_context
            .as_ref()
            .map_or("none", |context| context.channel.as_str());
        let posted = props(&posted_props(agent_id, thread_id, &block, channel));
        let message = MESSAGE_DELIVERY_SERVICE
            .publish(
                user_id,
                thread_id,
                &content,
                MessageTrigger::UserInput,
                PublishOptions {
                    blocks: Some(vec![serde_json::to_value(&block)?]),
                    attachment_ids: (!attachment_ids.is_empty()).then_some(attachment_ids),
                    channel_context: channel_context.map(|context| ChannelContext {
                        include_feedback: Some(false),
                        ..context
                    }),
                    ..Default::default()
                },
            )
            .await?;
        track_event("generated ui posted", Some(user_id), Some(posted));
        Ok(message)
    }

    /// Takes the first press of a button in a web conversation. One transaction
    /// marks the press and writes the `pending_work` row of the press message, so a
    /// restart keeps the press and only the first press is stored.
    pub async fn press(
        &self,
        agent_id: &str,
        user_id: &str,
        id: &str,
        element_id: &str,
        sender: Option<QuestionCardPerson>,
    ) -> anyhow::Result<PressOutcome> {
        let Some((row, block)) = self.find(agent_id, user_id, id).await? else {
            return Ok(PressOutcome::NotFound);
        };
        if let Err(error) = INBOUND_MESSAGE_SERVICE
            .check_thread(&row.thread_id, agent_id)
            .await
        {
            if error.downcast_ref::<InboundMessageError>().is_some() {
                return Ok(PressOutcome::NotFound);
            }
            return Err(error);
        }
        if block.pressed.is_some() {
            return Ok(PressOutcome::Closed(block));
        }
        let pressed = match pressed_block(&block, element_id, sender.clone()) {
            Ok(pressed) => pressed,
            Err(error) => return Ok(PressOutcome::Invalid(error.to_string())),
        };
        let label = pressed
            .pressed
            .as_ref()
            .map(|p| p.label.clone())
            .unwrap_or_default();
        let message = InboundMessage {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id: row.thread_id.clone(),
            content: label,
            attachment_ids: Vec::new(),
            sender: sender.map(|person| InboundSender {
                id: person.id,
                name: person.name,
            }),
            agent_message: None,
            // A later boot can store this message after the agent has posted newer messages.
            runtime_written: true,
            task_notification: None,
        };
        let payload = serde_json::to_value(INBOUND_MESSAGE_SERVICE.pending_work_for(&message))?;
        let (row_id, written) = (row.id.clone(), pressed.clone());
        let won = PENDING_WORK_SERVICE
            .begin_with(PendingWorkKind::Chat, &message.id, payload, move |conn| {
                replace_unpressed(conn, &row_id, &written)
            })
            .await?;
        if !won {
            let current = self
                .find(agent_id, user_id, id)
                .await?
                .map_or(block, |(_, stored)| stored);
            return Ok(PressOutcome::Closed(current));
        }

        self.pressed(agent_id, user_id, &row, &pressed, ChannelName::Websocket);
        self.show(agent_id, user_id, &row, &pressed).await;
        // Boxed, since the accept future is large.
        if let Err(error) = Box::pin(INBOUND_MESSAGE_SERVICE.accept(message)).await {
            self.step_failed(
                "accept",
                &error,
                agent_id,
                user_id,
                &row.thread_id,
                &block.id,
            );
            return Ok(PressOutcome::ReplyPending(pressed));
        }
        Ok(PressOutcome::Pressed(pressed))
    }

    /// The row whose UI has this id, in the agent's conversations with the user, and its UI.
    pub async fn find(
        &self,
        agent_id: &str,
        user_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<(ConversationMessage, GeneratedUiBlock)>> {
        let (agent_id, user_id) = (agent_id.to_string(), user_id.to_string());
        let rows: Vec<ConversationMessage> = crate::db::read(move |conn| {
            Ok(conversation_messages::table
                .inner_join(conversation_threads::table)
                .filter(conversation_threads::agent_id.eq(agent_id))
                .filter(conversation_threads::user_id.eq(user_id))
                .filter(conversation_messages::blocks.is_not_null())
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await?;
        Ok(rows.into_iter().find_map(|row| {
            let block = ui_of(&row).filter(|block| block.id == id)?;
            Some((row, block))
        }))
    }

    /// The `generated ui pressed` event, emitted once per taken press.
    pub fn pressed(
        &self,
        agent_id: &str,
        user_id: &str,
        row: &ConversationMessage,
        block: &GeneratedUiBlock,
        channel: ChannelName,
    ) {
        track_event(
            "generated ui pressed",
            Some(user_id),
            Some(props(&[
                ("agent.id", agent_id.to_string()),
                ("thread.id", row.thread_id.clone()),
                ("generated_ui.id", block.id.clone()),
                ("channel", channel.as_str().to_string()),
                (
                    "elapsed_ms",
                    (Utc::now() - row.created_at).num_milliseconds().to_string(),
                ),
            ])),
        );
    }

    /// Every open client shows the changed UI. The stored UI is already right, so a failure here stops nothing.
    pub async fn show(
        &self,
        agent_id: &str,
        user_id: &str,
        row: &ConversationMessage,
        block: &GeneratedUiBlock,
    ) {
        let shown = ConversationMessage {
            blocks: Some(blocks_of(block)),
            ..row.clone()
        };
        if let Err(error) = MESSAGE_DELIVERY_SERVICE
            .show_in_conversation(user_id, &shown)
            .await
        {
            self.step_failed("show", &error, agent_id, user_id, &row.thread_id, &block.id);
        }
    }

    pub fn step_failed(
        &self,
        step: &str,
        error: &anyhow::Error,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        ui_id: &str,
    ) {
        log_error!(
            json!({ "err": err_json(error), "generatedUiId": ui_id, "step": step }),
            "[GeneratedUi] A step after the press failed"
        );
        track_event(
            "generated ui step failed",
            Some(user_id),
            Some(props(&[
                ("agent.id", agent_id.to_string()),
                ("thread.id", thread_id.to_string()),
                ("generated_ui.id", ui_id.to_string()),
                ("step", step.to_string()),
            ])),
        );
    }
}

/// The props of `generated ui posted`: counts by component type, never content.
fn posted_props(
    agent_id: &str,
    thread_id: &str,
    block: &GeneratedUiBlock,
    channel: &str,
) -> Vec<(&'static str, String)> {
    let count = |name: &str| {
        block
            .elements
            .values()
            .filter(|element| element.type_name() == name)
            .count()
            .to_string()
    };
    vec![
        ("agent.id", agent_id.to_string()),
        ("thread.id", thread_id.to_string()),
        ("generated_ui.id", block.id.clone()),
        ("elements", block.elements.len().to_string()),
        ("buttons", count("Button")),
        ("charts", count("Chart")),
        ("tables", count("Table")),
        ("comparisons", count("Comparison")),
        ("images", count("Image")),
        ("channel", channel.to_string()),
    ]
}

pub static GENERATED_UI_SERVICE: LazyLock<GeneratedUiService> =
    LazyLock::new(|| GeneratedUiService);

#[cfg(test)]
#[path = "generated_ui_service_tests.rs"]
mod tests;
