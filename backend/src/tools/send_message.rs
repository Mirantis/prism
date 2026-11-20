//! send_message and list_message_targets — the agent posts a message on its own
//! initiative into a conversation linked to it.
//!
//! The policy lives in the outbound message service; these tools only pass the
//! run's identity and the conversation its reply goes to. A refusal is an error,
//! so the agent reads the reason and the stored tool call is marked failed.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::db::models::MessageTrigger;
use crate::services::channel_adapter_interface::{
    ChannelName, LinkedTarget, WEB_CHAT_NAME, WEB_CHAT_TARGET,
};
use crate::services::delivery_target_service::PostingCeiling;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::services::outbound_message_service::{
    OUTBOUND_MESSAGE_SERVICE, SEND_MESSAGE_TOOL_NAME, SendInput, SendOrigin,
};

pub const SEND_MESSAGE_DESCRIPTION: &str = "Post a message into a channel, a thread in one, or a DM that is linked to you, or into web chat when list_message_targets lists it. In a conversation your reply already goes to that conversation; use this tool to reach another one. Only the targets list_message_targets shows are allowed. To mention a person so they are notified, write <@ID> with the id from a <@ID:Name> tag in a message you have seen. The person must be a member of the target. @channel, @here, @everyone and group mentions are refused. A refusal says why; fix the cause before you try again.";
pub const LIST_MESSAGE_TARGETS_DESCRIPTION: &str =
    "List the channels and DMs linked to you, which send_message can post to.";

/// The trigger each invocation mode stores its messages under
/// (`heartbeat` → `HEARTBEAT`, `cron` → `CRON_TASK`, `webhook` → `WEBHOOK`,
/// `goal` → `GOAL`), `USER_INPUT` for any other.
pub fn mode_trigger(mode: &str) -> &'static str {
    match mode {
        "heartbeat" => "HEARTBEAT",
        "cron" => "CRON_TASK",
        "webhook" => "WEBHOOK",
        "goal" => "GOAL",
        _ => "USER_INPUT",
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendMessageInput {
    /// A target from list_message_targets, or #name of a linked channel when the name is unique.
    pub target: String,
    /// Post into this thread of the target: the id of the thread's first message.
    #[serde(default)]
    pub thread: Option<String>,
    /// The message, in markdown.
    pub text: String,
}

pub fn list_message_targets_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

pub fn send_message_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "A target from list_message_targets, or #name of a linked channel when the name is unique"
            },
            "thread": {
                "description": "Post into this thread of the target: the id of the thread's first message, such as a messageId send_message returned",
                "type": "string"
            },
            "text": {
                "type": "string",
                "description": "The message, in markdown"
            }
        },
        "required": ["target", "text"],
        "additionalProperties": false
    })
}

/// The targets as `list_message_targets` lists them: web chat first when the
/// ceiling allows it, then each linked target.
fn listed_targets(web_chat: bool, targets: &[LinkedTarget]) -> Value {
    let mut listed = Vec::new();
    if web_chat {
        listed.push(json!({
            "target": WEB_CHAT_TARGET,
            "platform": WEB_CHAT_TARGET,
            "kind": WEB_CHAT_TARGET,
            "name": WEB_CHAT_NAME,
            "main": false,
        }));
    }
    listed.extend(targets.iter().map(|t| {
        json!({
            "target": t.key,
            "platform": t.platform.as_str(),
            "kind": t.kind.as_str(),
            "name": t.name,
            "main": t.is_main,
        })
    }));
    json!({ "targets": listed })
}

/// The bound identity and origin of the run that sends.
#[derive(Clone)]
struct SendContext {
    user_id: String,
    agent_id: String,
    mode: String,
    thread_id: Option<String>,
    origin_channel: Option<ChannelName>,
    origin_channel_id: Option<String>,
    ceiling: Option<PostingCeiling>,
}

async fn run_list_message_targets(ctx: SendContext) -> anyhow::Result<Value> {
    let Some(ceiling) = &ctx.ceiling else {
        let targets = OUTBOUND_MESSAGE_SERVICE.list_targets(&ctx.agent_id).await?;
        return Ok(listed_targets(false, &targets));
    };
    Ok(listed_targets(ceiling.web_chat, &ceiling.targets))
}

async fn run_send_message(ctx: SendContext, input: Value) -> anyhow::Result<Value> {
    let SendMessageInput {
        target,
        thread,
        text,
    } = serde_json::from_value(input)?;
    let origin = if ctx.ceiling.is_some() {
        None
    } else {
        reply_destination(
            &ctx.mode,
            ctx.thread_id.as_deref(),
            ctx.origin_channel,
            ctx.origin_channel_id.as_deref(),
        )
        .await?
    };
    let trigger: MessageTrigger = mode_trigger(&ctx.mode)
        .parse()
        .expect("every mode trigger is a message trigger");
    let sent = OUTBOUND_MESSAGE_SERVICE
        .send(SendInput {
            agent_id: ctx.agent_id.clone(),
            user_id: ctx.user_id.clone(),
            target,
            thread,
            text,
            trigger,
            origin,
            ceiling: ctx.ceiling.clone(),
        })
        .await?;
    Ok(json!({
        "sent": true,
        "target": sent.key,
        "name": sent.name,
        "messageId": sent.message_id,
    }))
}

