//! Webhook Service
//!
//! Handles inbound webhook events (POST /agents/webhooks/:name). Modeled on
//! hermes-agent's webhook receiver: per-subscription named routes with an
//! optional event-type allowlist, an optional prompt template, and a delivery
//! target. Agent-mode runs are fire-and-forget (the route answers 202 before
//! the LLM finishes); deliver-only subscriptions publish the rendered template
//! directly with no LLM call.
//!
//! Deliveries arrive on the webhook port, which a deployment exposes to senders.
//! A subscription may require its sender to prove itself (generic token/HMAC
//! verification via `lib/webhook_signature.rs`), checked here before any
//! filtering, delivery or LLM work happens.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use http::HeaderMap;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::db::models::{
    WebhookAuthAlgorithm, WebhookAuthEncoding, WebhookAuthType, WebhookSubscription,
};
use crate::lib::prompt_fence::fence;
use crate::prompts::webhook_prompt_tags::{WEBHOOK_EVENT_DATA_TAG, WEBHOOK_PROMPT_TAG};
use crate::services::delivery_target_service::{Delivery, parse_comma_list};
use crate::services::message_delivery_service::PublishOptions;
use crate::services::pending_work_service::PendingWorkItem;
use crate::services::webhook_run_service::{AcceptedEvent, WebhookRunResult};
use crate::support::js;
use crate::{log_error, log_info, log_warn};

// ============================================================================
// Types
// ============================================================================

/// Subscription name rule, borrowed from hermes: lowercase slug.
pub static WEBHOOK_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]*$").expect("valid regex"));

/// Discriminated outcome of an inbound delivery, mapped to HTTP by the route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WebhookInboundResult {
    /// 403
    ReceiverDisabled,
    /// 404
    NotFound,
    /// 403
    SubscriptionDisabled,
    /// 401 — sender not verified
    Unauthorized {
        #[serde(rename = "authType")]
        auth_type: String,
    },
    /// 429 — this subscription's run queue is full
    Busy,
    /// 200 — event filter miss
    Ignored { event: String },
    /// 200 — deliver-only, published
    Delivered { event: String },
    /// 202 — agent run dispatched or queued
    Accepted { event: String },
}

/// A run's result, with the `webhook processed` props for the channel counts its
/// delivery reported.
struct RunOutcome {
    result: WebhookRunResult,
    chosen_channel_props: IndexMap<String, String>,
}

/// The `webhook processed` props for a delivery to chosen channels, named for the
/// channel: `webhook.<channel>_posted` and `webhook.<channel>_skipped`. Empty when
/// the delivery chose no channels.
fn chosen_channel_props(delivery: Option<&Delivery>) -> IndexMap<String, String> {
    todo!()
}

/// Max agent runs waiting per subscription (excluding the one in flight).
/// Beyond this the delivery answers 429 — a backstop for pathological floods,
/// not a normal-operation limit.
pub const WEBHOOK_MAX_PENDING: usize = 10;

// Hermes truncation caps for payload rendering.
const RAW_PAYLOAD_MAX_CHARS: usize = 4000;
const NESTED_VALUE_MAX_CHARS: usize = 2000;

// ============================================================================
// Validation helpers (shared with the management CRUD route)
// ============================================================================

static WHITESPACE_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("valid regex"));

/// Normalize a user-supplied subscription name the way hermes does. A value
/// that is not a string normalizes to the empty string.
pub fn normalize_webhook_name(raw: &Value) -> String {
    match raw {
        Value::String(text) => WHITESPACE_RUN
            .replace_all(&text.trim().to_lowercase(), "-")
            .into_owned(),
        _ => String::new(),
    }
}

/// A subscription as the management API exposes it: no secret, ever.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicWebhookSubscription {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: Option<String>,
    pub events: Option<String>,
    pub prompt: Option<String>,
    pub deliver_to: String,
    pub deliver_only: bool,
    pub is_active: bool,
    pub auth_type: WebhookAuthType,
    pub auth_header: Option<String>,
    pub auth_prefix: Option<String>,
    pub auth_algorithm: WebhookAuthAlgorithm,
    pub auth_encoding: WebhookAuthEncoding,
    pub auth_signed_url: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
    pub slack_channel_ids: Vec<String>,
    pub has_secret: bool,
}

