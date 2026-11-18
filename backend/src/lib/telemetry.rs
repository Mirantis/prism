//! Product Telemetry via OpenTelemetry Logs
//!
//! Emits discrete analytics events (e.g. "message feedback") as OTEL Log Records.
//! Events are sent via OTLP/HTTP to an OTEL Collector. In production this is a
//! shared third-party endpoint (authenticated with `x-api-key`); locally and in
//! e2e it is a docker-compose otelcol container.
//!
//! Disabled (no-op) when OTEL_EXPORTER_OTLP_ENDPOINT is not set.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use bytes::Bytes;
use indexmap::IndexMap;
use opentelemetry::KeyValue;
use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _, Severity};
use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::logs::{LogBatch, LogExporter, SdkLogger, SdkLoggerProvider};

use crate::ai::TelemetryOptions;
use crate::config::{CONFIG, Config};
use crate::lib::langfuse::is_langfuse_enabled;
use crate::lib::local_owner::LOCAL_OWNER_USER_ID;
use crate::{log_debug, log_info};

/// `deployment.environment.name` is a stable attribute name per the OTel spec.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME: &str = "deployment.environment.name";
/// Not an OTel semantic convention: the product that launched this agent, set by
/// that product's recipe. `service.*` stays the runtime's own name for every product.
const ATTR_PRODUCT_NAME: &str = "product.name";
/// The persisted id of this install, the attribute name Mirantis Agent Platform uses for its own.
const ATTR_DEPLOYMENT_ID: &str = "deployment.id";
const ATTR_SERVICE_NAME: &str = "service.name";
const ATTR_SERVICE_NAMESPACE: &str = "service.namespace";
const ATTR_SERVICE_VERSION: &str = "service.version";

/// The instrumentation scope every product event is emitted under.
const SCOPE_NAME: &str = "product-telemetry";

/// The OTLP exporter's request timeout, its default.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// The log pipeline [`init_telemetry`] builds.
struct Pipeline {
    provider: SdkLoggerProvider,
    logger: SdkLogger,
}

/// Set by [`init_telemetry`]; `None` while telemetry is off and after shutdown.
static PIPELINE: LazyLock<parking_lot::RwLock<Option<Arc<Pipeline>>>> =
    LazyLock::new(|| parking_lot::RwLock::new(None));

/// The batch processor reports no export result to its caller, so the exporter
/// counts them for [`flush_telemetry`].
static EXPORTS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
static FAILED_EXPORTS: AtomicUsize = AtomicUsize::new(0);

/// The OTLP exporter, counting the exports running and the exports that failed.
#[derive(Debug)]
struct CountingExporter<E>(E);

impl<E: LogExporter> LogExporter for CountingExporter<E> {
    async fn export(&self, batch: LogBatch<'_>) -> OTelSdkResult {
        EXPORTS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        let result = self.0.export(batch).await;
        EXPORTS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        if result.is_err() {
            FAILED_EXPORTS.fetch_add(1, Ordering::SeqCst);
        }
        result
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.0.shutdown_with_timeout(timeout)
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.0.set_resource(resource);
    }
}

// ---------------------------------------------------------------------------
// The HTTP client both OTLP pipelines export through
// ---------------------------------------------------------------------------

/// The runtime the OTLP exports run on. The SDK's batch processors export from a
/// thread of their own, outside any async runtime, and the HTTP client needs one.
/// A runtime of its own keeps an export independent of the main runtime's
/// shutdown.
static EXPORT_RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("otlp-export")
        .enable_all()
        .build()
        .expect("the OTLP export runtime starts")
});

/// Runs `future` on the runtime the OTLP exports use.
pub(crate) fn spawn_export<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    EXPORT_RUNTIME.spawn(future)
}

/// The OTLP exporters' HTTP client: each request runs on [`EXPORT_RUNTIME`]. No
/// proxy, as Node's `http` module uses none.
#[derive(Debug, Clone)]
pub(crate) struct OtlpHttpClient {
    client: reqwest::Client,
}

