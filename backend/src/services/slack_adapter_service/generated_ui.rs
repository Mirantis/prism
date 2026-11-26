//! Generated UI in Slack: a UI posts as Block Kit, or as its text version when
//! Slack refuses the blocks, and the first press of one of its buttons becomes the
//! next message of the person who pressed it.

use crate::protocol::chat_protocol::{GeneratedUiBlock, QuestionCardPerson};
use crate::services::conversation_engine_service::{
    StoredMessage, UserMessageInput, chat_work_for,
};
use crate::services::generated_ui::generated_ui_service::{
    GENERATED_UI_SERVICE, pressed_block, replace_unpressed,
};
use crate::services::pending_work_service::{PENDING_WORK_SERVICE, PendingWorkKind};
use crate::utils::slack_generated_ui::{
    REFUSED_BLOCKS, UiPress, generated_ui_blocks, pressed_message_blocks, text_messages, ui_press,
};

use super::*;

/// The agent's stored message with this Slack ts whose UI has this id, with the
/// agent and the user of its conversation.
async fn find_ui(
    ts: &str,
    ui_id: &str,
) -> anyhow::Result<Option<(ConversationMessage, GeneratedUiBlock, String, String)>> {
    let ts = ts.to_string();
    let rows: Vec<(ConversationMessage, String, String)> = crate::db::read(move |conn| {
        Ok(cm::conversation_messages
            .inner_join(ct::conversation_threads)
            .filter(cm::external_message_id.eq(&ts))
            .filter(cm::role.eq(MessageRole::Agent))
            .select((ConversationMessage::as_select(), ct::agent_id, ct::user_id))
            .load(conn)?)
    })
    .await?;
    Ok(rows.into_iter().find_map(|(row, agent_id, user_id)| {
        let block = row
            .blocks
            .as_ref()?
            .get(0)
            .and_then(parse_block)
            .filter(|block| block.id == ui_id)?;
        Some((row, block, agent_id, user_id))
    }))
}

impl SlackAdapterService {
    /// Post a UI as blocks, with its images uploaded to no channel first so an image
    /// block can name each one. When Slack refuses the blocks, the text version
    /// posts instead, split across messages, and the images go with the files
    /// uploaded after it. Answers the first posted message and the files it does
    /// not show.
    pub(super) async fn post_generated_ui(
        &self,
        client: &SlackWebClient,
        attachments: &[AttachmentMeta],
        mut ui: GeneratedUiBlock,
        outbound: &Outbound<'_>,
        message: Value,
    ) -> anyhow::Result<(Value, Vec<AttachmentMeta>)> {
        for element in ui.elements.values_mut() {
            if let GeneratedUiElement::Text { props } = element {
                props.text = self
                    .rewrite_outbound_mentions(&props.text, outbound.team_id)
                    .await;
            }
        }
        let content = self
            .rewrite_outbound_mentions(outbound.content, outbound.team_id)
            .await;
        let texts = text_messages(&content);
        let files = self.upload_inline_images(client, attachments).await;
        let mut args = message.clone();
        args["text"] = json!(texts[0]);
        args["blocks"] = json!(generated_ui_blocks(&ui.id, &ui.root, &ui.elements, &files));
        let error = match client.api_call("chat.postMessage", args).await {
            Ok(response) => {
                let unshown = attachments
                    .iter()
                    .filter(|meta| !files.contains_key(&meta.id))
                    .cloned()
                    .collect();
                return Ok((response, unshown));
            }
            Err(error) => error,
        };
        let Some(code) = slack_platform_error_code(&error)
            .filter(|code| REFUSED_BLOCKS.contains(&code.as_str()))
        else {
            return Err(error);
        };

        log_warn!(
            json!({ "err": err_json(&error), "generatedUiId": ui.id, "threadId": outbound.thread_id }),
            "[Slack] the generated UI was refused; posting its text version"
        );
        let mut props = agent_props();
        props.insert("thread.id".to_string(), outbound.thread_id.to_string());
        props.insert("generated_ui.id".to_string(), ui.id.clone());
        props.insert("slack.error".to_string(), code);
        props.insert(
            "channel".to_string(),
            ChannelName::Slack.as_str().to_string(),
        );
        track_event("generated ui refused", None, Some(props));

        // Only the first message is the stored UI's, so a thread read live replays a
        // later part as the agent's text. It is the same UI, as text.
        let mut first = None;
        for text in &texts {
            let mut args = message.clone();
            args["text"] = json!(text);
            let response = client.api_call("chat.postMessage", args).await?;
            first.get_or_insert(response);
        }
        let first = first.expect("the text version is at least one message");
        Ok((first, attachments.to_vec()))
    }