/// Project a subscription row for the API. The stored secret must never leave
/// the process, so every response (list, create, update) goes through here and
/// reports only *whether* a secret is set.
pub fn to_public_subscription(row: &WebhookSubscription) -> PublicWebhookSubscription {
    PublicWebhookSubscription {
        id: row.id.clone(),
        agent_id: row.agent_id.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        events: row.events.clone(),
        prompt: row.prompt.clone(),
        deliver_to: row.deliver_to.clone(),
        deliver_only: row.deliver_only,
        is_active: row.is_active,
        auth_type: row.auth_type.clone(),
        auth_header: row.auth_header.clone(),
        auth_prefix: row.auth_prefix.clone(),
        auth_algorithm: row.auth_algorithm.clone(),
        auth_encoding: row.auth_encoding.clone(),
        auth_signed_url: row.auth_signed_url.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        slack_channel_ids: parse_comma_list(row.slack_channel_ids.as_deref()),
        has_secret: row
            .secret
            .as_deref()
            .is_some_and(|secret| !secret.trim().is_empty()),
    }
}

// ============================================================================
// Event type resolution + prompt rendering (ported from hermes)
// ============================================================================

/// A header's text as Node reads it: every value, latin-1 decoded and joined
/// with `", "`, then trimmed. Empty when the request has no such header.
fn header_text(headers: &HeaderMap, name: &str) -> String {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| value.as_bytes().iter().map(|&byte| byte as char).collect())
        .collect();
    values.join(", ").trim().to_string()
}

/// Resolve the incoming event's type: GitHub header → GitLab header → payload
/// top-level `event_type` → 'unknown'. Sources that don't declare a type
/// (e.g. Alertmanager, PagerDuty) resolve to 'unknown', so their subscriptions
/// should leave the events allowlist empty.
pub fn resolve_event_type(headers: &HeaderMap, payload: &Map<String, Value>) -> String {
    let from_payload = match payload.get("event_type") {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    };
    [
        header_text(headers, "x-github-event"),
        header_text(headers, "x-gitlab-event"),
        from_payload,
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or_else(|| "unknown".to_string())
}

static TEMPLATE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{([a-zA-Z0-9_.]+)\}").expect("valid regex"));

/// `String(value)` for a JSON scalar.
fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => js::number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(_) | Value::Object(_) => js::stringify(value),
    }
}

/// Render a prompt template against the webhook payload.
///
/// Supports `{dot.path}` access into nested objects and the special
/// `{__raw__}` token that dumps the whole payload as indented JSON
/// (truncated). Unresolvable keys are left literal. An empty template falls
/// back to a raw payload dump with an event/route lead-in — the agent reasons
/// over the JSON directly.
///
/// `wrap_value` receives every piece of text taken from the payload, so a caller
/// can mark it as data; the deliver-only path passes `None` and delivers the text
/// as it is.
pub fn render_webhook_prompt(
    template: Option<&str>,
    payload: &Map<String, Value>,
    event_type: &str,
    route_name: &str,
    wrap_value: Option<&dyn Fn(&str) -> String>,
) -> String {
    let wrap = |value: &str| -> String {
        match wrap_value {
            Some(wrap_value) => wrap_value(value),
            None => value.to_string(),
        }
    };
    let whole = Value::Object(payload.clone());

    let template = match template {
        Some(template) if !template.trim().is_empty() => template,
        _ => {
            let truncated = js::slice16(&js::stringify_pretty(&whole), 0, RAW_PAYLOAD_MAX_CHARS);
            // The event type comes from the sender's headers or payload, so it is a value like any other.
            return format!(
                "Webhook event '{}' on route '{}':\n\n{}",
                wrap(event_type),
                route_name,
                wrap(&format!("```json\n{truncated}\n```"))
            );
        }
    };

    TEMPLATE_KEY
        .replace_all(template, |caps: &regex::Captures<'_>| -> String {
            let matched = caps[0].to_string();
            let key = &caps[1];
            if key == "__raw__" {
                return wrap(&js::slice16(
                    &js::stringify_pretty(&whole),
                    0,
                    RAW_PAYLOAD_MAX_CHARS,
                ));
            }
            let mut value: &Value = &whole;
            for part in key.split('.') {
                match value {
                    Value::Object(object) => match object.get(part) {
                        Some(next) => value = next,
                        None => return matched,
                    },
                    _ => return matched,
                }
            }
            match value {
                Value::Object(_) | Value::Array(_) => wrap(&js::slice16(
                    &js::stringify_pretty(value),
                    0,
                    NESTED_VALUE_MAX_CHARS,
                )),
                other => wrap(&scalar_text(other)),
            }
        })
        .into_owned()
}

/// The message an agent-mode run receives: the subscription's prompt inside
/// `subscription_prompt`, with every value taken from the event fenced as
/// `event_data`, so the model follows the operator's words and treats the
/// sender's as data. An empty template has no operator words, so the message is
/// the event alone.
pub fn render_webhook_turn_prompt(
    template: Option<&str>,
    payload: &Map<String, Value>,
    event_type: &str,
    route_name: &str,
) -> String {
    let fence_value = |value: &str| fence(value, WEBHOOK_EVENT_DATA_TAG);
    let rendered = render_webhook_prompt(
        template,
        payload,
        event_type,
        route_name,
        Some(&fence_value),
    );
    match template {
        Some(template) if !template.trim().is_empty() => format!(
            "<{WEBHOOK_PROMPT_TAG} name=\"{route_name}\">\n{rendered}\n</{WEBHOOK_PROMPT_TAG}>"
        ),
        _ => rendered,
    }
}