impl OtlpHttpClient {
    pub(crate) fn new(timeout: Duration) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(timeout)
            .build()?;
        Ok(Self { client })
    }
}

#[async_trait]
impl opentelemetry_http::HttpClient for OtlpHttpClient {
    async fn send_bytes(
        &self,
        request: http::Request<Bytes>,
    ) -> Result<http::Response<Bytes>, opentelemetry_http::HttpError> {
        let client = self.client.clone();
        let task = EXPORT_RUNTIME.spawn(async move {
            let (parts, body) = request.into_parts();
            let response = client
                .request(parts.method, parts.uri.to_string())
                .headers(parts.headers)
                .body(body)
                .send()
                .await?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = response.bytes().await?;
            let mut out = http::Response::builder().status(status).body(body)?;
            *out.headers_mut() = headers;
            Ok::<_, opentelemetry_http::HttpError>(out)
        });
        task.await
            .map_err(|err| Box::new(err) as opentelemetry_http::HttpError)?
    }
}

/// Event names as the SDK stores them, which is `&'static str`. Each distinct
/// name is leaked once; the names come from a fixed set in the code.
fn interned_event_name(event: &str) -> &'static str {
    static NAMES: LazyLock<parking_lot::Mutex<HashMap<String, &'static str>>> =
        LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));
    let mut names = NAMES.lock();
    if let Some(name) = names.get(event) {
        return name;
    }
    let name: &'static str = Box::leak(event.to_string().into_boxed_str());
    names.insert(event.to_string(), name);
    name
}

// ---------------------------------------------------------------------------
// Product telemetry
// ---------------------------------------------------------------------------

pub fn is_telemetry_enabled() -> bool {
    !CONFIG.otel_endpoint.is_empty()
}

/// Whether the selected vendor's gateway chat mount is set: `nexus` or `direct`.
/// This is the deployment's shape, not where a request lands: an explicit
/// `*_BASE_URL` can point off the gateway host, and the `[Startup] LLM provider`
/// log reports that endpoint and its source.
pub fn llm_routing() -> &'static str {
    llm_routing_for(&CONFIG)
}

/// [`llm_routing`] for `config`.
pub fn llm_routing_for(config: &Config) -> &'static str {
    if config
        .nexus_chat_base_url
        .as_deref()
        .is_some_and(|url| !url.is_empty())
    {
        "nexus"
    } else {
        "direct"
    }
}

/// Resource attributes describe the *emitter* of every event on this stream.
/// `service.version` identifies the deployed build so events can be broken down
/// by version and regressions correlated to specific releases. `product.name`
/// separates the agents a product launched from the others. `deployment.id`
/// separates one install from another and stays the same across restarts.
fn resource_attributes(
    config: &Config,
    deployment_id: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut attributes = Vec::new();
    if let Some(id) = deployment_id {
        attributes.push((ATTR_DEPLOYMENT_ID, id.to_string()));
    }
    attributes.extend([
        (ATTR_SERVICE_NAME, "prism-agent-runtime".to_string()),
        (ATTR_SERVICE_NAMESPACE, "prism-agent".to_string()),
        (
            ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
            config.deployment_environment.clone(),
        ),
    ]);
    if !config.service_version.is_empty() {
        attributes.push((ATTR_SERVICE_VERSION, config.service_version.clone()));
    }
    if !config.product_name.is_empty() {
        attributes.push((ATTR_PRODUCT_NAME, config.product_name.clone()));
    }
    attributes
}

