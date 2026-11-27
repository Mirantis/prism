//! Records what every model call cost: one row per call, written when the call
//! returns, so a suppressed heartbeat and a compaction are counted along with a
//! published turn. Writes are fire-and-forget and fail soft — an accounting
//! error costs a log line, and the turn that made the call carries on.
//!
//! Each row has its estimated cost (`lib/model_pricing.rs`), and the request and
//! thread from the spend context (`lib/spend_context.rs`) where the caller names none.

use std::borrow::Cow;
use std::fmt;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::json;

use crate::ai::LanguageModelUsage;
use crate::config::CONFIG;
use crate::db::models::{NewLlmCall, llm_call_bucket};
use crate::db::schema::llm_calls::dsl as l;
use crate::lib::llm_providers::llm_provider::{CacheTtl, cache_ttl_for};
use crate::lib::log_redaction::err_json;
use crate::lib::model_catalog::ModelPrice;
use crate::lib::model_pricing::{PricedTokens, cost_micro_usd, price_for};
use crate::lib::spend_context::{SpendContext, SpendSource, current_spend_context};
use crate::lib::step_usage::to_step_usage;
use crate::services::channel_adapter_interface::{CHAT_PLATFORMS, ChatPlatform};
use crate::support::js::round as js_round;
use crate::{log_error, log_info, log_warn};

/// What a call was for: an invoke mode, or a named side call.
///
/// An enum rather than a free string so a new call site has to name itself, and
/// so the set stays greppable when someone asks where the tokens went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LlmCallPurpose {
    // Invoke modes — `InvokeRequest.mode`, recorded per model step.
    Chat,
    Heartbeat,
    Cron,
    Goal,
    Webhook,
    Subagent,
    // Side calls, each one `generate_text`/`generate_object` outside the invoke loop.
    EarlyStopping,
    Compaction,
    ThreadTitle,
    FeedbackGate,
    GoalGate,
    RiskGate,
    ModelRouting,
    AgentVoice,
    /// The usage a coding agent's CLI reported for a task.
    CodingAgent,
    // Realtime voice sessions, one row per response or transcription.
    VoiceChat,
    Meeting,
    Dictation,
    /// A chat platform's thread reply classifier, named for the platform
    /// (`<platform>-thread-gate`).
    ThreadGate(ChatPlatform),
}

impl LlmCallPurpose {
    /// The stored text of the purpose.
    pub fn as_str(&self) -> Cow<'static, str> {
        Cow::Borrowed(match self {
            LlmCallPurpose::Chat => "chat",
            LlmCallPurpose::Heartbeat => "heartbeat",
            LlmCallPurpose::Cron => "cron",
            LlmCallPurpose::Goal => "goal",
            LlmCallPurpose::Webhook => "webhook",
            LlmCallPurpose::Subagent => "subagent",
            LlmCallPurpose::EarlyStopping => "early-stopping",
            LlmCallPurpose::Compaction => "compaction",
            LlmCallPurpose::ThreadTitle => "thread-title",
            LlmCallPurpose::FeedbackGate => "feedback-gate",
            LlmCallPurpose::GoalGate => "goal-gate",
            LlmCallPurpose::RiskGate => "risk-gate",
            LlmCallPurpose::ModelRouting => "model-routing",
            LlmCallPurpose::AgentVoice => "agent-voice",
            LlmCallPurpose::CodingAgent => "coding-agent",
            LlmCallPurpose::VoiceChat => "voice-chat",
            LlmCallPurpose::Meeting => "meeting",
            LlmCallPurpose::Dictation => "dictation",
            LlmCallPurpose::ThreadGate(platform) => {
                return Cow::Owned(format!("{}-thread-gate", platform.as_str()));
            }
        })
    }

    /// The purpose a stored text names, or `None` for any other text.
    pub fn parse(value: &str) -> Option<LlmCallPurpose> {
        if let Some(found) = LLM_CALL_PURPOSES
            .iter()
            .find(|purpose| purpose.as_str() == value)
        {
            return Some(*found);
        }
        let platform = value.strip_suffix("-thread-gate")?;
        CHAT_PLATFORMS
            .into_iter()
            .find(|candidate| candidate.as_str() == platform)
            .map(LlmCallPurpose::ThreadGate)
    }
}

impl fmt::Display for LlmCallPurpose {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_str())
    }
}

impl Serialize for LlmCallPurpose {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.as_str())
    }
}

impl<'de> Deserialize<'de> for LlmCallPurpose {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        LlmCallPurpose::parse(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown purpose: {text}")))
    }
}

/// Every fixed purpose, so a test can assert the enum and the recorders agree.
/// A value here with no recorder is spend nobody is counting.
pub const LLM_CALL_PURPOSES: [LlmCallPurpose; 18] = [
    LlmCallPurpose::Chat,
    LlmCallPurpose::Heartbeat,
    LlmCallPurpose::Cron,
    LlmCallPurpose::Goal,
    LlmCallPurpose::Webhook,
    LlmCallPurpose::Subagent,
    LlmCallPurpose::EarlyStopping,
    LlmCallPurpose::Compaction,
    LlmCallPurpose::ThreadTitle,
    LlmCallPurpose::FeedbackGate,
    LlmCallPurpose::GoalGate,
    LlmCallPurpose::RiskGate,
    LlmCallPurpose::ModelRouting,
    LlmCallPurpose::AgentVoice,
    LlmCallPurpose::CodingAgent,
    LlmCallPurpose::VoiceChat,
    LlmCallPurpose::Meeting,
    LlmCallPurpose::Dictation,
];

