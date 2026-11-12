//! Delivery Target Service
//!
//! Delivers an autonomous message to the target its source was configured with:
//! every channel, web chat only, one channel's default destination, chosen
//! linked channels of a channel, or nowhere. Webhook subscriptions and scheduled
//! tasks each store a target.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::log_warn;
use crate::services::channel_adapter_interface::{
    CHAT_PLATFORMS, ChannelContext, ChannelName, LinkedTarget, LinkedTargetKind,
};
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::outbound_message_service::OUTBOUND_MESSAGE_SERVICE;
use crate::support::js;
use crate::types::ToolCallRecord;

/// Every delivery target: `all`, `chat`, each chat platform, then `none`.
pub static DELIVER_TARGETS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let mut targets = vec!["all", "chat"];
    targets.extend(CHAT_PLATFORMS.iter().map(|platform| platform.as_str()));
    targets.push("none");
    targets
});

/// One of `DELIVER_TARGETS`, as stored.
pub type DeliverTo = String;

/// Whether `value` is a string naming one of `DELIVER_TARGETS`.
pub fn is_valid_deliver_to(value: &Value) -> bool {
    value.as_str().is_some_and(is_valid_deliver_to_str)
}

/// Whether `value` names one of `DELIVER_TARGETS`.
pub fn is_valid_deliver_to_str(value: &str) -> bool {
    DELIVER_TARGETS.contains(&value)
}

/// Parse a stored comma-separated column; `None` or empty is an empty list.
pub fn parse_comma_list(value: Option<&str>) -> Vec<String> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Vec::new();
    };
    value
        .split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// Where a message goes: the target, and the linked channels chosen for it, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryTarget {
    pub deliver_to: String,
    pub channel_ids: Vec<String>,
}

/// Where an autonomous run may post: web chat, and the linked targets. A run
/// posts only what the agent sends, so this is the whole of its reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostingCeiling {
    pub web_chat: bool,
    pub targets: Vec<LinkedTarget>,
}

/// The channels a delivery to chosen channels posted to, and the unlinked ones it skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChosenChannels {
    pub channel: ChannelName,
    pub posted: i64,
    pub skipped: i64,
}

/// What a delivery stored: the message, or `None` for 'none'. A delivery to chosen
/// channels also counts the channels it posted to and the unlinked ones it
/// skipped.
#[derive(Debug, Clone)]
pub struct Delivery {
    pub message: Option<ConversationMessage>,
    pub chosen_channels: Option<ChosenChannels>,
}

/// The triggers of a message that a target delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TargetTrigger {
    Heartbeat,
    CronTask,
    Webhook,
}

impl TargetTrigger {
    /// The stored trigger of the message.
    pub fn message_trigger(self) -> MessageTrigger {
        match self {
            TargetTrigger::Heartbeat => MessageTrigger::Heartbeat,
            TargetTrigger::CronTask => MessageTrigger::CronTask,
            TargetTrigger::Webhook => MessageTrigger::Webhook,
        }
    }
}

/// The publish options a delivery to a target passes on.
#[derive(Debug, Clone, Default)]
pub struct TargetPublishOptions {
    /// The webhook subscription that produced a WEBHOOK message, for the model's history.
    pub trigger_name: Option<String>,
    pub tool_calls: Option<Vec<ToolCallRecord>>,
    pub attachment_ids: Option<Vec<String>>,
}

pub struct DeliveryTargetService;

impl DeliveryTargetService {
    pub fn new() -> Self {
        DeliveryTargetService
    }