    /// The press of a generated UI button (`body` is the `block_actions` payload,
    /// already acknowledged). The first press of the UI wins: one transaction marks
    /// it on the stored UI and writes the `pending_work` row of the press message,
    /// so a restart keeps both. The Slack message then names the press, every web
    /// client shows it, and the button's label starts the agent's turn as the next
    /// message of the person who pressed. A later press changes nothing.
    pub(super) async fn handle_generated_ui_press(
        &self,
        body: &Value,
        team_id: &str,
        client: Arc<dyn FeedbackChatClient>,
        routed: Option<&RoutedEvent>,
    ) -> anyhow::Result<()> {
        let press = body.pointer("/actions/0").and_then(ui_press);
        let slack_user_id = body.pointer("/user/id").and_then(Value::as_str);
        let channel_id = body.pointer("/channel/id").and_then(Value::as_str);
        let message_ts = body.pointer("/message/ts").and_then(Value::as_str);
        let thread_ts = body
            .pointer("/message/thread_ts")
            .and_then(Value::as_str)
            .filter(|ts| !ts.is_empty());
        let (Some(press), Some(slack_user_id), Some(channel_id), Some(message_ts)) = (
            press,
            slack_user_id.filter(|v| !v.is_empty()),
            channel_id.filter(|v| !v.is_empty()),
            message_ts.filter(|v| !v.is_empty()),
        ) else {
            log_warn!("[SlackAdapter] A generated UI press is missing a field");
            return Ok(());
        };

        let Some((row, block, agent_id, user_id)) = find_ui(message_ts, &press.ui_id).await? else {
            log_warn!(
                "[SlackAdapter] A press for unknown generated UI {} at ts {}",
                press.ui_id,
                message_ts
            );
            return Ok(());
        };
        if block.pressed.is_some() {
            log_info!(
                "[SlackAdapter] Generated UI {} was already pressed",
                block.id
            );
            return Ok(());
        }
        let sender_name = self
            .get_user_info(slack_user_id, team_id)
            .await
            .and_then(|info| info.display_name().map(str::to_string));
        let by = QuestionCardPerson {
            id: slack_user_id.to_string(),
            name: sender_name
                .clone()
                .unwrap_or_else(|| slack_user_id.to_string()),
        };
        let pressed = match pressed_block(&block, &press.element_id, Some(by)) {
            Ok(pressed) => pressed,
            Err(error) => {
                log_warn!("[SlackAdapter] Generated UI press refused: {}", error);
                return Ok(());
            }
        };
        let label = pressed
            .pressed
            .as_ref()
            .map(|press| press.label.clone())
            .unwrap_or_default();

        // A channel's reply threads under the message; a DM's goes where the UI is.
        let mapping = SLACK_MAPPING_SERVICE.find_by_channel_id(channel_id).await?;
        let metadata = match &mapping {
            Some(mapping) => ChatMetadata {
                channel: Some(ChannelName::Slack),
                channel_id: Some(channel_id.to_string()),
                channel_thread_id: Some(thread_ts.unwrap_or(message_ts).to_string()),
                channel_label: Some(slack_channel_label(
                    mapping
                        .mapping
                        .slack_channel_name
                        .as_deref()
                        .filter(|name| !name.is_empty())
                        .unwrap_or(channel_id),
                )),
                sender_external_id: Some(slack_user_id.to_string()),
                sender_name: sender_name.clone(),
            },
            None => ChatMetadata {
                channel: Some(ChannelName::Slack),
                channel_thread_id: thread_ts.map(str::to_string),
                sender_external_id: Some(slack_user_id.to_string()),
                sender_name: sender_name.clone(),
                ..ChatMetadata::default()
            },
        };
        let input = UserMessageInput {
            agent_id: agent_id.clone(),
            user_id: user_id.clone(),
            message: self.build_sender_tagged_content(
                slack_user_id,
                sender_name.as_deref(),
                &label,
            ),
            metadata: Some(metadata.clone()),
            runtime_written: true,
            generated_ui_press: true,
            ..UserMessageInput::default()
        };
        let message_id = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::to_value(chat_work_for(&input, &row.thread_id))?;
        let (row_id, written) = (row.id.clone(), pressed.clone());
        let won = PENDING_WORK_SERVICE
            .begin_with(PendingWorkKind::Chat, &message_id, payload, move |conn| {
                replace_unpressed(conn, &row_id, &written)
            })
            .await?;
        if !won {
            log_info!(
                "[SlackAdapter] Generated UI {} was already pressed",
                block.id
            );
            return Ok(());
        }
        // The stored press holds a routed event from here.
        if let Some(routed) = routed {
            routed.hand_off.hand_off();
        }

        GENERATED_UI_SERVICE.pressed(&agent_id, &user_id, &row, &pressed, ChannelName::Slack);
        GENERATED_UI_SERVICE
            .show(&agent_id, &user_id, &row, &pressed)
            .await;
        self.show_press(
            client,
            body,
            &press,
            channel_id,
            message_ts,
            &label,
            slack_user_id,
        )
        .await;

        // A failed store leaves the press to the next boot, which stores it from its row.
        let stored = match CONVERSATION_ENGINE_SERVICE
            .accept_user_message(&input, &row.thread_id, Some(&message_id))
            .await
        {
            Ok(stored) => stored,
            Err(error) => {
                GENERATED_UI_SERVICE.step_failed(
                    "accept",
                    &error,
                    &agent_id,
                    &user_id,
                    &row.thread_id,
                    &block.id,
                );
                return Ok(());
            }
        };
        if mapping.is_some() {
            self.add_participant(
                &row.thread_id,
                slack_user_id,
                sender_name.as_deref().unwrap_or("Unknown"),
            )
            .await;
        }
        let handle = self
            .working_indicator()
            .begin(WorkingIndicatorTarget {
                team_id: team_id.to_string(),
                channel_id: channel_id.to_string(),
                message_ts: Some(message_ts.to_string()),
                status_thread_ts: metadata.channel_thread_id.clone(),
            })
            .await;
        let turn = Box::pin(CONVERSATION_ENGINE_SERVICE.chat(ChatInput {
            user_id,
            agent_id,
            thread_id: Some(row.thread_id.clone()),
            message: input.message.clone(),
            on_tool_event: Some(create_tool_status_listener(handle.clone())),
            stored: Some(StoredMessage {
                id: message_id,
                title_set: stored.title_set,
            }),
            runtime_written: true,
            metadata: Some(metadata),
            ..ChatInput::default()
        }))
        .await;
        handle.end().await;
        turn.map(|_| ())
    }

    /// Replace the pressed UI's buttons on the Slack message with a line that names
    /// the label and the person. The stored UI is already right, so a failure is logged.
    #[allow(clippy::too_many_arguments)]
    async fn show_press(
        &self,
        client: Arc<dyn FeedbackChatClient>,
        body: &Value,
        press: &UiPress,
        channel_id: &str,
        message_ts: &str,
        label: &str,
        slack_user_id: &str,
    ) {
        let Some(blocks) = body.pointer("/message/blocks").and_then(Value::as_array) else {
            log_warn!("[SlackAdapter] A generated UI press has no message blocks to update");
            return;
        };
        let blocks = pressed_message_blocks(blocks, press, label, slack_user_id);
        if let Err(error) = client
            .chat_update(json!({ "channel": channel_id, "ts": message_ts, "blocks": blocks }))
            .await
        {
            log_warn!(
                json!({ "err": err_json(&error), "generatedUiId": press.ui_id }),
                "[SlackAdapter] Could not show the press on the Slack message"
            );
        }
    }
}

#[cfg(test)]
#[path = "generated_ui_tests.rs"]
mod tests;