/// Which models a call's spend goes to: the agent's own, the coding agent's, or the voice models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpendKind {
    Main,
    CodingAgent,
    Voice,
}

impl SpendKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::CodingAgent => "coding-agent",
            Self::Voice => "voice",
        }
    }
}

const VOICE_PURPOSES: [&str; 3] = ["voice-chat", "meeting", "dictation"];

/// The purposes whose calls are not the agent's own model's.
pub const OTHER_MODEL_PURPOSES: [LlmCallPurpose; 4] = [
    LlmCallPurpose::CodingAgent,
    LlmCallPurpose::VoiceChat,
    LlmCallPurpose::Meeting,
    LlmCallPurpose::Dictation,
];

pub fn spend_kind_of(purpose: &str) -> SpendKind {
    if purpose == "coding-agent" {
        return SpendKind::CodingAgent;
    }
    if VOICE_PURPOSES.contains(&purpose) {
        SpendKind::Voice
    } else {
        SpendKind::Main
    }
}

/// One call's tokens, in the columns `llm_calls` stores.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CallTokens {
    pub total_tokens: i64,
    /// The whole prompt, cache reads and writes included.
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub no_cache_tokens: i64,
    /// The part of `cache_write_tokens` written with the one-hour lifetime. Priced, not stored.
    pub long_cache_write_tokens: Option<i64>,
    /// The audio part of `no_cache_tokens`.
    pub audio_input_tokens: Option<i64>,
    /// The audio part of `output_tokens`.
    pub audio_output_tokens: Option<i64>,
}

/// The tokens of the model calls recorded while a [`counting_usage`] scope runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct CountedUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

tokio::task_local! {
    static COUNTED_USAGE: std::sync::Arc<parking_lot::Mutex<CountedUsage>>;
}

/// Run `work`, and answer the tokens of every model call it recorded, with its output.
/// The prompt eval set counts a sample's spend this way.
pub async fn counting_usage<F: std::future::Future>(work: F) -> (F::Output, CountedUsage) {
    let counted = std::sync::Arc::new(parking_lot::Mutex::new(CountedUsage::default()));
    let output = COUNTED_USAGE.scope(counted.clone(), work).await;
    let usage = *counted.lock();
    (output, usage)
}

/// One model call the AI SDK made, to record.
#[derive(Debug, Clone)]
pub struct RecordInput {
    pub purpose: LlmCallPurpose,
    /// The model id the call went to.
    pub model: String,
    /// What the provider reported. `None` is still recorded, as a row with zero
    /// counts: the call happened, and its cost was not reported.
    pub usage: Option<LanguageModelUsage>,
    /// The thread this call belongs to, where it has one. Defaults to the spend context's.
    pub thread_id: Option<String>,
    /// The request this call served. Defaults to the spend context's.
    pub request_id: Option<String>,
    /// What started the request. Defaults to the spend context's.
    pub source: Option<SpendSource>,
    /// The agent the call ran for. Omit for the runtime's own work; pass the
    /// invoked agent where a turn may belong to a subagent, and the row records it
    /// as provenance while the spend still lands on the owner.
    pub agent_id: Option<String>,
}

/// One call whose tokens the caller read itself, such as a CLI's or a Realtime
/// session's, to record.
#[derive(Debug, Clone)]
pub struct RecordTokensInput {
    pub purpose: LlmCallPurpose,
    /// The model id the call went to.
    pub model: String,
    /// `None` is recorded as a row with zero counts and no cost.
    pub tokens: Option<CallTokens>,
    /// The thread this call belongs to, where it has one. Defaults to the spend context's.
    pub thread_id: Option<String>,
    /// The request this call served. Defaults to the spend context's.
    pub request_id: Option<String>,
    /// What started the request. Defaults to the spend context's.
    pub source: Option<SpendSource>,
    /// The agent the call ran for; see [`RecordInput::agent_id`].
    pub agent_id: Option<String>,
    /// The call ran on a subscription, which bills no tokens: its cost is zero.
    pub subscription: bool,
    /// A cost in US dollars that the caller's tool reported. It wins over the catalog:
    /// a coding agent reports one row for many requests, and only the tool knows what
    /// each request cost.
    pub reported_cost_usd: Option<f64>,
}

impl RecordTokensInput {
    /// A call of `model` for `purpose` with `tokens`, in the spend context's request.
    pub fn new(
        purpose: LlmCallPurpose,
        model: impl Into<String>,
        tokens: Option<CallTokens>,
    ) -> Self {
        RecordTokensInput {
            purpose,
            model: model.into(),
            tokens,
            thread_id: None,
            request_id: None,
            source: None,
            agent_id: None,
            subscription: false,
            reported_cost_usd: None,
        }
    }
}

/// A 15-minute bucket, the grain `llm_calls.bucket` stores.
#[cfg(test)]
const BUCKET_MS: i64 = 15 * 60 * 1000;

/// Rows priced per transaction when calls recorded without a price are priced again.
const PRICING_BATCH: i64 = 200;

