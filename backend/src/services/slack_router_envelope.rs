//! The envelope a Slack router posts to `POST /agents/slack/router`, and the
//! listener body a `slack` envelope becomes.
//!
//! The envelope is strict: an unknown field, version or kind fails it. Its
//! `payload` is in Slack's own shape, so the parser checks the fields the
//! adapter reads and drops every other field, and the body handed to the
//! adapter is built from those fields alone.
//!
//! `docs/slack-router-protocol.md` describes the contract.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// A string id: 1 to 255 characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Id(pub String);

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let length = text.encode_utf16().count();
        if length == 0 || length > 255 {
            return Err(de::Error::custom("an id has 1 to 255 characters"));
        }
        Ok(Id(text))
    }
}

/// How the router addressed a Slack event to this agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlackRoute {
    Dm,
    Mention,
    ThreadReply,
    ChannelEvent,
    Action,
}

/// A link change's direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkOp {
    Add,
    Remove,
}

impl LinkOp {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkOp::Add => "add",
            LinkOp::Remove => "remove",
        }
    }
}

/// A person's DM or a channel, linked to the agent or unlinked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoutedLink {
    #[serde(rename_all = "camelCase")]
    Dm {
        op: LinkOp,
        slack_user_id: Id,
        dm_channel_id: Id,
        person_id: Id,
    },
    #[serde(rename_all = "camelCase")]
    Channel {
        op: LinkOp,
        channel_id: Id,
        person_id: Id,
    },
}

impl RoutedLink {
    pub fn op(&self) -> LinkOp {
        match self {
            RoutedLink::Dm { op, .. } | RoutedLink::Channel { op, .. } => *op,
        }
    }

    pub fn person_id(&self) -> &str {
        match self {
            RoutedLink::Dm { person_id, .. } | RoutedLink::Channel { person_id, .. } => {
                &person_id.0
            }
        }
    }

    pub fn type_str(&self) -> &'static str {
        match self {
            RoutedLink::Dm { .. } => "dm",
            RoutedLink::Channel { .. } => "channel",
        }
    }
}

/// The workspace a `connected` envelope names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutedWorkspace {
    pub team_id: Id,
    pub team_name: String,
    pub bot_user_id: Id,
    pub bot_id: Id,
}

/// A Slack event or a button click the router delivered.
#[derive(Debug, Clone, PartialEq)]
pub struct SlackEnvelope {
    pub event_id: String,
    pub sent_at: String,
    pub team_id: String,
    /// The person the router matched the sender to, if any.
    pub person_id: Option<String>,
    pub route: SlackRoute,
    /// `true` for a `block_actions` payload, else an event.
    pub is_block_actions: bool,
    /// The payload with the fields the adapter reads, and nothing else.
    pub payload: Value,
}

/// An envelope the router posts.
#[derive(Debug, Clone, PartialEq)]
pub enum RouterEnvelope {
    Slack(SlackEnvelope),
    Link {
        event_id: String,
        sent_at: String,
        team_id: String,
        link: RoutedLink,
    },
    Connected {
        event_id: String,
        sent_at: String,
        team_id: String,
        workspace: RoutedWorkspace,
    },
    Disconnected {
        event_id: String,
        sent_at: String,
        team_id: String,
    },
}

impl RouterEnvelope {
    pub fn event_id(&self) -> &str {
        match self {
            RouterEnvelope::Slack(envelope) => &envelope.event_id,
            RouterEnvelope::Link { event_id, .. }
            | RouterEnvelope::Connected { event_id, .. }
            | RouterEnvelope::Disconnected { event_id, .. } => event_id,
        }
    }