    /// Deliver a message: to the chosen channels when the target's channel links
    /// channels and some are chosen, else per the target.
    pub async fn deliver(
        &self,
        agent_id: &str,
        user_id: &str,
        target: &DeliveryTarget,
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<Delivery> {
        let channel = MESSAGE_DELIVERY_SERVICE.get_adapter(&target.deliver_to);
        if !target.channel_ids.is_empty()
            && let Some(channel) = &channel
            && let Some(linked) = channel.linked_channel_ids(agent_id).await
        {
            let linked: HashSet<String> = linked?.into_iter().collect();
            return self
                .deliver_to_chosen_channels(
                    agent_id,
                    user_id,
                    channel.name(),
                    &linked,
                    &target.channel_ids,
                    content,
                    triggered_by,
                    options,
                )
                .await;
        }
        Ok(Delivery {
            message: self
                .deliver_to_target(
                    agent_id,
                    user_id,
                    &target.deliver_to,
                    content,
                    triggered_by,
                    options,
                )
                .await?,
            chosen_channels: None,
        })
    }

    /// Where a run under this target may post with `send_message`: every linked
    /// target and web chat for 'all', web chat for 'chat', nothing for 'none', and
    /// for a platform its linked targets, or only the chosen channels when some are
    /// chosen. A platform with none of them linked gets web chat, as `deliver` does.
    pub async fn ceiling(
        &self,
        agent_id: &str,
        target: &DeliveryTarget,
    ) -> anyhow::Result<PostingCeiling> {
        if target.deliver_to == "none" {
            return Ok(PostingCeiling {
                web_chat: false,
                targets: Vec::new(),
            });
        }
        if target.deliver_to == "chat" {
            return Ok(PostingCeiling {
                web_chat: true,
                targets: Vec::new(),
            });
        }
        let linked = OUTBOUND_MESSAGE_SERVICE.list_targets(agent_id).await?;
        Ok(ceiling_over(target, linked))
    }

    /// Read a channel list from a request, as the stored column value. The list
    /// belongs to a target whose channel links channels. Each id has to name a
    /// channel linked to the agent, or one the source already holds, so a channel
    /// unlinked after it was chosen does not block an unrelated edit. `null`
    /// clears the list. `Err` holds the message a refused list is answered with.
    pub async fn read_channel_ids(
        &self,
        raw: &Value,
        deliver_to: &str,
        agent_id: &str,
        stored: &[String],
    ) -> anyhow::Result<Result<Option<String>, String>> {
        // null clears the list, as it clears the nullable fields beside it.
        let empty = Vec::new();
        let list = match raw {
            Value::Null => &empty,
            Value::Array(items) if items.iter().all(Value::is_string) => items,
            _ => {
                return Ok(Err(
                    "The channel list must be an array of channel ids".to_string()
                ));
            }
        };
        let mut ids: Vec<String> = Vec::new();
        for id in list.iter().filter_map(Value::as_str).map(js::trim) {
            if !id.is_empty() && !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_string());
            }
        }
        if ids.is_empty() {
            return Ok(Ok(None));
        }
        let linked = match MESSAGE_DELIVERY_SERVICE.get_adapter(deliver_to) {
            Some(channel) => channel.linked_channel_ids(agent_id).await,
            None => None,
        };
        let Some(linked) = linked else {
            return Ok(Err(format!(
                "Chosen channels do not apply when the target is '{deliver_to}'"
            )));
        };
        let linked: HashSet<String> = linked?.into_iter().collect();
        let unknown: Vec<&str> = ids
            .iter()
            .filter(|id| !linked.contains(*id) && !stored.contains(id))
            .map(String::as_str)
            .collect();
        if !unknown.is_empty() {
            return Ok(Err(format!(
                "Not a channel linked to the agent: {}",
                unknown.join(", ")
            )));
        }
        Ok(Ok(Some(ids.join(","))))
    }

    /// Deliver a message per the target, and return the stored message, or `None`
    /// for 'none':
    /// - 'all' — broadcast to every connected channel, in the latest thread.
    /// - 'chat' — scoped to web chat; stored in the web-visible latest thread.
    /// - a channel's name — scoped to that channel's default destination (the
    ///   direct conversation, else the main channel). Stored in the destination's
    ///   own thread, keyed by a non-null externalThreadId, so `list_threads` hides
    ///   it from web Recents + the CLI resume picker. Falls back to web chat only
    ///   + a warning when the channel has no destination.
    /// - 'none' — nothing is published or stored.
    async fn deliver_to_target(
        &self,
        agent_id: &str,
        user_id: &str,
        deliver_to: &str,
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        if deliver_to == "none" {
            return Ok(None);
        }

        if deliver_to == "chat" {
            return Ok(Some(
                self.deliver_to_chat(agent_id, user_id, content, triggered_by, options)
                    .await?,
            ));
        }

        if let Some(channel) = MESSAGE_DELIVERY_SERVICE.get_adapter(deliver_to)
            && let Some(destination) = channel.default_destination(agent_id, user_id).await
        {
            if let Some(destination) = destination? {
                // Reuse the destination's own conversation thread, keyed by its
                // conversation id and hidden from web/CLI Recents.
                let thread = CONVERSATION_SERVICE
                    .get_or_create_thread_by_external_id(
                        user_id,
                        agent_id,
                        &destination.thread_key,
                        None,
                    )
                    .await?;
                let route = destination.destination;
                let publish = PublishOptions {
                    channel_context: Some(ChannelContext {
                        channel: channel.name(),
                        channel_id: route.channel_id,
                        channel_thread_id: route.channel_thread_id,
                        thread_id: thread.id.clone(),
                        include_feedback: None,
                    }),
                    ..publish_options(options)
                };
                return Ok(Some(
                    MESSAGE_DELIVERY_SERVICE
                        .publish(
                            user_id,
                            &thread.id,
                            content,
                            triggered_by.message_trigger(),
                            publish,
                        )
                        .await?,
                ));
            }
            // No direct conversation or channel linked, so the channel cannot
            // deliver. Post to web chat only, so the message isn't silently lost
            // and doesn't reach the channels the target leaves out.
            log_warn!(
                "[Delivery] deliverTo:'{}' but no direct conversation or channel is linked — storing in the web thread instead",
                deliver_to
            );
            return Ok(Some(
                self.deliver_to_chat(agent_id, user_id, content, triggered_by, options)
                    .await?,
            ));
        }

        // 'all' — broadcast to every connected channel.
        Ok(Some(
            MESSAGE_DELIVERY_SERVICE
                .publish_to_latest_thread(
                    agent_id,
                    user_id,
                    content,
                    triggered_by.message_trigger(),
                    publish_options(options),
                )
                .await?,
        ))
    }

    async fn deliver_to_chat(
        &self,
        agent_id: &str,
        user_id: &str,
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<ConversationMessage> {
        MESSAGE_DELIVERY_SERVICE
            .publish_to_web_chat(
                agent_id,
                user_id,
                content,
                triggered_by.message_trigger(),
                publish_options(options),
            )
            .await
    }

    /// Post to each chosen channel that is still linked to the agent, and return
    /// the first stored message. Each post is stored in its channel's own thread.
    /// A shared file belongs to one message, so files go with the first post
    /// only: a run that shares files and posts to several channels is rare.
    /// When no chosen channel is linked any more, the message goes to web chat
    /// only, because the list excludes every other destination on that platform.
    #[allow(clippy::too_many_arguments)]
    async fn deliver_to_chosen_channels(
        &self,
        agent_id: &str,
        user_id: &str,
        channel: ChannelName,
        linked: &HashSet<String>,
        chosen: &[String],
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<Delivery> {
        let reachable: Vec<&String> = chosen.iter().filter(|id| linked.contains(*id)).collect();
        let chosen_channels = ChosenChannels {
            channel,
            posted: reachable.len() as i64,
            skipped: (chosen.len() - reachable.len()) as i64,
        };
        if chosen_channels.skipped > 0 {
            let unlinked: Vec<&str> = chosen
                .iter()
                .filter(|id| !linked.contains(*id))
                .map(String::as_str)
                .collect();
            log_warn!(
                "[Delivery] Skipping {} channels that are no longer linked: {}",
                channel,
                unlinked.join(", ")
            );
        }

        let mut first: Option<ConversationMessage> = None;
        for channel_id in reachable {
            let thread = CONVERSATION_SERVICE
                .get_or_create_thread_by_external_id(user_id, agent_id, channel_id, None)
                .await?;
            let publish = PublishOptions {
                channel_context: Some(ChannelContext {
                    channel,
                    channel_id: Some(channel_id.clone()),
                    channel_thread_id: None,
                    thread_id: thread.id.clone(),
                    include_feedback: None,
                }),
                ..publish_options(options.clone())
            };
            let message = MESSAGE_DELIVERY_SERVICE
                .publish(
                    user_id,
                    &thread.id,
                    content,
                    triggered_by.message_trigger(),
                    publish,
                )
                .await?;
            first.get_or_insert(message);
        }
        if let Some(first) = first {
            return Ok(Delivery {
                message: Some(first),
                chosen_channels: Some(chosen_channels),
            });
        }

        log_warn!(
            "[Delivery] None of the chosen {} channels is linked — storing in the web thread instead",
            channel
        );
        Ok(Delivery {
            message: Some(
                self.deliver_to_chat(agent_id, user_id, content, triggered_by, options)
                    .await?,
            ),
            chosen_channels: Some(chosen_channels),
        })
    }
}

/// The ceiling of an `all` or platform target over the agent's linked targets.
fn ceiling_over(target: &DeliveryTarget, linked: Vec<LinkedTarget>) -> PostingCeiling {
    if target.deliver_to == "all" {
        return PostingCeiling {
            web_chat: true,
            targets: linked,
        };
    }
    let own = linked
        .into_iter()
        .filter(|t| t.platform.as_str() == target.deliver_to);
    let allowed: Vec<LinkedTarget> = if target.channel_ids.is_empty() {
        own.collect()
    } else {
        own.filter(|t| {
            t.kind == LinkedTargetKind::Channel && target.channel_ids.contains(&t.conversation_id)
        })
        .collect()
    };
    if allowed.is_empty() {
        PostingCeiling {
            web_chat: true,
            targets: Vec::new(),
        }
    } else {
        PostingCeiling {
            web_chat: false,
            targets: allowed,
        }
    }
}

/// The publish options a delivery to a target passes on.
fn publish_options(options: TargetPublishOptions) -> PublishOptions {
    PublishOptions {
        trigger_name: options.trigger_name,
        tool_calls: options.tool_calls,
        attachment_ids: options.attachment_ids,
        ..PublishOptions::default()
    }
}

impl Default for DeliveryTargetService {
    fn default() -> Self {
        Self::new()
    }
}

pub static DELIVERY_TARGET_SERVICE: LazyLock<DeliveryTargetService> =
    LazyLock::new(DeliveryTargetService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::channel_adapter_interface::ChatPlatform;

    fn target(key: &str, platform: ChatPlatform, kind: LinkedTargetKind, id: &str) -> LinkedTarget {
        LinkedTarget {
            key: key.into(),
            platform,
            kind,
            conversation_id: id.into(),
            name: Some(id.to_lowercase()),
            is_main: false,
            dm_user_id: None,
        }
    }

    fn linked() -> Vec<LinkedTarget> {
        vec![
            target(
                "slack:C0MAIN",
                ChatPlatform::Slack,
                LinkedTargetKind::Channel,
                "C0MAIN",
            ),
            target(
                "slack:C0OPS",
                ChatPlatform::Slack,
                LinkedTargetKind::Channel,
                "C0OPS",
            ),
            target(
                "slack:D0ANA",
                ChatPlatform::Slack,
                LinkedTargetKind::Dm,
                "D0ANA",
            ),
            target(
                "teams:19:ops",
                ChatPlatform::Teams,
                LinkedTargetKind::Channel,
                "19:ops",
            ),
        ]
    }

    fn deliver(deliver_to: &str, channel_ids: &[&str]) -> DeliveryTarget {
        DeliveryTarget {
            deliver_to: deliver_to.into(),
            channel_ids: channel_ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    fn keys(ceiling: &PostingCeiling) -> Vec<&str> {
        ceiling.targets.iter().map(|t| t.key.as_str()).collect()
    }

    #[test]
    fn splits_and_trims_a_stored_list_dropping_empties() {
        assert_eq!(
            parse_comma_list(Some(" push, pull_request ,,")),
            ["push", "pull_request"]
        );
        assert!(parse_comma_list(None).is_empty());
        assert!(parse_comma_list(Some("")).is_empty());
    }

    #[test]
    fn accepts_only_known_deliver_targets() {
        for valid in ["all", "chat", "slack", "teams", "none"] {
            assert!(is_valid_deliver_to_str(valid));
        }
        assert!(!is_valid_deliver_to_str("log"));
        assert!(!is_valid_deliver_to(&serde_json::json!(3)));
    }

    #[tokio::test]
    async fn lets_chat_post_to_web_chat_and_none_post_nowhere() {
        let chat = DELIVERY_TARGET_SERVICE
            .ceiling("agent-1", &deliver("chat", &[]))
            .await
            .unwrap();
        assert!(chat.web_chat && chat.targets.is_empty());
        let none = DELIVERY_TARGET_SERVICE
            .ceiling("agent-1", &deliver("none", &[]))
            .await
            .unwrap();
        assert!(!none.web_chat && none.targets.is_empty());
    }

    #[test]
    fn is_where_an_autonomous_run_may_post() {
        let all = ceiling_over(&deliver("all", &[]), linked());
        assert!(all.web_chat);
        assert_eq!(
            keys(&all),
            ["slack:C0MAIN", "slack:C0OPS", "slack:D0ANA", "teams:19:ops"]
        );
        let slack = ceiling_over(&deliver("slack", &[]), linked());
        assert!(!slack.web_chat);
        assert_eq!(keys(&slack), ["slack:C0MAIN", "slack:C0OPS", "slack:D0ANA"]);
        let chosen = ceiling_over(&deliver("slack", &["C0OPS"]), linked());
        assert_eq!(keys(&chosen), ["slack:C0OPS"]);
        let teams = ceiling_over(&deliver("teams", &[]), linked());
        assert_eq!(keys(&teams), ["teams:19:ops"]);
    }

    #[test]
    fn allows_web_chat_for_a_platform_with_nothing_linked() {
        let main = vec![linked().remove(0)];
        let teams = ceiling_over(&deliver("teams", &[]), main.clone());
        assert!(teams.web_chat && teams.targets.is_empty());
        let gone = ceiling_over(&deliver("slack", &["C0GONE"]), main);
        assert!(gone.web_chat && gone.targets.is_empty());
    }
}