/// The tokens to price. Where the caller does not split the cache writes by lifetime,
/// they have the lifetime the call's mode asks for (`cache_ttl_for`). A row priced
/// again later has no split stored, so it takes that lifetime too.
fn priced_tokens(tokens: &CallTokens, ttl: CacheTtl) -> PricedTokens {
    PricedTokens {
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        cache_read_tokens: tokens.cache_read_tokens,
        cache_write_tokens: tokens.cache_write_tokens,
        long_cache_write_tokens: tokens.long_cache_write_tokens.unwrap_or(
            if ttl == CacheTtl::OneHour {
                tokens.cache_write_tokens
            } else {
                0
            },
        ),
        audio_input_tokens: tokens.audio_input_tokens.unwrap_or(0),
        audio_output_tokens: tokens.audio_output_tokens.unwrap_or(0),
    }
}

/// The cache lifetime a call of `purpose` asks for, with the chat lifetime given.
fn ttl_of(purpose: &str, chat_ttl: CacheTtl) -> CacheTtl {
    if purpose == "chat" {
        chat_ttl
    } else {
        cache_ttl_for(purpose)
    }
}

/// Purposes whose one row sums many model requests: a coding agent reports the
/// tokens of a whole task (Claude Code) or turn (Codex). A price tier applies to
/// one request's prompt, and the sum says nothing about any one prompt, so these
/// rows take the base price.
const SUMMED_PURPOSES: [&str; 1] = ["coding-agent"];

fn catalog_cost(price: &ModelPrice, purpose: &str, tokens: &CallTokens, chat_ttl: CacheTtl) -> i64 {
    let tokens = priced_tokens(tokens, ttl_of(purpose, chat_ttl));
    if SUMMED_PURPOSES.contains(&purpose) {
        let base = ModelPrice {
            tiers: None,
            ..price.clone()
        };
        return cost_micro_usd(&base, &tokens);
    }
    cost_micro_usd(price, &tokens)
}

/// The cost and its source for a call, with the catalog price looked up by `price`.
fn cost_of(
    input: &RecordTokensInput,
    price: impl FnOnce(&str) -> Option<ModelPrice>,
    chat_ttl: CacheTtl,
) -> (Option<i64>, Option<String>) {
    if input.subscription {
        return (Some(0), Some("subscription".into()));
    }
    if let Some(reported) = input.reported_cost_usd.filter(|cost| cost.is_finite()) {
        return (
            Some(js_round(reported * 1_000_000.0) as i64),
            Some("reported".into()),
        );
    }
    match (price(&input.model), &input.tokens) {
        (Some(price), Some(tokens)) => (
            Some(catalog_cost(
                &price,
                &input.purpose.as_str(),
                tokens,
                chat_ttl,
            )),
            Some("catalog".into()),
        ),
        _ => (None, None),
    }
}

/// The newest call on a thread, as `newest_thread_call` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadCall {
    pub purpose: String,
    pub model: String,
    pub created_at: DateTime<Utc>,
}

pub struct LlmCallService;

impl LlmCallService {
    pub fn new() -> Self {
        LlmCallService
    }

