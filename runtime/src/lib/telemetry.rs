//! Product Telemetry via OpenTelemetry Logs
//!
//! Emits discrete analytics events (e.g. "message feedback") as OTEL Log Records.
//! Events are sent via OTLP/HTTP to an OTEL Collector. In production this is a
//! shared third-party endpoint (authenticated with `x-api-key`); locally and in
//! e2e it is a docker-compose otelcol container.
//!
//! Disabled (no-op) when OTEL_EXPORTER_OTLP_ENDPOINT is not set.

use crate::ai::TelemetryOptions;
use crate::config::CONFIG;
use crate::lib::langfuse::is_langfuse_enabled;
use crate::{log_debug, log_info};
use indexmap::IndexMap;
use serde_json::Value;
use std::sync::{Arc, LazyLock};

/// `deployment.environment.name` is a stable attribute name per the OTel spec.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME: &str = "deployment.environment.name";
/// Not an OTel semantic convention: the product that launched this agent, set by
/// that product's recipe. `service.*` stays the runtime's own name for every product.
const ATTR_PRODUCT_NAME: &str = "product.name";
const ATTR_SERVICE_NAME: &str = "service.name";
const ATTR_SERVICE_NAMESPACE: &str = "service.namespace";
const ATTR_SERVICE_VERSION: &str = "service.version";

/// The OTLP/HTTP log pipeline [`init_telemetry`] builds: the export URL
/// (`<endpoint>/v1/logs`), its headers, the resource attributes that describe the
/// emitter of every record, and the records a batch processor has not exported
/// yet. The instrumentation scope is `product-telemetry`.
struct OtelLogger {
    url: String,
    headers: IndexMap<String, String>,
    resource: IndexMap<String, String>,
    pending: parking_lot::Mutex<Vec<Value>>,
}

/// Set by [`init_telemetry`]; `None` while telemetry is off.
static OTEL_LOGGER: LazyLock<parking_lot::RwLock<Option<Arc<OtelLogger>>>> =
    LazyLock::new(|| parking_lot::RwLock::new(None));

pub fn is_telemetry_enabled() -> bool {
    !CONFIG.otel_endpoint.is_empty()
}

/// Builds the OTLP log pipeline when an endpoint is configured.
///
/// Resource attributes describe the *emitter* of every event on this stream:
/// `service.name` `prism-agent-runtime`, `service.namespace` `prism-agent`,
/// `deployment.environment.name`, and, when set, `service.version` (the deployed
/// build, so events can be broken down by version and regressions correlated to
/// specific releases) and `product.name` (separates the agents a product launched
/// from the others). `x-api-key` carries `otel_api_key` when set. Records go out
/// through a batch processor. Logs
/// `[Telemetry] Initialized → <endpoint> (env: <env>, version: <version or <unset>>)`.
pub fn init_telemetry() {
    if CONFIG.otel_endpoint.is_empty() {
        log_info!("[Telemetry] Not configured (no OTEL_EXPORTER_OTLP_ENDPOINT), skipping");
        return;
    }
    todo!()
}

/// Emit a product analytics event as an OTEL Log Record.
///
/// No-op when telemetry is not configured. The record has severity INFO, the
/// event as its body and event name, and the properties plus `event.id` (a UUIDv7)
/// and, when known, `user.id` as attributes.
pub fn track_event(
    event: &str,
    user_id: Option<&str>,
    properties: Option<IndexMap<String, String>>,
) {
    let Some(logger) = OTEL_LOGGER.read().clone() else {
        return;
    };

    // debug, not info — some events fire per message/invocation and would
    // otherwise dominate the application log.
    log_debug!(
        "[Telemetry] Tracking event: {} (user: {})",
        event,
        user_id.filter(|id| !id.is_empty()).unwrap_or("unknown")
    );
    todo!()
}

/// Flushes and closes the pipeline, then logs `[Telemetry] Shutdown complete`.
/// Does nothing when telemetry was never initialized.
pub async fn shutdown_telemetry() {
    todo!()
}

/// Options for [`langfuse_telemetry`].
#[derive(Debug, Clone, Copy, Default)]
pub struct LangfuseTelemetryOptions {
    /// `Some(false)` traces the call without its prompt or its completion.
    pub record_content: Option<bool>,
}

/// Tracing options for a `generate_text` or `generate_object` call: the
/// `runtime_context` and `experimental_telemetry` options of the call.
#[derive(Debug, Clone, Default)]
pub struct LangfuseTelemetry {
    pub runtime_context: Option<IndexMap<String, String>>,
    pub experimental_telemetry: Option<TelemetryOptions>,
}

/// Tracing options for an embedding call: its `experimental_telemetry` option.
#[derive(Debug, Clone, Default)]
pub struct LangfuseEmbedTelemetry {
    pub experimental_telemetry: Option<TelemetryOptions>,
}

/// Tracing options for a `generate_text` or `generate_object` call, routed to
/// Langfuse. Empty when Langfuse isn't configured, so call sites can apply it
/// unconditionally.
///
/// `record_content: Some(false)` traces the call without its prompt or its
/// completion — the timing, the model and the token counts still arrive, the words
/// do not. For a call whose input is somebody else's speech rather than the
/// operator's own data, which is why the meeting gate passes it. Langfuse is a
/// *stronger* disclosure than a log line, not a weaker one: it is a durable store
/// on another host, so a call the log deliberately does not record must not arrive
/// there either.
///
/// `identifiers` ride the SDK's runtime context, not a telemetry field. Each key
/// has to be opted in by name, and arrives as `ai.settings.context.<key>`.
///
/// An embedding call takes telemetry but no runtime context, so it has its own
/// [`langfuse_embed_telemetry`] rather than this one.
pub fn langfuse_telemetry(
    function_id: &str,
    identifiers: Option<IndexMap<String, String>>,
    options: Option<LangfuseTelemetryOptions>,
) -> LangfuseTelemetry {
    if !is_langfuse_enabled() {
        return LangfuseTelemetry::default();
    }
    let include_runtime_context = identifiers.as_ref().map(|identifiers| {
        identifiers
            .keys()
            .map(|key| (key.clone(), true))
            .collect::<IndexMap<String, bool>>()
    });
    let record_content = options.and_then(|options| options.record_content);
    let (record_inputs, record_outputs) = if record_content == Some(false) {
        (Some(false), Some(false))
    } else {
        (None, None)
    };
    LangfuseTelemetry {
        runtime_context: identifiers,
        experimental_telemetry: Some(TelemetryOptions {
            is_enabled: Some(true),
            function_id: Some(function_id.to_string()),
            include_runtime_context,
            record_inputs,
            record_outputs,
            ..Default::default()
        }),
    }
}

/// Tracing options for an embedding call (`embed`, `embed_many`), routed to
/// Langfuse. Same contract as [`langfuse_telemetry`] minus the identifiers, since
/// those two take telemetry but no runtime context.
pub fn langfuse_embed_telemetry(function_id: &str) -> LangfuseEmbedTelemetry {
    if !is_langfuse_enabled() {
        return LangfuseEmbedTelemetry::default();
    }
    LangfuseEmbedTelemetry {
        experimental_telemetry: Some(TelemetryOptions {
            is_enabled: Some(true),
            function_id: Some(function_id.to_string()),
            ..Default::default()
        }),
    }
}