/// An agent run, as `pending_work` holds it until the run ends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebhookWork {
    subscription_id: String,
    /// The rendered prompt, so a template edited later does not change an accepted event.
    prompt: String,
    /// The run's record, which the boot writes when a restart came before it was.
    run: AcceptedEvent,
}

/// One queued agent run of a subscription.
type QueuedRun = Box<dyn FnOnce() -> BoxFuture<'static, anyhow::Result<()>> + Send>;

// ============================================================================
// Webhook Service
// ============================================================================

pub struct WebhookService {
    /// Per-subscription run queues. Agent runs execute serially per subscription
    /// (one in flight, the rest FIFO-queued): rejecting concurrent deliveries
    /// outright would silently lose distinct events from senders that don't
    /// retry on non-2xx (GitHub never redelivers automatically), while unbounded
    /// fan-out would let a flapping alert turn into arbitrary concurrent LLM
    /// runs. Queueing gives both: nothing is dropped under normal bursts, and
    /// spend stays bounded by serialization plus the `WEBHOOK_MAX_PENDING` cap.
    pending: parking_lot::Mutex<HashMap<String, VecDeque<QueuedRun>>>,
    running: parking_lot::Mutex<HashSet<String>>,
}

impl WebhookService {
    pub fn new() -> Self {
        WebhookService {
            pending: parking_lot::Mutex::new(HashMap::new()),
            running: parking_lot::Mutex::new(HashSet::new()),
        }
    }

    /// Process one inbound delivery. Synchronous parts (lookups, sender
    /// verification, event filter, deliver-only publish) complete before
    /// returning; agent-mode runs are dispatched fire-and-forget so the route can
    /// answer 202 immediately.
    ///
    /// `raw_body` is the exact received bytes (`lib/raw_body.rs`), needed to verify
    /// HMAC signatures.
    pub async fn handle_inbound(
        &self,
        name: &str,
        payload: &Map<String, Value>,
        headers: &HeaderMap,
        run_id: &str,
        raw_body: Option<&[u8]>,
    ) -> anyhow::Result<WebhookInboundResult> {
        todo!()
    }

    /// Run again the agent runs a restart interrupted, each in its subscription's
    /// queue, then fail every unfinished run left: a deliver-only publish, whose
    /// sender got no answer, and a run whose subscription is gone.
    pub async fn resume(&self, items: Vec<PendingWorkItem>) -> anyhow::Result<()> {
        todo!()
    }

    /// Queue an agent run behind its subscription's earlier runs.
    fn enqueue(&self, subscription_id: &str, run: QueuedRun) {
        todo!()
    }

    /// Run the next queued delivery for a subscription, if none is in flight.
    fn drain_queue(&self, subscription_id: &str) {
        todo!()
    }

    /// Run the agent over the rendered prompt and record how the run ended. A run a
    /// shutdown stops before it posts records nothing, and the next boot runs it again.
    async fn run_agent(
        &self,
        subscription: &WebhookSubscription,
        prompt: &str,
        run_id: &str,
        start_time: i64,
        after_restart: bool,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Invoke the agent and deliver its final response, or the spending-limit
    /// notice. `None` when a shutdown stopped the run before it posted anything.
    async fn invoke_and_deliver(
        &self,
        agent_id: &str,
        user_id: &str,
        subscription: &WebhookSubscription,
        prompt: &str,
        after_restart: bool,
    ) -> anyhow::Result<Option<RunOutcome>> {
        todo!()
    }

    /// The sender already got 202 and won't retry, so a run that failed tells the
    /// user in a brief notice. Best-effort, since delivery may be what failed.
    async fn deliver_failure_notice(
        &self,
        agent_id: &str,
        user_id: &str,
        subscription: &WebhookSubscription,
        msg: &str,
    ) -> Option<Delivery> {
        todo!()
    }

    /// Deliver a webhook message per the subscription's target, naming the
    /// subscription for the model. Of `options`, only `tool_calls` and
    /// `attachment_ids` are read.
    async fn deliver(
        &self,
        agent_id: &str,
        user_id: &str,
        subscription: &WebhookSubscription,
        content: &str,
        options: Option<PublishOptions>,
    ) -> anyhow::Result<Delivery> {
        todo!()
    }
}

impl Default for WebhookService {
    fn default() -> Self {
        Self::new()
    }
}

pub static WEBHOOK_SERVICE: LazyLock<WebhookService> = LazyLock::new(WebhookService::new);
