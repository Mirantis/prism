//! The one way this runtime calls a model. Every call goes through `call_model` or
//! `call_model_for_object`, which record what it cost in `llm_calls` before handing
//! the result back, so accounting is a property of the seam rather than something
//! each call site has to remember.

use crate::ai::{
    GenerateObjectOptions, GenerateObjectResult, GenerateTextOptions, GenerateTextResult,
};
use crate::lib::inference_gate::INFERENCE_GATE;
use crate::services::llm_call_service::{LLM_CALL_SERVICE, LlmCallPurpose};

/// What a model call is for, recorded on its `llm_calls` rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCallMeta {
    pub purpose: LlmCallPurpose,
    /// The thread this call belongs to, where it has one.
    pub thread_id: Option<String>,
    /// The subagent the call ran for, where it was not the owner's own work.
    pub agent_id: Option<String>,
}

impl ModelCallMeta {
    /// A call for `purpose` with no thread and no subagent.
    pub fn new(purpose: LlmCallPurpose) -> Self {
        Self {
            purpose,
            thread_id: None,
            agent_id: None,
        }
    }
}

/// `generate_text`, with one `llm_calls` row per completed step.
///
/// Recording rides `on_step_finish` so a multi-step turn is counted step by step,
/// as the provider bills it, and a turn that dies part-way keeps the steps it
/// finished. A caller's own `on_step_finish` runs after the row is written
/// (`LLM_CALL_SERVICE.record({ ...meta, model, usage: step.usage })`, where `model`
/// is the id of `params.model`).
///
/// The gate a secure takeover of the computer holds is asked before every step,
/// not only before the call: one `generate_text` runs a whole tool loop, so a
/// takeover that opens mid-turn has to stop the next step rather than the next
/// turn. A password is then typed with nothing running that could decide to look
/// at it. Each step waits on the gate, runs the caller's own `prepare_step`, and
/// waits on the gate again, since the caller's hook awaits work of its own — the
/// steering drain reads the database — so a window that opened while it ran is
/// still ahead of this step.
pub async fn call_model(
    meta: ModelCallMeta,
    params: GenerateTextOptions,
) -> anyhow::Result<GenerateTextResult> {
    todo!()
}

/// `generate_object`, with one `llm_calls` row for the call.
///
/// Structured output is a single request, so there is one row. A schema the model
/// failed to satisfy still spends the tokens it generated, and the SDK hands them
/// back on the error (`NoObjectGeneratedError.usage`), so that row is written too
/// before the error is returned.
pub async fn call_model_for_object(
    meta: ModelCallMeta,
    params: GenerateObjectOptions,
) -> anyhow::Result<GenerateObjectResult> {
    todo!()
}