    pub fn sent_at(&self) -> &str {
        match self {
            RouterEnvelope::Slack(envelope) => &envelope.sent_at,
            RouterEnvelope::Link { sent_at, .. }
            | RouterEnvelope::Connected { sent_at, .. }
            | RouterEnvelope::Disconnected { sent_at, .. } => sent_at,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            RouterEnvelope::Slack(_) => "slack",
            RouterEnvelope::Link { .. } => "link",
            RouterEnvelope::Connected { .. } => "connected",
            RouterEnvelope::Disconnected { .. } => "disconnected",
        }
    }
}

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonWire {
    id: Id,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SlackWire {
    version: u8,
    event_id: Id,
    sent_at: String,
    team_id: Id,
    #[allow(dead_code)]
    kind: String,
    #[serde(deserialize_with = "required_nullable")]
    person: Option<PersonWire>,
    route: SlackRoute,
    payload_type: String,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkWire {
    version: u8,
    event_id: Id,
    sent_at: String,
    team_id: Id,
    #[allow(dead_code)]
    kind: String,
    link: RoutedLink,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectedWire {
    version: u8,
    event_id: Id,
    sent_at: String,
    team_id: Id,
    #[allow(dead_code)]
    kind: String,
    workspace: RoutedWorkspace,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisconnectedWire {
    version: u8,
    event_id: Id,
    sent_at: String,
    team_id: Id,
    #[allow(dead_code)]
    kind: String,
}

/// A field that must be present, and may be `null`.
fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

#[derive(Serialize, Deserialize)]
struct SlackFileWire {
    id: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mimetype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<serde_json::Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url_private: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url_private_download: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct MessageEventWire {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subtype: Option<String>,
    channel: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channel_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    ts: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_ts: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<Vec<SlackFileWire>>,
}

#[derive(Serialize, Deserialize)]
struct MemberEventWire {
    #[serde(rename = "type")]
    kind: String,
    user: Id,
    channel: Id,
}

#[derive(Serialize, Deserialize)]
struct IdOnly {
    id: Id,
}

#[derive(Serialize, Deserialize)]
struct ActionMessageWire {
    ts: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_ts: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocks: Option<Vec<Map<String, Value>>>,
}

#[derive(Serialize, Deserialize)]
struct ActionWire {
    action_id: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct BlockActionsWire {
    #[serde(rename = "type")]
    kind: String,
    user: IdOnly,
    channel: IdOnly,
    message: ActionMessageWire,
    actions: Vec<ActionWire>,
}

fn invalid(field: &str, reason: impl std::fmt::Display) -> String {
    format!("{field}: {reason}")
}

fn check_common(version: u8, sent_at: &str) -> Result<(), String> {
    if version != 1 {
        return Err(invalid("version", "must be 1"));
    }
    if chrono::DateTime::parse_from_rfc3339(sent_at).is_err() || !sent_at.contains('T') {
        return Err(invalid("sentAt", "must be an ISO date-time with an offset"));
    }
    Ok(())
}

/// The event payload, with only the fields the adapter reads.
fn event_payload(payload: Value) -> Result<Value, String> {
    let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
    let normalized = match kind {
        "message" | "app_mention" => {
            serde_json::from_value::<MessageEventWire>(payload).and_then(serde_json::to_value)
        }
        "member_joined_channel" | "member_left_channel" => {
            serde_json::from_value::<MemberEventWire>(payload).and_then(serde_json::to_value)
        }
        _ => return Err(invalid("payload.type", "is not an event the adapter reads")),
    };
    normalized.map_err(|err| invalid("payload", err))
}

/// The `block_actions` payload, with only the fields the adapter reads.
fn block_actions_payload(payload: Value) -> Result<Value, String> {
    let wire: BlockActionsWire =
        serde_json::from_value(payload).map_err(|err| invalid("payload", err))?;
    if wire.kind != "block_actions" {
        return Err(invalid("payload.type", "must be block_actions"));
    }
    if wire.actions.is_empty() {
        return Err(invalid("payload.actions", "must have an action"));
    }
    for block in wire.message.blocks.iter().flatten() {
        if !block.get("type").is_some_and(Value::is_string)
            || block.get("block_id").is_some_and(|id| !id.is_string())
        {
            return Err(invalid("payload.message.blocks", "a block needs a type"));
        }
    }
    serde_json::to_value(wire).map_err(|err| invalid("payload", err))
}

/// Parse an envelope, or name what is wrong with it.
pub fn parse_router_envelope(body: &Value) -> Result<RouterEnvelope, String> {
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("kind", "is missing"))?;
    let body = body.clone();
    match kind {
        "slack" => {
            let wire: SlackWire = serde_json::from_value(body).map_err(|err| err.to_string())?;
            check_common(wire.version, &wire.sent_at)?;
            let is_block_actions = match (wire.route, wire.payload_type.as_str()) {
                (SlackRoute::Action, "block_actions") => true,
                (SlackRoute::Action, _) => {
                    return Err(invalid("payloadType", "an action is block_actions"));
                }
                (_, "event") => false,
                _ => return Err(invalid("payloadType", "an event route takes an event")),
            };
            let payload = if is_block_actions {
                block_actions_payload(wire.payload)?
            } else {
                event_payload(wire.payload)?
            };
            Ok(RouterEnvelope::Slack(SlackEnvelope {
                event_id: wire.event_id.0,
                sent_at: wire.sent_at,
                team_id: wire.team_id.0,
                person_id: wire.person.map(|person| person.id.0),
                route: wire.route,
                is_block_actions,
                payload,
            }))
        }
        "link" => {
            let wire: LinkWire = serde_json::from_value(body).map_err(|err| err.to_string())?;
            check_common(wire.version, &wire.sent_at)?;
            Ok(RouterEnvelope::Link {
                event_id: wire.event_id.0,
                sent_at: wire.sent_at,
                team_id: wire.team_id.0,
                link: wire.link,
            })
        }
        "connected" => {
            let wire: ConnectedWire =
                serde_json::from_value(body).map_err(|err| err.to_string())?;
            check_common(wire.version, &wire.sent_at)?;
            Ok(RouterEnvelope::Connected {
                event_id: wire.event_id.0,
                sent_at: wire.sent_at,
                team_id: wire.team_id.0,
                workspace: wire.workspace,
            })
        }
        "disconnected" => {
            let wire: DisconnectedWire =
                serde_json::from_value(body).map_err(|err| err.to_string())?;
            check_common(wire.version, &wire.sent_at)?;
            Ok(RouterEnvelope::Disconnected {
                event_id: wire.event_id.0,
                sent_at: wire.sent_at,
                team_id: wire.team_id.0,
            })
        }
        _ => Err(invalid("kind", "is not a kind of envelope")),
    }
}

impl SlackEnvelope {
    /// The envelope as the router sent it, with the payload's unread fields
    /// dropped: what a pending-work row keeps, and parses back.
    pub fn to_value(&self) -> Value {
        json!({
            "version": 1,
            "eventId": self.event_id,
            "sentAt": self.sent_at,
            "teamId": self.team_id,
            "kind": "slack",
            "person": self.person_id.as_ref().map(|id| json!({ "id": id })),
            "route": self.route,
            "payloadType": if self.is_block_actions { "block_actions" } else { "event" },
            "payload": self.payload,
        })
    }

    /// The body the adapter's dispatch reads for the envelope. It names no
    /// team, so the listeners use the app's own client, whose calls carry no
    /// `team_id`: the proxy token already names the workspace.
    pub fn to_listener_body(&self) -> Value {
        if self.is_block_actions {
            return self.payload.clone();
        }
        // A mention reaches the adapter's message handler, which reads it as the
        // message it is.
        let mut event = self.payload.clone();
        if event.get("type").and_then(Value::as_str) == Some("app_mention") {
            event["type"] = json!("message");
        }
        json!({ "type": "event_callback", "event_id": self.event_id, "event": event })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slack(payload: Value) -> Value {
        json!({
            "version": 1,
            "eventId": "Ev1",
            "sentAt": "2026-11-20T10:00:00.000Z",
            "teamId": "T1",
            "kind": "slack",
            "person": { "id": "person-1" },
            "route": "mention",
            "payloadType": "event",
            "payload": payload,
        })
    }

    fn message() -> Value {
        json!({ "type": "app_mention", "channel": "C1", "user": "U1", "text": "<@UBOT> hi", "ts": "1.2" })
    }

    #[test]
    fn reads_a_slack_event_and_drops_the_payload_fields_it_does_not_read() {
        let mut payload = message();
        payload["blocks"] = json!([{ "type": "rich_text" }]);
        payload["team"] = json!("T1");
        let RouterEnvelope::Slack(envelope) = parse_router_envelope(&slack(payload)).unwrap()
        else {
            panic!("not a slack envelope");
        };
        assert_eq!(envelope.route, SlackRoute::Mention);
        assert_eq!(envelope.person_id.as_deref(), Some("person-1"));
        assert_eq!(
            envelope.payload,
            json!({ "type": "app_mention", "channel": "C1", "user": "U1", "text": "<@UBOT> hi", "ts": "1.2" })
        );
        // A mention is a message to the handler, and the body names no team.
        assert_eq!(
            envelope.to_listener_body(),
            json!({
                "type": "event_callback",
                "event_id": "Ev1",
                "event": { "type": "message", "channel": "C1", "user": "U1", "text": "<@UBOT> hi", "ts": "1.2" },
            })
        );
        // The stored form parses back to the same envelope.
        assert_eq!(
            parse_router_envelope(&envelope.to_value()).unwrap(),
            RouterEnvelope::Slack(envelope)
        );
    }

    #[test]
    fn refuses_an_unknown_field_version_kind_or_route() {
        let mut extra = slack(message());
        extra["extra"] = json!(true);
        assert!(parse_router_envelope(&extra).is_err());
        let mut version = slack(message());
        version["version"] = json!(2);
        assert!(parse_router_envelope(&version).is_err());
        let mut kind = slack(message());
        kind["kind"] = json!("other");
        assert!(parse_router_envelope(&kind).is_err());
        let mut route = slack(message());
        route["route"] = json!("action");
        assert!(parse_router_envelope(&route).is_err());
        let mut no_person = slack(message());
        no_person.as_object_mut().unwrap().remove("person");
        assert!(parse_router_envelope(&no_person).is_err());
        let mut sent_at = slack(message());
        sent_at["sentAt"] = json!("yesterday");
        assert!(parse_router_envelope(&sent_at).is_err());
        let mut empty_id = slack(message());
        empty_id["eventId"] = json!("");
        assert!(parse_router_envelope(&empty_id).is_err());
        assert!(parse_router_envelope(&slack(json!({ "type": "reaction_added" }))).is_err());
        assert!(parse_router_envelope(&json!("text")).is_err());
    }

    #[test]
    fn reads_links_connections_and_actions() {
        let link = json!({
            "version": 1, "eventId": "Ev2", "sentAt": "2026-11-20T10:00:00+02:00", "teamId": "T1",
            "kind": "link",
            "link": { "op": "add", "type": "dm", "slackUserId": "U1", "dmChannelId": "D1", "personId": "p1" },
        });
        let RouterEnvelope::Link { link, .. } = parse_router_envelope(&link).unwrap() else {
            panic!("not a link");
        };
        assert_eq!(link.op(), LinkOp::Add);
        assert_eq!(link.person_id(), "p1");

        let connected = json!({
            "version": 1, "eventId": "Ev3", "sentAt": "2026-11-20T10:00:00Z", "teamId": "T1",
            "kind": "connected",
            "workspace": { "teamId": "T1", "teamName": "Acme", "botUserId": "UBOT", "botId": "B1" },
        });
        assert!(matches!(
            parse_router_envelope(&connected).unwrap(),
            RouterEnvelope::Connected { .. }
        ));

        let action = json!({
            "version": 1, "eventId": "Ev4", "sentAt": "2026-11-20T10:00:00Z", "teamId": "T1",
            "kind": "slack", "person": null, "route": "action", "payloadType": "block_actions",
            "payload": {
                "type": "block_actions", "user": { "id": "U1", "name": "u" }, "channel": { "id": "C1" },
                "message": { "ts": "1.2", "blocks": [{ "type": "actions", "block_id": "fb", "elements": [] }] },
                "actions": [{ "action_id": "feedback_up", "value": "m1" }],
            },
        });
        let RouterEnvelope::Slack(envelope) = parse_router_envelope(&action).unwrap() else {
            panic!("not a slack envelope");
        };
        assert!(envelope.is_block_actions);
        assert_eq!(envelope.person_id, None);
        assert_eq!(envelope.to_listener_body()["user"], json!({ "id": "U1" }));
        assert_eq!(
            envelope.to_listener_body()["message"]["blocks"][0]["elements"],
            json!([])
        );
    }
}