    /// The newest call recorded on a thread with one of `purposes`, or `None` when
    /// there is none. A read for the caller's own decision, so a failed read is
    /// logged and returns `None`.
    pub async fn newest_thread_call(
        &self,
        thread_id: &str,
        purposes: &[LlmCallPurpose],
    ) -> Option<ThreadCall> {
        let owner = CONFIG.agent_id().filter(|id| !id.is_empty())?;
        let thread = thread_id.to_string();
        let purposes: Vec<String> = purposes.iter().map(|p| p.as_str().into_owned()).collect();
        let read = crate::db::read(move |conn| {
            Ok(l::llm_calls
                .filter(l::agent_id.eq(&owner))
                .filter(l::thread_id.eq(&thread))
                .filter(l::purpose.eq_any(&purposes))
                .order(l::created_at.desc())
                .select((l::purpose, l::model, l::created_at))
                .first::<(String, String, DateTime<Utc>)>(conn)
                .optional()?)
        })
        .await;
        match read {
            Ok(row) => row.map(|(purpose, model, created_at)| ThreadCall {
                purpose,
                model,
                created_at,
            }),
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err), "threadId": thread_id }),
                    "[LlmCall] failed to read a thread's newest call"
                );
                None
            }
        }
    }

    /// Record one model call the AI SDK made.
    ///
    /// Returns immediately: the insert runs in the background so no call site
    /// waits on it.
    ///
    /// A call the provider reported no usage for still gets a row, with zero
    /// counts. The count of rows is what the page calls "model calls", so dropping
    /// one would undercount the calls to keep the tokens tidy — and zero tokens is
    /// the honest record of a call whose cost the provider did not report.
    pub fn record(&self, input: RecordInput) {
        let _ = COUNTED_USAGE.try_with(|counted| {
            let usage = input.usage.as_ref();
            let mut counted = counted.lock();
            counted.input_tokens += usage.and_then(|u| u.input_tokens).unwrap_or(0);
            counted.output_tokens += usage.and_then(|u| u.output_tokens).unwrap_or(0);
        });
        self.record_tokens(tokens_input(input));
    }

    /// Record one call whose tokens the caller read itself, such as a CLI's or a
    /// Realtime session's. Returns immediately, as [`Self::record`] does.
    pub fn record_tokens(&self, input: RecordTokensInput) {
        // The owner pays, whoever ran the call. Filtering reads on this one column
        // keeps a past window's total from moving when a subagent link changes.
        let Some(row) = call_row(
            &input,
            current_spend_context(),
            chrono::Utc::now(),
            price_for,
            CONFIG.chat_cache_ttl,
        ) else {
            return;
        };
        let purpose = input.purpose.as_str().into_owned();

        // The spawn is guarded too: outside a runtime it would otherwise panic in
        // the middle of the turn that made the model call.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            log_error!(
                json!({
                    "err": err_json(&anyhow::anyhow!("no async runtime to record the call on")),
                    "purpose": purpose,
                }),
                "[LlmCall] failed to record a model call"
            );
            return;
        };
        handle.spawn(async move {
            let written = crate::db::run(move |conn| {
                diesel::insert_into(l::llm_calls)
                    .values(&row)
                    .execute(conn)?;
                Ok(())
            })
            .await;
            if let Err(err) = written {
                log_error!(
                    json!({ "err": err_json(&err), "purpose": purpose }),
                    "[LlmCall] failed to record a model call"
                );
            }
        });
    }

    /// Price the calls recorded without a price whose model the catalog now prices.
    /// A call the provider reported no tokens for stays unpriced. Never fails: a
    /// failure is logged, and the next catalog install tries again.
    pub async fn price_unpriced_calls(&self) {
        let Some(owner) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            return;
        };
        let priced = async {
            let unpriced = owner.clone();
            let models: Vec<String> = crate::db::read(move |conn| {
                Ok(l::llm_calls
                    .filter(l::agent_id.eq(&unpriced))
                    .filter(l::cost_micro_usd.is_null())
                    .filter(l::total_tokens.gt(0))
                    .group_by(l::model)
                    .select(l::model)
                    .load(conn)?)
            })
            .await?;
            let mut priced = 0usize;
            for model in models {
                if let Some(price) = price_for(&model) {
                    priced += price_model(&owner, &model, &price).await?;
                }
            }
            anyhow::Ok(priced)
        }
        .await;
        match priced {
            Ok(0) => {}
            Ok(priced) => log_info!(
                "[LlmCall] priced {} model call(s) recorded without a price",
                priced
            ),
            Err(err) => log_warn!(
                json!({ "err": err_json(&err) }),
                "[LlmCall] failed to price the calls recorded without a price"
            ),
        }
    }
}

/// The tokens of a call the AI SDK made, in the columns `llm_calls` stores.
fn tokens_input(input: RecordInput) -> RecordTokensInput {
    let step = to_step_usage(&input.model, input.usage.as_ref());
    RecordTokensInput {
        purpose: input.purpose,
        model: step
            .as_ref()
            .map(|u| u.model.clone())
            .unwrap_or_else(|| input.model.clone()),
        tokens: step.map(|u| CallTokens {
            total_tokens: u.total_tokens,
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_read_tokens: u.cache_read_tokens,
            cache_write_tokens: u.cache_write_tokens,
            no_cache_tokens: u.no_cache_tokens,
            ..CallTokens::default()
        }),
        thread_id: input.thread_id,
        request_id: input.request_id,
        source: input.source,
        agent_id: input.agent_id,
        subscription: false,
        reported_cost_usd: None,
    }
}

/// The token columns `price_model` reads back.
type StoredTokens = (String, String, i64, i64, i64, i64, i64, i64, i64, i64);

/// Price every unpriced call of `model` at `price`, a batch per transaction, and
/// answer how many it priced.
async fn price_model(owner: &str, model: &str, price: &ModelPrice) -> anyhow::Result<usize> {
    let mut priced = 0usize;
    loop {
        let (owner, model, price) = (owner.to_string(), model.to_string(), price.clone());
        let batch = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let rows: Vec<StoredTokens> = l::llm_calls
                    .filter(l::agent_id.eq(&owner))
                    .filter(l::model.eq(&model))
                    .filter(l::cost_micro_usd.is_null())
                    .filter(l::total_tokens.gt(0))
                    .limit(PRICING_BATCH)
                    .select((
                        l::id,
                        l::purpose,
                        l::total_tokens,
                        l::input_tokens,
                        l::output_tokens,
                        l::cache_read_tokens,
                        l::cache_write_tokens,
                        l::no_cache_tokens,
                        l::audio_input_tokens,
                        l::audio_output_tokens,
                    ))
                    .load(conn)?;
                for (
                    id,
                    purpose,
                    total,
                    input,
                    output,
                    read,
                    write,
                    no_cache,
                    audio_in,
                    audio_out,
                ) in &rows
                {
                    let tokens = CallTokens {
                        total_tokens: *total,
                        input_tokens: *input,
                        output_tokens: *output,
                        cache_read_tokens: *read,
                        cache_write_tokens: *write,
                        no_cache_tokens: *no_cache,
                        long_cache_write_tokens: None,
                        audio_input_tokens: Some(*audio_in),
                        audio_output_tokens: Some(*audio_out),
                    };
                    let cost = catalog_cost(&price, purpose, &tokens, CONFIG.chat_cache_ttl);
                    diesel::update(l::llm_calls.filter(l::id.eq(id)))
                        .set((
                            l::cost_micro_usd.eq(Some(cost)),
                            l::cost_source.eq(Some("catalog")),
                        ))
                        .execute(conn)?;
                }
                anyhow::Ok(rows.len())
            })
        })
        .await?;
        if batch == 0 {
            return Ok(priced);
        }
        priced += batch;
    }
}

