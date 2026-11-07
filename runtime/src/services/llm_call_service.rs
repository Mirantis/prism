//! Records what every model call cost: one row per call, written when the call
//! returns, so a suppressed heartbeat and a compaction are counted along with a
//! published turn. Writes are fire-and-forget and fail soft — an accounting
//! error costs a log line, and the turn that made the call carries on.

use std::borrow::Cow;
use std::fmt;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::json;

use crate::ai::LanguageModelUsage;
use crate::config::CONFIG;
use crate::db::models::NewLlmCall;
use crate::db::schema::llm_calls::dsl as l;
use crate::lib::log_redaction::err_json;
use crate::lib::step_usage::to_step_usage;
use crate::services::channel_adapter_interface::{CHAT_PLATFORMS, ChatPlatform};
use crate::{log_error, log_warn};

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
pub const LLM_CALL_PURPOSES: [LlmCallPurpose; 13] = [
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
];

/// One model call to record.
#[derive(Debug, Clone)]
pub struct RecordInput {
    pub purpose: LlmCallPurpose,
    /// The model id the call went to.
    pub model: String,
    /// What the provider reported. `None` is still recorded, as a row with zero
    /// counts: the call happened, and its cost was not reported.
    pub usage: Option<LanguageModelUsage>,
    /// The thread this call belongs to, where it has one.
    pub thread_id: Option<String>,
    /// The agent the call ran for. Omit for the runtime's own work; pass the
    /// invoked agent where a turn may belong to a subagent, and the row records it
    /// as provenance while the spend still lands on the owner.
    pub agent_id: Option<String>,
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

    /// Record one model call.
    ///
    /// Returns immediately: the insert runs in the background so no call site
    /// waits on it.
    ///
    /// A call the provider reported no usage for still gets a row, with zero
    /// counts. The count of rows is what the page calls "model calls", so dropping
    /// one would undercount the calls to keep the tokens tidy — and zero tokens is
    /// the honest record of a call whose cost the provider did not report.
    pub fn record(&self, input: RecordInput) {
        // The owner pays, whoever ran the call. Filtering reads on this one column
        // keeps a past window's total from moving when a subagent link changes.
        let Some(row) = call_row(&input) else {
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
}

/// The row `record` writes, or `None` when there is no agent to attribute the
/// spend to.
fn call_row(input: &RecordInput) -> Option<NewLlmCall> {
    let owner = CONFIG.agent_id().filter(|id| !id.is_empty())?;
    let usage = to_step_usage(&input.model, input.usage.as_ref());
    let ran_for = input
        .agent_id
        .as_ref()
        .filter(|id| !id.is_empty() && **id != owner)
        .cloned();

    let mut row = NewLlmCall::new(
        owner,
        input.purpose.as_str().into_owned(),
        usage
            .as_ref()
            .map(|u| u.model.clone())
            .unwrap_or_else(|| input.model.clone()),
    );
    row.subagent_id = ran_for;
    row.thread_id = input.thread_id.clone();
    if let Some(usage) = usage {
        row.total_tokens = usage.total_tokens;
        row.input_tokens = usage.input_tokens;
        row.output_tokens = usage.output_tokens;
        row.cache_read_tokens = usage.cache_read_tokens;
        row.cache_write_tokens = usage.cache_write_tokens;
        row.no_cache_tokens = usage.no_cache_tokens;
    }
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
            agent_id: None,
        }
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
    fn the_row_holds_the_counts_and_the_cache_split() {
        let mut call = input(LlmCallPurpose::Chat, Some(usage()));
        call.thread_id = Some("thread-1".to_string());
        let row = call_row(&call).unwrap();
        assert_eq!(row.agent_id, "test-agent-id");
        assert_eq!(row.subagent_id, None);
        assert_eq!(row.purpose, "chat");
        assert_eq!(row.model, "claude-opus-5");
        assert_eq!(row.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            (
                row.total_tokens,
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens,
                row.no_cache_tokens
            ),
            (1100, 1000, 100, 700, 100, 200)
        );
    }

    #[test]
    fn bills_the_owner_and_records_which_subagent_ran_the_call() {
        let mut call = input(LlmCallPurpose::Subagent, Some(usage()));
        call.agent_id = Some("subagent-9".to_string());
        let row = call_row(&call).unwrap();
        assert_eq!(row.agent_id, "test-agent-id");
        assert_eq!(row.subagent_id.as_deref(), Some("subagent-9"));

        call.agent_id = Some("test-agent-id".to_string());
        assert_eq!(call_row(&call).unwrap().subagent_id, None);
    }

    #[test]
    fn still_records_a_call_the_provider_reported_no_usage_for() {
        let mut call = input(LlmCallPurpose::Chat, None);
        call.model = "mystery-model".to_string();
        let row = call_row(&call).unwrap();
        assert_eq!(row.model, "mystery-model");
        assert_eq!((row.total_tokens, row.input_tokens), (0, 0));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn records_calls_in_the_background_and_reads_the_newest_back() {
        let _db = test_db();
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

        let mut rows: Vec<LlmCall> = Vec::new();
        for _ in 0..100 {
            rows =
                crate::db::run(|conn| Ok(l::llm_calls.select(LlmCall::as_select()).load(conn)?))
                    .await
                    .unwrap();
            if rows.len() == 4 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(rows.len(), 4);
        assert_eq!(rows.iter().filter(|r| r.thread_id.is_none()).count(), 3);

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
}