/// list_message_targets, then send_message.
///
/// `mode` sets the trigger of the message stored in the target's history, and
/// where a goal turn's own reply goes. `ceiling` is where an autonomous run may
/// post; unset, the run may post to any linked target.
pub fn get_send_message_tools(
    user_id: &str,
    agent_id: &str,
    mode: &str,
    thread_id: Option<&str>,
    origin_channel: Option<ChannelName>,
    origin_channel_id: Option<&str>,
    ceiling: Option<PostingCeiling>,
) -> ToolSet {
    let ctx = SendContext {
        user_id: user_id.to_string(),
        agent_id: agent_id.to_string(),
        mode: mode.to_string(),
        thread_id: thread_id.map(str::to_string),
        origin_channel,
        origin_channel_id: origin_channel_id.map(str::to_string),
        ceiling,
    };
    let mut tools = ToolSet::new();
    let list_ctx = ctx.clone();
    tools.insert(
        "list_message_targets".to_string(),
        tool(Tool {
            description: Some(LIST_MESSAGE_TARGETS_DESCRIPTION.to_string()),
            input_schema: zod_schema(list_message_targets_input_schema()),
            execute: Some(execute_fn(move |_, _| {
                run_list_message_targets(list_ctx.clone())
            })),
            ..Default::default()
        }),
    );
    tools.insert(
        SEND_MESSAGE_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(SEND_MESSAGE_DESCRIPTION.to_string()),
            input_schema: zod_schema(send_message_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                run_send_message(ctx.clone(), input)
            })),
            ..Default::default()
        }),
    );
    tools
}

/// Where the run's own reply goes: a chat conversation and thread, or nowhere a
/// send can reach (a web turn). A goal turn posts its reply top-level, never in
/// a thread.
async fn reply_destination(
    mode: &str,
    thread_id: Option<&str>,
    origin_channel: Option<ChannelName>,
    origin_channel_id: Option<&str>,
) -> anyhow::Result<Option<SendOrigin>> {
    let Some(thread_id) = thread_id else {
        return Ok(None);
    };
    let Some(channel) = origin_channel.filter(|c| c.chat_platform().is_some()) else {
        return Ok(None);
    };
    let thread_context = MESSAGE_DELIVERY_SERVICE
        .thread_context(thread_id, Some(channel.as_str()), origin_channel_id)
        .await?;
    let context = thread_context.context;
    let thread = if mode == "goal" {
        None
    } else {
        context.channel_thread_id
    };
    Ok(Some(SendOrigin {
        platform: context.channel,
        conversation_id: context.channel_id,
        thread,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToolExecutionOptions;
    use crate::services::channel_adapter_interface::{ChatPlatform, LinkedTargetKind};

    #[test]
    fn the_chat_definitions_match_the_typescript_runtime() {
        let tools = get_send_message_tools(
            "user-1",
            "agent-1",
            "chat",
            Some("thread-1"),
            Some(ChannelName::Websocket),
            None,
            None,
        );
        crate::tools::schema_fixture::assert_matches_fixture("send-message:chat", &tools);
    }

    #[test]
    fn the_heartbeat_definitions_match_the_typescript_runtime() {
        let tools = get_send_message_tools(
            "user-1",
            "agent-1",
            "heartbeat",
            None,
            Some(ChannelName::Websocket),
            None,
            Some(PostingCeiling {
                web_chat: true,
                targets: vec![],
            }),
        );
        crate::tools::schema_fixture::assert_matches_fixture("send-message:heartbeat", &tools);
    }

    #[test]
    fn stores_each_mode_under_its_trigger() {
        for (mode, trigger) in [
            ("heartbeat", MessageTrigger::Heartbeat),
            ("cron", MessageTrigger::CronTask),
            ("webhook", MessageTrigger::Webhook),
            ("goal", MessageTrigger::Goal),
            ("chat", MessageTrigger::UserInput),
        ] {
            assert_eq!(
                mode_trigger(mode).parse::<MessageTrigger>().unwrap(),
                trigger
            );
        }
    }

    #[tokio::test]
    async fn lists_web_chat_first_and_then_the_ceilings_targets() {
        let tools = get_send_message_tools(
            "user-1",
            "agent-1",
            "heartbeat",
            None,
            None,
            None,
            Some(PostingCeiling {
                web_chat: true,
                targets: vec![LinkedTarget {
                    key: "slack:C1".to_string(),
                    platform: ChatPlatform::Slack,
                    kind: LinkedTargetKind::Channel,
                    conversation_id: "C1".to_string(),
                    name: None,
                    is_main: true,
                    dm_user_id: None,
                }],
            }),
        );
        let execute = tools["list_message_targets"].execute.clone().unwrap();
        let result = execute(json!({}), ToolExecutionOptions::default())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"targets":[{"target":"chat","platform":"chat","kind":"chat","name":"Web chat","main":false},{"target":"slack:C1","platform":"slack","kind":"channel","name":null,"main":true}]}"#
        );
    }
}
