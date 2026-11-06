//! Records what every model call cost: one row per call, written when the call
//! returns, so a suppressed heartbeat and a compaction are counted along with a
//! published turn. Writes are fire-and-forget and fail soft — an accounting
//! error costs a log line, and the turn that made the call carries on.

use std::borrow::Cow;
use std::fmt;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::ai::LanguageModelUsage;
use crate::services::channel_adapter_interface::{CHAT_PLATFORMS, ChatPlatform};

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
        todo!()
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
        todo!()
    }
}

impl Default for LlmCallService {
    fn default() -> Self {
        Self::new()
    }
}

pub static LLM_CALL_SERVICE: LazyLock<LlmCallService> = LazyLock::new(LlmCallService::new);