/// The row `record_tokens` writes, or `None` when there is no agent to attribute
/// the spend to. `price` looks a model's catalog price up.
fn call_row(
    input: &RecordTokensInput,
    spend: Option<SpendContext>,
    now: chrono::DateTime<chrono::Utc>,
    price: impl FnOnce(&str) -> Option<ModelPrice>,
    chat_ttl: CacheTtl,
) -> Option<NewLlmCall> {
    let owner = CONFIG.agent_id().filter(|id| !id.is_empty())?;
    let ran_for = input
        .agent_id
        .as_ref()
        .filter(|id| !id.is_empty() && **id != owner)
        .cloned();
    let source = input
        .source
        .clone()
        .or_else(|| spend.as_ref().and_then(|s| s.source.clone()));
    let (cost_micro_usd, cost_source) = cost_of(input, price, chat_ttl);

    let mut row = NewLlmCall::new(
        owner,
        input.purpose.as_str().into_owned(),
        input.model.clone(),
    );
    row.subagent_id = ran_for;
    row.thread_id = input
        .thread_id
        .clone()
        .or_else(|| spend.as_ref().and_then(|s| s.thread_id.clone()));
    row.request_id = input
        .request_id
        .clone()
        .or_else(|| spend.as_ref().map(|s| s.request_id.clone()));
    row.source_kind = source.as_ref().map(|s| s.kind.as_str().to_string());
    row.source_id = source.and_then(|s| s.id);
    if let Some(tokens) = &input.tokens {
        row.total_tokens = tokens.total_tokens;
        row.input_tokens = tokens.input_tokens;
        row.output_tokens = tokens.output_tokens;
        row.cache_read_tokens = tokens.cache_read_tokens;
        row.cache_write_tokens = tokens.cache_write_tokens;
        row.no_cache_tokens = tokens.no_cache_tokens;
        row.audio_input_tokens = tokens.audio_input_tokens.unwrap_or(0);
        row.audio_output_tokens = tokens.audio_output_tokens.unwrap_or(0);
    }
    row.cost_micro_usd = cost_micro_usd;
    row.cost_source = cost_source;
    row.created_at = now.into();
    row.bucket = llm_call_bucket(now).into();
    Some(row)
}

impl Default for LlmCallService {
    fn default() -> Self {
        Self::new()
    }
}