/// The pipeline for `config`: OTLP/HTTP JSON to `<endpoint>/v1/logs`, with
/// `x-api-key` when an API key is set, through a batch processor.
fn build_pipeline(config: &Config, deployment_id: Option<&str>) -> anyhow::Result<Pipeline> {
    let resource = Resource::builder_empty()
        .with_attributes(
            resource_attributes(config, deployment_id)
                .into_iter()
                .map(|(key, value)| KeyValue::new(key, value)),
        )
        .build();

    let mut headers = HashMap::new();
    if !config.otel_api_key.is_empty() {
        headers.insert("x-api-key".to_string(), config.otel_api_key.clone());
    }

    let mut builder = opentelemetry_otlp::LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpJson)
        .with_endpoint(format!("{}/v1/logs", config.otel_endpoint))
        .with_timeout(EXPORT_TIMEOUT)
        .with_http_client(OtlpHttpClient::new(EXPORT_TIMEOUT)?);
    if !headers.is_empty() {
        builder = builder.with_headers(headers);
    }
    let exporter = CountingExporter(builder.build()?);

    let provider = SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(exporter)
        .build();
    let logger = provider.logger(SCOPE_NAME);
    Ok(Pipeline { provider, logger })
}

/// Builds the OTLP log pipeline when an endpoint is configured. `deployment_id` is
/// awaited only then, so a runtime without telemetry stores no id; the pipeline
/// is built once it answers, so the first batch carries it.
pub async fn init_telemetry<F>(deployment_id: impl FnOnce() -> F)
where
    F: std::future::Future<Output = Option<String>>,
{
    if CONFIG.otel_endpoint.is_empty() {
        log_info!("[Telemetry] Not configured (no OTEL_EXPORTER_OTLP_ENDPOINT), skipping");
        return;
    }

    let deployment_id = deployment_id().await;
    let pipeline = match build_pipeline(&CONFIG, deployment_id.as_deref()) {
        Ok(pipeline) => pipeline,
        Err(err) => {
            crate::log_error!(
                serde_json::json!({ "err": crate::lib::log_redaction::err_json(&err) }),
                "[Telemetry] Initialization failed"
            );
            return;
        }
    };
    *PIPELINE.write() = Some(Arc::new(pipeline));

    let version = if CONFIG.service_version.is_empty() {
        "<unset>"
    } else {
        CONFIG.service_version.as_str()
    };
    log_info!(
        "[Telemetry] Initialized → {} (env: {}, version: {})",
        CONFIG.otel_endpoint,
        CONFIG.deployment_environment,
        version
    );
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
    let Some(pipeline) = PIPELINE.read().clone() else {
        return;
    };

    // debug, not info — some events fire per message/invocation and would
    // otherwise dominate the application log.
    log_debug!(
        "[Telemetry] Tracking event: {} (user: {})",
        event,
        user_id.filter(|id| !id.is_empty()).unwrap_or("unknown")
    );

    emit(&pipeline.logger, event, user_id, properties);
}

/// A record's attributes: the properties, then `event.id`, then `user.id` when
/// the user is known. The local-owner placeholder sends no `user.id`, since
/// `deployment.id` identifies the install.
fn record_attributes(
    user_id: Option<&str>,
    properties: Option<IndexMap<String, String>>,
) -> IndexMap<String, String> {
    let mut attributes = properties.unwrap_or_default();
    attributes.insert("event.id".to_string(), uuid::Uuid::now_v7().to_string());
    if let Some(user_id) = user_id.filter(|id| !id.is_empty() && *id != LOCAL_OWNER_USER_ID) {
        attributes.insert("user.id".to_string(), user_id.to_string());
    }
    attributes
}

fn emit(
    logger: &SdkLogger,
    event: &str,
    user_id: Option<&str>,
    properties: Option<IndexMap<String, String>>,
) {
    let attributes = record_attributes(user_id, properties);
    let now = SystemTime::now();
    let mut record = logger.create_log_record();
    record.set_timestamp(now);
    record.set_observed_timestamp(now);
    record.set_severity_number(Severity::Info);
    record.set_severity_text("INFO");
    record.set_body(AnyValue::from(event.to_string()));
    record.set_event_name(interned_event_name(event));
    record.add_attributes(
        attributes
            .into_iter()
            .map(|(key, value)| (key, AnyValue::from(value))),
    );
    logger.emit(record);
}

