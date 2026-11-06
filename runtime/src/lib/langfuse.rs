//! Langfuse LLM Observability
//!
//! Sets up OpenTelemetry with a Langfuse span exporter to capture all
//! `generate_text()` calls (chat, heartbeat, cron, classification gate).
//!
//! Disabled when LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are not set.
//!
//! The model-call layer emits no span on its own. It calls whatever telemetry
//! integration is registered. The one registered here writes the AI SDK's legacy
//! span shape: `ai.generateText` / `ai.generateText.doGenerate` under
//! instrumentation scope `ai`, with the prompt in `ai.prompt` and
//! `ai.prompt.messages`, which is what Langfuse reads media out of. Spans under
//! the GenAI names would arrive in Langfuse without their prompts.
//!
//! Registering only when the keys are set keeps the cost where it belongs: with
//! no integration registered, a call carrying telemetry options produces no span
//! at all, so an unconfigured deployment builds nothing.

use parking_lot::Mutex;

/// The running exporter: what `init_langfuse` started and `shutdown_langfuse` flushes.
#[derive(Debug, Clone)]
struct LangfuseSdk {
    secret_key: String,
    public_key: String,
    base_url: String,
}

static SDK: Mutex<Option<LangfuseSdk>> = Mutex::new(None);

/// Start the exporter and register the telemetry integration, when both keys are
/// set. Logs `[Langfuse] Not configured (no keys), skipping` otherwise, and
/// `[Langfuse] Initialized → <base url>` once started.
pub fn init_langfuse() {
    todo!()
}

pub fn is_langfuse_enabled() -> bool {
    SDK.lock().is_some()
}

/// Flush and stop the exporter, logging `[Langfuse] Shutdown complete`. Does
/// nothing when it never started.
pub async fn shutdown_langfuse() {
    todo!()
}