pub static LLM_CALL_SERVICE: LazyLock<LlmCallService> = LazyLock::new(LlmCallService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::usage::{InputTokenDetails, OutputTokenDetails};
    use crate::db::models::LlmCall;
    use crate::db::testing::test_db;
    use crate::lib::model_catalog::PriceTier;
    use crate::lib::spend_context::SpendSourceKind;
    use chrono::{DateTime, TimeZone, Utc};

    /// What the AI SDK hands back for a cache-capable provider.
    fn usage() -> LanguageModelUsage {
        LanguageModelUsage {
            input_tokens: Some(1000),
            output_tokens: Some(100),
            total_tokens: Some(1100),
            input_token_details: InputTokenDetails {
                cache_read_tokens: Some(700),
                cache_write_tokens: Some(100),
                no_cache_tokens: Some(200),
            },
            output_token_details: OutputTokenDetails {
                text_tokens: Some(100),
                reasoning_tokens: Some(0),
            },
            raw: None,
        }
    }

    fn input(purpose: LlmCallPurpose, usage: Option<LanguageModelUsage>) -> RecordInput {
        RecordInput {
            purpose,
            model: "claude-opus-5".to_string(),
            usage,
            thread_id: None,
            request_id: None,
            source: None,
            agent_id: None,
        }
    }

    fn price(input: f64, output: f64) -> ModelPrice {
        ModelPrice {
            input,
            output,
            cache_read: None,
            cache_write: None,
            input_audio: None,
            output_audio: None,
            tiers: None,
        }
    }

    /// Dollars per million tokens, so the expected costs below are easy to check by hand.
    fn opus() -> ModelPrice {
        ModelPrice {
            cache_read: Some(0.5),
            cache_write: Some(6.25),
            ..price(5.0, 25.0)
        }
    }

    /// The prices the tests know: `claude-opus-5` alone, unless a test names more.
    fn prices(extra: &[(&str, ModelPrice)]) -> impl Fn(&str) -> Option<ModelPrice> + Clone + use<> {
        let mut known: Vec<(String, ModelPrice)> = vec![("claude-opus-5".into(), opus())];
        known.extend(
            extra
                .iter()
                .map(|(model, price)| (model.to_string(), price.clone())),
        );
        move |model: &str| {
            known
                .iter()
                .find(|(id, _)| id == model)
                .map(|(_, price)| price.clone())
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 21, 10, 0, 0).unwrap()
    }

    /// The row a recorded call writes, with the chat cache at five minutes.
    fn row(call: RecordTokensInput) -> NewLlmCall {
        call_row(&call, None, now(), prices(&[]), CacheTtl::FiveMinutes).unwrap()
    }

    fn tokens() -> CallTokens {
        CallTokens {
            total_tokens: 1100,
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_tokens: 700,
            cache_write_tokens: 100,
            no_cache_tokens: 200,
            ..CallTokens::default()
        }
    }

    fn coding(model: &str, tokens: CallTokens) -> RecordTokensInput {
        RecordTokensInput::new(LlmCallPurpose::CodingAgent, model, Some(tokens))
    }

    #[test]
    fn purposes_parse_back_from_their_stored_text() {
        for purpose in LLM_CALL_PURPOSES {
            assert_eq!(LlmCallPurpose::parse(&purpose.as_str()), Some(purpose));
        }
        for platform in CHAT_PLATFORMS {
            let gate = LlmCallPurpose::ThreadGate(platform);
            assert_eq!(gate.as_str(), format!("{}-thread-gate", platform.as_str()));
            assert_eq!(LlmCallPurpose::parse(&gate.as_str()), Some(gate));
        }
        assert_eq!(LlmCallPurpose::parse("nope"), None);
    }

    #[test]
    fn sorts_each_purpose_into_its_spend_kind() {
        assert_eq!(spend_kind_of("coding-agent"), SpendKind::CodingAgent);
        for purpose in ["voice-chat", "meeting", "dictation"] {
            assert_eq!(spend_kind_of(purpose), SpendKind::Voice);
        }
        assert_eq!(spend_kind_of("chat"), SpendKind::Main);
        assert_eq!(spend_kind_of("compaction"), SpendKind::Main);
    }

    #[test]
    #[serial_test::serial]
    fn writes_one_row_with_the_counts_the_cache_split_and_the_cost() {
        let mut call = input(LlmCallPurpose::Chat, Some(usage()));
        call.thread_id = Some("thread-1".to_string());
        let row = row(tokens_input(call));
        assert_eq!(row.agent_id, "test-agent-id");
        assert_eq!(row.subagent_id, None);
        assert_eq!(row.purpose, "chat");
        assert_eq!(row.model, "claude-opus-5");
        assert_eq!(row.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            (&row.request_id, &row.source_kind, &row.source_id),
            (&None, &None, &None)
        );
        assert_eq!(
            (
                row.total_tokens,
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens,
                row.no_cache_tokens,
                row.audio_input_tokens,
                row.audio_output_tokens,
            ),
            (1100, 1000, 100, 700, 100, 200, 0, 0)
        );
        // 200 × 5 + 700 × 0.5 + 100 × 6.25 + 100 × 25 millionths of a dollar.
        assert_eq!(row.cost_micro_usd, Some(4475));
        assert_eq!(row.cost_source.as_deref(), Some("catalog"));
        assert_eq!(row.created_at.0, now());
    }

    #[test]
    #[serial_test::serial]
    fn files_a_call_in_the_15_minute_bucket_it_was_made_in() {
        let at = Utc.timestamp_millis_opt(1_795_257_899_999).unwrap(); // 2026-11-21T10:44:59.999Z
        let call = tokens_input(input(LlmCallPurpose::Chat, Some(usage())));
        let row = call_row(&call, None, at, prices(&[]), CacheTtl::FiveMinutes).unwrap();
        assert_eq!(row.created_at.0, at);
        assert_eq!(
            row.bucket
                .0
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "2026-11-21T10:30:00.000Z"
        );
        assert_eq!(row.bucket.0.timestamp_millis() % BUCKET_MS, 0);
    }

    #[test]
    #[serial_test::serial]
    fn prices_the_cache_writes_of_a_chat_turn_at_the_one_hour_lifetime_when_chat_cache_ttl_asks_for_it()
     {
        let chat = tokens_input(input(LlmCallPurpose::Chat, Some(usage())));
        let compaction = tokens_input(input(LlmCallPurpose::Compaction, Some(usage())));
        let at = |call: &RecordTokensInput| {
            call_row(call, None, now(), prices(&[]), CacheTtl::OneHour)
                .unwrap()
                .cost_micro_usd
        };
        // The 100 written tokens cost 2 × 5 instead of 6.25 on the chat turn alone.
        assert_eq!(at(&chat), Some(4475 - 625 + 1000));
        assert_eq!(at(&compaction), Some(4475));
    }

    #[test]
    #[serial_test::serial]
    fn spends_a_call_on_the_request_and_thread_of_the_work_it_runs_in() {
        let spend = SpendContext {
            request_id: "message-1".into(),
            thread_id: Some("thread-1".into()),
            source: Some(SpendSource {
                kind: SpendSourceKind::Cron,
                id: Some("task-1".into()),
            }),
        };
        let gate = tokens_input(input(LlmCallPurpose::RiskGate, Some(usage())));
        let first = call_row(
            &gate,
            Some(spend.clone()),
            now(),
            prices(&[]),
            CacheTtl::FiveMinutes,
        )
        .unwrap();
        assert_eq!(
            (
                first.request_id.as_deref(),
                first.thread_id.as_deref(),
                first.source_kind.as_deref(),
                first.source_id.as_deref()
            ),
            (
                Some("message-1"),
                Some("thread-1"),
                Some("cron"),
                Some("task-1")
            )
        );

        let mut named = input(LlmCallPurpose::GoalGate, Some(usage()));
        named.thread_id = Some("thread-2".into());
        named.request_id = Some("goal-1".into());
        let second = call_row(
            &tokens_input(named),
            Some(spend),
            now(),
            prices(&[]),
            CacheTtl::FiveMinutes,
        )
        .unwrap();
        assert_eq!(
            (second.request_id.as_deref(), second.thread_id.as_deref()),
            (Some("goal-1"), Some("thread-2"))
        );
    }

    #[test]
    #[serial_test::serial]
    fn leaves_a_model_the_catalog_has_no_price_for_unpriced() {
        let mut call = input(LlmCallPurpose::Chat, Some(usage()));
        call.model = "operator-alias".into();
        let row = row(tokens_input(call));
        assert_eq!(
            (row.cost_micro_usd, row.cost_source, row.total_tokens),
            (None, None, 1100)
        );
    }

    #[test]
    #[serial_test::serial]
    fn bills_the_owner_and_records_which_subagent_ran_the_call() {
        let mut call = input(LlmCallPurpose::Subagent, Some(usage()));
        call.agent_id = Some("subagent-9".to_string());
        let row1 = row(tokens_input(call.clone()));
        assert_eq!(row1.agent_id, "test-agent-id");
        assert_eq!(row1.subagent_id.as_deref(), Some("subagent-9"));

        call.agent_id = Some("test-agent-id".to_string());
        assert_eq!(row(tokens_input(call)).subagent_id, None);
    }

    #[test]
    #[serial_test::serial]
    fn still_records_a_call_the_provider_reported_no_usage_for() {
        let mut call = input(LlmCallPurpose::Chat, None);
        call.model = "mystery-model".to_string();
        let row = row(tokens_input(call));
        assert_eq!(row.model, "mystery-model");
        assert_eq!((row.total_tokens, row.input_tokens), (0, 0));
    }

    #[test]
    #[serial_test::serial]
    fn costs_nothing_on_a_subscription() {
        let mut call = coding("claude-opus-5", tokens());
        call.subscription = true;
        call.reported_cost_usd = Some(0.2);
        let row = row(call);
        assert_eq!(
            (
                row.cost_micro_usd,
                row.cost_source.as_deref(),
                row.input_tokens
            ),
            (Some(0), Some("subscription"), 1000)
        );
    }

    #[test]
    #[serial_test::serial]
    fn takes_the_reported_cost_over_the_catalog_price_and_the_catalog_price_when_none_is_reported()
    {
        let mut unknown = coding("new-model", tokens());
        unknown.reported_cost_usd = Some(0.0123456);
        let mut known = coding("claude-opus-5", tokens());
        known.reported_cost_usd = Some(0.5);
        let plain = coding("claude-opus-5", tokens());

        let cost = |call| {
            let row = row(call);
            (row.cost_micro_usd, row.cost_source)
        };
        assert_eq!(cost(unknown), (Some(12346), Some("reported".into())));
        assert_eq!(cost(known), (Some(500_000), Some("reported".into())));
        assert_eq!(cost(plain), (Some(4475), Some("catalog".into())));
    }

    #[test]
    #[serial_test::serial]
    fn prices_a_multi_request_coding_agent_row_at_the_base_tier_not_from_its_summed_prompt() {
        // Ten requests of 30k prompt tokens each: no single prompt reaches the 100k
        // tier, so the 300k sum must not price the row there.
        let tiered = ModelPrice {
            tiers: Some(vec![PriceTier {
                above: 100_000.0,
                input: 10.0,
                output: 20.0,
                cache_read: None,
                cache_write: None,
            }]),
            ..price(1.0, 2.0)
        };
        let summed = CallTokens {
            total_tokens: 310_000,
            input_tokens: 300_000,
            output_tokens: 10_000,
            no_cache_tokens: 300_000,
            ..CallTokens::default()
        };
        let lookup = prices(&[("tiered", tiered)]);
        let at = |call: RecordTokensInput| {
            call_row(&call, None, now(), lookup.clone(), CacheTtl::FiveMinutes)
                .unwrap()
                .cost_micro_usd
        };
        assert_eq!(at(coding("tiered", summed)), Some(300_000 + 10_000 * 2));
        // One chat request with a 300k prompt is above the tier.
        assert_eq!(
            at(RecordTokensInput::new(
                LlmCallPurpose::Chat,
                "tiered",
                Some(summed)
            )),
            Some(300_000 * 10 + 10_000 * 20)
        );
    }

    #[test]
    #[serial_test::serial]
    fn prices_the_cache_writes_the_caller_marks_as_long_at_the_one_hour_lifetime() {
        let long = CallTokens {
            long_cache_write_tokens: Some(100),
            ..tokens()
        };
        assert_eq!(
            row(coding("claude-opus-5", long)).cost_micro_usd,
            Some(4475 - 625 + 1000)
        );
    }

    #[test]
    #[serial_test::serial]
    fn prices_audio_at_the_audio_rates() {
        let voice = ModelPrice {
            cache_read: Some(0.4),
            input_audio: Some(32.0),
            output_audio: Some(64.0),
            ..price(4.0, 24.0)
        };
        let call = RecordTokensInput::new(
            LlmCallPurpose::VoiceChat,
            "voice-model",
            Some(CallTokens {
                total_tokens: 1300,
                input_tokens: 1000,
                output_tokens: 300,
                cache_read_tokens: 200,
                cache_write_tokens: 0,
                no_cache_tokens: 800,
                long_cache_write_tokens: None,
                audio_input_tokens: Some(600),
                audio_output_tokens: Some(250),
            }),
        );
        let row = call_row(
            &call,
            None,
            now(),
            prices(&[("voice-model", voice)]),
            CacheTtl::FiveMinutes,
        )
        .unwrap();
        // 200 × 4 + 600 × 32 + 200 × 0.4 + 50 × 24 + 250 × 64.
        assert_eq!(
            (
                row.cost_micro_usd,
                row.audio_input_tokens,
                row.audio_output_tokens
            ),
            (Some(37280), 600, 250)
        );
    }

    /// The stored rows, once `count` have landed.
    async fn stored(count: usize) -> Vec<LlmCall> {
        let mut rows: Vec<LlmCall> = Vec::new();
        for _ in 0..100 {
            rows =
                crate::db::run(|conn| Ok(l::llm_calls.select(LlmCall::as_select()).load(conn)?))
                    .await
                    .unwrap();
            if rows.len() >= count {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        rows
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn records_calls_in_the_background_and_reads_the_newest_back() {
        let _db = test_db();
        crate::services::memory_store::tests::ensure_agent("test-agent-id");
        for purpose in [
            LlmCallPurpose::Heartbeat,
            LlmCallPurpose::Compaction,
            LlmCallPurpose::RiskGate,
        ] {
            LLM_CALL_SERVICE.record(input(purpose, Some(usage())));
        }
        let mut chat = input(LlmCallPurpose::Chat, Some(usage()));
        chat.thread_id = Some("thread-1".to_string());
        LLM_CALL_SERVICE.record(chat);

        let rows = stored(4).await;
        assert_eq!(rows.len(), 4);
        assert_eq!(rows.iter().filter(|r| r.thread_id.is_none()).count(), 3);
        for row in &rows {
            assert_eq!(row.bucket.timestamp_millis() % BUCKET_MS, 0);
            assert_eq!(
                row.bucket.timestamp_millis(),
                row.created_at.timestamp_millis() - row.created_at.timestamp_millis() % BUCKET_MS
            );
        }

        let newest = LLM_CALL_SERVICE
            .newest_thread_call(
                "thread-1",
                &[LlmCallPurpose::Chat, LlmCallPurpose::Compaction],
            )
            .await
            .unwrap();
        assert_eq!(
            (newest.purpose.as_str(), newest.model.as_str()),
            ("chat", "claude-opus-5")
        );
        assert!(
            LLM_CALL_SERVICE
                .newest_thread_call("thread-1", &[LlmCallPurpose::Compaction])
                .await
                .is_none()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn records_a_call_in_the_spend_context_it_runs_in() {
        let _db = test_db();
        crate::services::memory_store::tests::ensure_agent("test-agent-id");
        let spend = SpendContext {
            request_id: "message-1".into(),
            thread_id: Some("thread-1".into()),
            source: Some(SpendSource::of(SpendSourceKind::Chat)),
        };
        crate::lib::spend_context::with_spend_context(spend, async {
            LLM_CALL_SERVICE.record(input(LlmCallPurpose::RiskGate, Some(usage())));
        })
        .await;
        let rows = stored(1).await;
        assert_eq!(
            (
                rows[0].request_id.as_deref(),
                rows[0].thread_id.as_deref(),
                rows[0].source_kind.as_deref()
            ),
            (Some("message-1"), Some("thread-1"), Some("chat"))
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn prices_the_calls_whose_model_the_catalog_now_prices_and_leaves_the_rest() {
        let _db = test_db();
        crate::services::memory_store::tests::ensure_agent("test-agent-id");
        crate::lib::model_catalog::reset_model_catalog();
        let unpriced = |model: &str, total: i64| {
            let mut row = NewLlmCall::new("test-agent-id", "chat", model);
            row.total_tokens = total;
            row.input_tokens = total;
            row.no_cache_tokens = total;
            row
        };
        let rows = vec![
            unpriced("claude-haiku-5-5", 1000),
            unpriced("operator-alias", 1000),
            // No tokens reported: stays unpriced.
            unpriced("claude-haiku-5-5", 0),
        ];
        crate::db::run(move |conn| {
            diesel::insert_into(l::llm_calls)
                .values(&rows)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();

        LLM_CALL_SERVICE.price_unpriced_calls().await;

        let mut rows = stored(3).await;
        rows.sort_by_key(|r| (r.model.clone(), r.total_tokens));
        let costs: Vec<(String, i64, Option<String>)> = rows
            .iter()
            .map(|r| (r.model.clone(), r.total_tokens, r.cost_source.clone()))
            .collect();
        assert_eq!(
            costs,
            vec![
                ("claude-haiku-5-5".to_string(), 0, None),
                ("claude-haiku-5-5".to_string(), 1000, Some("catalog".into())),
                ("operator-alias".to_string(), 1000, None),
            ]
        );
        let haiku = price_for("claude-haiku-5-5").unwrap();
        assert_eq!(
            rows[1].cost_micro_usd,
            Some(js_round(1000.0 * haiku.input) as i64)
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn survives_a_failed_read_when_it_prices_the_unpriced_calls() {
        let _db = test_db();
        crate::db::run(|conn| {
            diesel::sql_query("DROP TABLE llm_calls").execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        LLM_CALL_SERVICE.price_unpriced_calls().await;
    }
}