/// Export every buffered record now. Answers true when the collector accepted
/// them: no export failed during the flush and none is still running. Answers
/// false when telemetry is off or has shut down, since a record emitted then is
/// dropped. A false answer can also come from another event's failed export.
pub async fn flush_telemetry() -> bool {
    let Some(pipeline) = PIPELINE.read().clone() else {
        return false;
    };
    let failed_before = FAILED_EXPORTS.load(Ordering::SeqCst);
    let flushing = Arc::clone(&pipeline);
    let _ = tokio::task::spawn_blocking(move || flushing.provider.force_flush()).await;
    PIPELINE.read().is_some()
        && FAILED_EXPORTS.load(Ordering::SeqCst) == failed_before
        && EXPORTS_IN_FLIGHT.load(Ordering::SeqCst) == 0
}

/// Flushes and closes the pipeline, then logs `[Telemetry] Shutdown complete`.
/// Does nothing when telemetry was never initialized. Events tracked from here
/// on are dropped.
pub async fn shutdown_telemetry() {
    let Some(pipeline) = PIPELINE.write().take() else {
        return;
    };
    let shutdown = tokio::task::spawn_blocking(move || pipeline.provider.shutdown()).await;
    if matches!(shutdown, Ok(Ok(()))) {
        log_info!("[Telemetry] Shutdown complete");
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Env;
    use serde_json::Value;

    fn config_with(pairs: &[(&str, &str)]) -> Config {
        let env: Env = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::load(&env, &mut |_, _| {}).expect("config loads")
    }

    #[tokio::test]
    async fn track_event_is_a_no_op_when_not_configured() {
        // The test configuration has no OTEL endpoint, so the id is never read.
        async fn unread() -> Option<String> {
            panic!("the deployment id is read")
        }
        init_telemetry(unread).await;
        assert!(!is_telemetry_enabled());
        track_event("message feedback", Some("user-123"), None);
        track_event("message feedback", None, None);
        assert!(PIPELINE.read().is_none());
        assert!(!flush_telemetry().await);
    }

    #[test]
    fn puts_the_deployment_id_first_on_the_resource_when_known() {
        let config = config_with(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://example.test")]);
        let attributes = resource_attributes(&config, Some("deploy-1"));
        assert_eq!(attributes[0], ("deployment.id", "deploy-1".to_string()));
        assert!(
            !resource_attributes(&config, None)
                .iter()
                .any(|(k, _)| *k == "deployment.id")
        );
    }

    #[test]
    fn reports_routing_by_whether_the_gateway_mount_is_set() {
        let direct = config_with(&[]);
        assert_eq!(llm_routing_for(&direct), "direct");
        let nexus = config_with(&[("NEXUS_API_URL", "https://nexus.example.test")]);
        assert_eq!(llm_routing_for(&nexus), "nexus");
    }

    #[tokio::test]
    async fn shutdown_resolves_when_never_initialized() {
        shutdown_telemetry().await;
    }

    #[test]
    fn attaches_the_service_environment_version_and_product_to_the_resource() {
        let config = config_with(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://example.test"),
            ("DEPLOYMENT_ENVIRONMENT", "staging"),
            ("SERVICE_VERSION", "v2026.6.18060952"),
            ("PRODUCT_NAME", "example-product"),
        ]);
        assert_eq!(
            resource_attributes(&config, None),
            vec![
                ("service.name", "prism-agent-runtime".to_string()),
                ("service.namespace", "prism-agent".to_string()),
                ("deployment.environment.name", "staging".to_string()),
                ("service.version", "v2026.6.18060952".to_string()),
                ("product.name", "example-product".to_string()),
            ]
        );
    }

    #[test]
    fn omits_service_version_and_product_name_when_not_configured() {
        let config = config_with(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://example.test")]);
        let attributes = resource_attributes(&config, None);
        assert!(!attributes.iter().any(|(k, _)| *k == "service.version"));
        assert!(!attributes.iter().any(|(k, _)| *k == "product.name"));
        assert!(attributes.contains(&("service.name", "prism-agent-runtime".to_string())));
        assert!(attributes.contains(&("deployment.environment.name", "development".to_string())));
    }

    /// A collector that answers 200 to each POST and keeps the request.
    async fn collector() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let app = axum::Router::new().route(
            "/v1/logs",
            axum::routing::post(
                move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                    let tx = tx.clone();
                    async move {
                        let key = headers
                            .get("x-api-key")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_string();
                        let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let _ = tx.send((key, json));
                        "{}"
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exports_an_event_as_an_otlp_json_log_record() {
        let (endpoint, mut rx) = collector().await;
        let config = config_with(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint),
            ("OTEL_EXPORTER_OTLP_API_KEY", "key-1"),
            ("DEPLOYMENT_ENVIRONMENT", "staging"),
        ]);
        let pipeline = build_pipeline(&config, Some("deploy-1")).unwrap();
        let mut props = IndexMap::new();
        props.insert("feedback.rating".to_string(), "up".to_string());
        emit(
            &pipeline.logger,
            "message feedback",
            Some("user-123"),
            Some(props),
        );
        tokio::task::spawn_blocking(move || pipeline.provider.shutdown())
            .await
            .unwrap()
            .unwrap();

        let (api_key, body) = rx.recv().await.expect("one export");
        assert_eq!(api_key, "key-1");
        let resource_logs = &body["resourceLogs"][0];
        let resource: HashMap<String, Value> = resource_logs["resource"]["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| (a["key"].as_str().unwrap().to_string(), a["value"].clone()))
            .collect();
        assert_eq!(
            resource["service.name"],
            serde_json::json!({ "stringValue": "prism-agent-runtime" })
        );
        assert_eq!(
            resource["deployment.environment.name"],
            serde_json::json!({ "stringValue": "staging" })
        );
        assert_eq!(
            resource["deployment.id"],
            serde_json::json!({ "stringValue": "deploy-1" })
        );
        let scope_logs = &resource_logs["scopeLogs"][0];
        assert_eq!(scope_logs["scope"]["name"], "product-telemetry");
        let record = &scope_logs["logRecords"][0];
        assert_eq!(record["eventName"], "message feedback");
        assert_eq!(
            record["body"],
            serde_json::json!({ "stringValue": "message feedback" })
        );
        assert_eq!(record["severityNumber"], 9);
        assert_eq!(record["severityText"], "INFO");
        let keys: Vec<&str> = record["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["key"].as_str().unwrap())
            .collect();
        assert_eq!(keys, vec!["feedback.rating", "event.id", "user.id"]);
        assert_eq!(
            record["attributes"][2]["value"],
            serde_json::json!({ "stringValue": "user-123" })
        );
    }

    #[test]
    fn omits_user_id_when_unknown() {
        for user in [None, Some(""), Some(LOCAL_OWNER_USER_ID)] {
            let attributes = record_attributes(user, None);
            let keys: Vec<&str> = attributes.keys().map(String::as_str).collect();
            assert_eq!(keys, vec!["event.id"]);
        }
    }

    #[test]
    fn event_ids_are_uuid_v7() {
        let attributes = record_attributes(Some("user-1"), None);
        let id = uuid::Uuid::parse_str(&attributes["event.id"]).unwrap();
        assert_eq!(id.get_version_num(), 7);
    }

    #[test]
    fn interns_each_event_name_once() {
        let a = interned_event_name("update available");
        let b = interned_event_name(&String::from("update available"));
        assert!(std::ptr::eq(a, b));
    }

    #[test]
    fn langfuse_options_are_empty_while_langfuse_is_off() {
        let options = langfuse_telemetry("probe", None, None);
        assert!(options.runtime_context.is_none());
        assert!(options.experimental_telemetry.is_none());
        assert!(
            langfuse_embed_telemetry("probe")
                .experimental_telemetry
                .is_none()
        );
    }
}
