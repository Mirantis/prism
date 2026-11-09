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

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use indexmap::IndexMap;
use opentelemetry::trace::{
    Span as _, SpanId, Status, TraceContextExt, Tracer as _, TracerProvider as _,
};
use opentelemetry::{Array, Context, KeyValue, StringValue, Value as OtelValue};
use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{
    BatchConfigBuilder, BatchSpanProcessor, SdkTracer, SdkTracerProvider, Span as SdkSpan,
    SpanData, SpanProcessor,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::ai::generate_text::{ContentPart, StepResult, ToolErrorValue, ToolOutput};
use crate::ai::json::{js_stringify, to_js_json};
use crate::ai::provider::{FinishReason, Headers, JsonObject, LanguageModelV4Prompt};
use crate::ai::telemetry::{
    EmbedEndEvent, EmbedStartEvent, EmbeddingModelCallEndEvent, EmbeddingModelCallStartEvent,
    GenerateObjectEndEvent, GenerateObjectStartEvent, GenerateObjectStepEndEvent,
    GenerateObjectStepStartEvent, GenerateTextEndEvent, GenerateTextStartEvent,
    GenerateTextStepStartEvent, OperationEndEvent, OperationStartEvent, ToolExecutionEndEvent,
    ToolExecutionStartEvent,
};
use crate::ai::usage::LanguageModelUsage;
use crate::ai::{Telemetry, TelemetryMeta, register_telemetry};
use crate::config::CONFIG;
use crate::lib::telemetry::{OtlpHttpClient, spawn_export};
use crate::{log_debug, log_error, log_info};

/// The Langfuse SDK the TypeScript runtime ran, as its requests name it.
const LANGFUSE_SDK_NAME: &str = "javascript";
const LANGFUSE_SDK_VERSION: &str = "5.13.1";
/// The span exporter's request timeout when `LANGFUSE_TIMEOUT` is unset, in seconds.
const DEFAULT_TIMEOUT_SECONDS: f64 = 5.0;
/// The media API's request timeout.
const MEDIA_API_TIMEOUT: Duration = Duration::from_secs(60);
/// Upload retries after the first try, and the first backoff.
const MEDIA_UPLOAD_RETRIES: u32 = 3;
const MEDIA_UPLOAD_BASE_DELAY_MS: u64 = 1_000;

/// The running exporter: what `init_langfuse` started and `shutdown_langfuse` flushes.
struct LangfuseSdk {
    provider: SdkTracerProvider,
    media: Option<Arc<MediaService>>,
}

static SDK: Mutex<Option<Arc<LangfuseSdk>>> = Mutex::new(None);

/// Start the exporter and register the telemetry integration, when both keys are
/// set.
pub fn init_langfuse() {
    let secret_key = CONFIG
        .langfuse_secret_key
        .as_deref()
        .filter(|k| !k.is_empty());
    let public_key = CONFIG
        .langfuse_public_key
        .as_deref()
        .filter(|k| !k.is_empty());
    let (Some(secret_key), Some(public_key)) = (secret_key, public_key) else {
        log_info!("[Langfuse] Not configured (no keys), skipping");
        return;
    };

    let settings = ProcessorSettings::from_env();
    let (sdk, tracer) = match build_sdk(secret_key, public_key, &CONFIG.langfuse_base_url, settings)
    {
        Ok(built) => built,
        Err(err) => {
            log_error!(
                json!({ "err": crate::lib::log_redaction::err_json(&err) }),
                "[Langfuse] Initialization failed"
            );
            return;
        }
    };
    *SDK.lock() = Some(Arc::new(sdk));
    register_telemetry(Arc::new(LegacyOpenTelemetry::new(tracer)));
    log_info!("[Langfuse] Initialized → {}", CONFIG.langfuse_base_url);
}

pub fn is_langfuse_enabled() -> bool {
    SDK.lock().is_some()
}

/// Flush and stop the exporter, logging `[Langfuse] Shutdown complete`. Does
/// nothing when it never started.
pub async fn shutdown_langfuse() {
    let Some(sdk) = SDK.lock().clone() else {
        return;
    };
    if let Some(media) = &sdk.media {
        media.flush().await;
    }
    let provider = sdk.provider.clone();
    let shutdown = tokio::task::spawn_blocking(move || provider.shutdown()).await;
    if matches!(shutdown, Ok(Ok(()))) {
        log_info!("[Langfuse] Shutdown complete");
    }
}

// ---------------------------------------------------------------------------
// The span pipeline
// ---------------------------------------------------------------------------

/// What the Langfuse span processor reads from its own environment variables.
#[derive(Debug, Clone, Default)]
struct ProcessorSettings {
    /// `LANGFUSE_TRACING_ENVIRONMENT`, set on every span as `langfuse.environment`.
    environment: Option<String>,
    /// `LANGFUSE_RELEASE`, set on every span as `langfuse.release`.
    release: Option<String>,
    /// `LANGFUSE_FLUSH_AT`: the export batch size.
    flush_at: Option<usize>,
    /// `LANGFUSE_FLUSH_INTERVAL`, in seconds: the export delay.
    flush_interval: Option<f64>,
    /// `LANGFUSE_TIMEOUT`, in seconds.
    timeout_seconds: Option<f64>,
    /// `LANGFUSE_MEDIA_UPLOAD_ENABLED`: `false` or `0` keeps inline media inline.
    media_upload_enabled: bool,
}

impl ProcessorSettings {
    fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self {
            environment: var("LANGFUSE_TRACING_ENVIRONMENT"),
            release: var("LANGFUSE_RELEASE"),
            flush_at: var("LANGFUSE_FLUSH_AT")
                .and_then(|v| v.trim().parse::<usize>().ok())
                .filter(|n| *n > 0),
            flush_interval: var("LANGFUSE_FLUSH_INTERVAL")
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|n| *n > 0.0),
            timeout_seconds: var("LANGFUSE_TIMEOUT")
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|n| *n > 0.0),
            media_upload_enabled: var("LANGFUSE_MEDIA_UPLOAD_ENABLED")
                .filter(|v| !v.is_empty())
                .is_none_or(|v| !["false", "0"].contains(&v.to_lowercase().as_str())),
        }
    }
}

/// The tracer provider exporting to Langfuse, and its `ai` tracer.
fn build_sdk(
    secret_key: &str,
    public_key: &str,
    base_url: &str,
    settings: ProcessorSettings,
) -> anyhow::Result<(LangfuseSdk, SdkTracer)> {
    let timeout =
        Duration::from_secs_f64(settings.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS));
    let auth =
        base64::engine::general_purpose::STANDARD.encode(format!("{public_key}:{secret_key}"));
    let headers: HashMap<String, String> = [
        ("Authorization".to_string(), format!("Basic {auth}")),
        (
            "x-langfuse-sdk-name".to_string(),
            LANGFUSE_SDK_NAME.to_string(),
        ),
        (
            "x-langfuse-sdk-version".to_string(),
            LANGFUSE_SDK_VERSION.to_string(),
        ),
        ("x-langfuse-public-key".to_string(), public_key.to_string()),
    ]
    .into_iter()
    .collect();
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpJson)
        .with_endpoint(format!("{base_url}/api/public/otel/v1/traces"))
        .with_timeout(timeout)
        .with_headers(headers)
        .with_http_client(OtlpHttpClient::new(timeout)?)
        .build()?;

    let mut batch = BatchConfigBuilder::default();
    if let Some(flush_at) = settings.flush_at {
        batch = batch.with_max_export_batch_size(flush_at);
    }
    if let Some(interval) = settings.flush_interval {
        batch = batch.with_scheduled_delay(Duration::from_secs_f64(interval));
    }
    let inner = BatchSpanProcessor::builder(exporter)
        .with_batch_config(batch.build())
        .build();

    let media = if settings.media_upload_enabled {
        Some(Arc::new(MediaService::new(
            base_url, public_key, secret_key,
        )?))
    } else {
        None
    };
    let processor = LangfuseSpanProcessor::new(inner, &settings, media.clone());
    let provider = SdkTracerProvider::builder()
        .with_resource(Resource::builder().build())
        .with_span_processor(processor)
        .build();
    let tracer = provider.tracer("ai");
    Ok((LangfuseSdk { provider, media }, tracer))
}

/// Langfuse's span processor: marks the spans, moves inline media out to the
/// media store, and hands each ended span to the batch exporter.
#[derive(Debug)]
struct LangfuseSpanProcessor<P: SpanProcessor> {
    inner: P,
    environment: Option<String>,
    release: Option<String>,
    media: Option<Arc<MediaService>>,
    /// Whether each open span is exported, by span id. Every span the `ai` tracer
    /// starts is, so a span is an app root when its parent is not one of them.
    exported: Mutex<HashSet<SpanId>>,
}

impl<P: SpanProcessor> LangfuseSpanProcessor<P> {
    fn new(inner: P, settings: &ProcessorSettings, media: Option<Arc<MediaService>>) -> Self {
        Self {
            inner,
            environment: settings.environment.clone(),
            release: settings.release.clone(),
            media,
            exported: Mutex::new(HashSet::new()),
        }
    }
}

impl<P: SpanProcessor> SpanProcessor for LangfuseSpanProcessor<P> {
    fn on_start(&self, span: &mut SdkSpan, cx: &Context) {
        if let Some(environment) = &self.environment {
            span.set_attribute(KeyValue::new("langfuse.environment", environment.clone()));
        }
        if let Some(release) = &self.release {
            span.set_attribute(KeyValue::new("langfuse.release", release.clone()));
        }
        let parent = cx.span().span_context().clone();
        let parent_exported = parent.is_valid() && self.exported.lock().contains(&parent.span_id());
        self.exported.lock().insert(span.span_context().span_id());
        if !parent_exported {
            span.set_attribute(KeyValue::new("langfuse.internal.is_app_root", true));
        }
        self.inner.on_start(span, cx);
    }

    fn on_end(&self, mut span: SpanData) {
        self.exported.lock().remove(&span.span_context.span_id());
        if let Some(media) = &self.media {
            media.process(&mut span);
        }
        self.inner.on_end(span);
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.inner.force_flush()
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

// ---------------------------------------------------------------------------
// Media: inline file bytes in a prompt go to Langfuse's media store
// ---------------------------------------------------------------------------

/// Replaces each inline file of a span's prompt with a Langfuse media tag, and
/// uploads the bytes in the background.
#[derive(Debug)]
struct MediaService {
    client: reqwest::Client,
    base_url: String,
    public_key: String,
    secret_key: String,
    pending: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// One file to upload.
struct MediaUpload {
    bytes: Vec<u8>,
    content_type: String,
    sha256_hash: String,
    media_id: String,
    trace_id: String,
    observation_id: String,
}

impl MediaService {
    fn new(base_url: &str, public_key: &str, secret_key: &str) -> anyhow::Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(MEDIA_API_TIMEOUT)
                .build()?,
            base_url: base_url.to_string(),
            public_key: public_key.to_string(),
            secret_key: secret_key.to_string(),
            pending: Mutex::new(Vec::new()),
        })
    }

    /// The AI SDK's prompt attributes, with every inline file of a message array
    /// replaced by its media tag.
    fn process(self: &Arc<Self>, span: &mut SpanData) {
        if !matches!(span.instrumentation_scope.name(), "ai" | "gen_ai") {
            return;
        }
        let trace_id = span.span_context.trace_id().to_string();
        let observation_id = span.span_context.span_id().to_string();
        for key in ["ai.prompt.messages", "ai.prompt"] {
            let Some(index) = span.attributes.iter().position(|kv| kv.key.as_str() == key) else {
                continue;
            };
            let OtelValue::String(text) = &span.attributes[index].value else {
                continue;
            };
            let text = text.as_str().to_string();
            if text.is_empty() {
                continue;
            }
            let Some(replaced) = self.replace_media(&text, &trace_id, &observation_id) else {
                continue;
            };
            span.attributes[index] = KeyValue::new(key, replaced);
        }
    }

    /// `text` with each inline file replaced, or `None` when it is not a message
    /// array.
    fn replace_media(
        self: &Arc<Self>,
        text: &str,
        trace_id: &str,
        observation_id: &str,
    ) -> Option<String> {
        let Ok(Value::Array(messages)) = serde_json::from_str::<Value>(text) else {
            return None;
        };
        let mut replaced = text.to_string();
        for message in &messages {
            let Some(Value::Array(parts)) = message.get("content") else {
                continue;
            };
            for part in parts {
                if part.get("type").and_then(Value::as_str) != Some("file") {
                    continue;
                }
                let inline = |field: &str| {
                    part.get(field)
                        .and_then(Value::as_str)
                        .filter(|data| !data.starts_with("http"))
                };
                let Some(base64) = inline("image").or_else(|| inline("data")) else {
                    continue;
                };
                let Some(media_type) = part.get("mediaType").and_then(Value::as_str) else {
                    continue;
                };
                let Ok(bytes) = crate::ai::json::base64_to_bytes(base64) else {
                    continue;
                };
                let upload = MediaUpload::new(
                    bytes,
                    media_type,
                    trace_id.to_string(),
                    observation_id.to_string(),
                );
                let tag = upload.tag();
                self.schedule_upload(upload);
                replaced = replaced.replace(base64, &tag);
            }
        }
        Some(replaced)
    }

    fn schedule_upload(self: &Arc<Self>, upload: MediaUpload) {
        let service = Arc::clone(self);
        let task = spawn_export(async move {
            if let Err(err) = service.upload(upload).await {
                log_error!("[Langfuse] Error processing media item: {}", err);
            }
        });
        let mut pending = self.pending.lock();
        pending.retain(|task| !task.is_finished());
        pending.push(task);
    }

    /// Waits for the uploads still running.
    async fn flush(&self) {
        let pending: Vec<_> = std::mem::take(&mut *self.pending.lock());
        for task in pending {
            let _ = task.await;
        }
    }

    fn api(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.base_url))
            .basic_auth(&self.public_key, Some(&self.secret_key))
            .header("X-Langfuse-Sdk-Name", LANGFUSE_SDK_NAME)
            .header("X-Langfuse-Sdk-Version", LANGFUSE_SDK_VERSION)
            .header("X-Langfuse-Public-Key", &self.public_key)
    }

    async fn upload(&self, upload: MediaUpload) -> anyhow::Result<()> {
        let response: Value = self
            .api(reqwest::Method::POST, "/api/public/media")
            .json(&json!({
                "contentLength": upload.bytes.len(),
                "traceId": upload.trace_id,
                "observationId": upload.observation_id,
                "field": "input",
                "contentType": upload.content_type,
                "sha256Hash": upload.sha256_hash,
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let media_id = response
            .get("mediaId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(upload_url) = response.get("uploadUrl").and_then(Value::as_str) else {
            log_debug!(
                "[Langfuse] Media status: Media with ID {} already uploaded. Skipping duplicate upload.",
                media_id
            );
            return Ok(());
        };
        if upload.media_id != media_id {
            anyhow::bail!(
                "Media integrity error: Media ID mismatch between SDK ({}) and Server ({}). Upload cancelled.",
                upload.media_id,
                media_id
            );
        }

        log_debug!("[Langfuse] Uploading media {}...", media_id);
        let started = Instant::now();
        let (status, body) = self.put_with_backoff(upload_url, &upload).await?;
        let succeeded = status == 200 || status == 201;
        self.api(
            reqwest::Method::PATCH,
            &format!("/api/public/media/{media_id}"),
        )
        .json(&json!({
            "uploadedAt": crate::support::now_iso(),
            "uploadHttpStatus": status,
            "uploadHttpError": body,
            "uploadTimeMs": started.elapsed().as_millis() as i64,
        }))
        .send()
        .await?
        .error_for_status()?;
        log_debug!("[Langfuse] Media upload status reported for {}", media_id);
        if !succeeded {
            anyhow::bail!(
                "Media upload failed with HTTP {status} after {MEDIA_UPLOAD_RETRIES} retries."
            );
        }
        Ok(())
    }

    /// PUTs the bytes, retrying a failed try with exponential backoff and jitter;
    /// the last try's answer is returned whatever its status.
    async fn put_with_backoff(
        &self,
        upload_url: &str,
        upload: &MediaUpload,
    ) -> anyhow::Result<(u16, String)> {
        let host = url::Url::parse(upload_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_default();
        let self_hosted_gcs =
            host == "storage.googleapis.com" || host.ends_with(".storage.googleapis.com");
        let mut attempt = 0;
        loop {
            let mut request = self
                .client
                .put(upload_url)
                .header("Content-Type", &upload.content_type)
                .body(upload.bytes.clone());
            if !self_hosted_gcs {
                request = request
                    .header("x-amz-checksum-sha256", &upload.sha256_hash)
                    .header("x-ms-blob-type", "BlockBlob");
            }
            let outcome: anyhow::Result<(u16, String)> = async {
                let response = request.send().await?;
                let status = response.status().as_u16();
                if attempt < MEDIA_UPLOAD_RETRIES && status != 200 && status != 201 {
                    anyhow::bail!("Upload failed with status {status}");
                }
                Ok((status, response.text().await?))
            }
            .await;
            match outcome {
                Ok(answer) => return Ok(answer),
                Err(err) if attempt == MEDIA_UPLOAD_RETRIES => return Err(err),
                Err(_) => {
                    let delay = MEDIA_UPLOAD_BASE_DELAY_MS * 2u64.pow(attempt);
                    let jitter = rand::random_range(0..1_000u64);
                    tokio::time::sleep(Duration::from_millis(delay + jitter)).await;
                    attempt += 1;
                }
            }
        }
    }
}

impl MediaUpload {
    fn new(bytes: Vec<u8>, content_type: &str, trace_id: String, observation_id: String) -> Self {
        let sha256_hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(&bytes));
        let media_id: String = sha256_hash
            .replace('+', "-")
            .replace('/', "_")
            .chars()
            .take(22)
            .collect();
        Self {
            bytes,
            content_type: content_type.to_string(),
            sha256_hash,
            media_id,
            trace_id,
            observation_id,
        }
    }

    /// The reference Langfuse renders in place of the bytes.
    fn tag(&self) -> String {
        format!(
            "@@@langfuseMedia:type={}|id={}|source=bytes@@@",
            self.content_type, self.media_id
        )
    }
}

// ---------------------------------------------------------------------------
// The integration: the AI SDK's legacy OpenTelemetry span shape
// ---------------------------------------------------------------------------

/// Attributes in the order a span receives them. A repeated key keeps its first
/// position and takes the later value.
#[derive(Debug, Clone, Default)]
struct Attrs(IndexMap<String, OtelValue>);

impl Attrs {
    fn into_key_values(self) -> Vec<KeyValue> {
        self.0
            .into_iter()
            .map(|(key, value)| KeyValue::new(key, value))
            .collect()
    }
}

/// `selectAttributes`: plain values always, an input only while inputs are
/// recorded, an output only while outputs are recorded; an absent value is left
/// out.
struct Select<'a> {
    meta: &'a TelemetryMeta,
    attrs: Attrs,
}

impl<'a> Select<'a> {
    fn new(meta: &'a TelemetryMeta) -> Self {
        Self {
            meta,
            attrs: Attrs::default(),
        }
    }

    fn plain(&mut self, key: &str, value: Option<OtelValue>) -> &mut Self {
        if let Some(value) = value {
            self.attrs.0.insert(key.to_string(), value);
        }
        self
    }

    fn input(&mut self, key: &str, value: impl FnOnce() -> Option<OtelValue>) -> &mut Self {
        if self.meta.record_inputs != Some(false) {
            self.plain(key, value());
        }
        self
    }

    fn output(&mut self, key: &str, value: impl FnOnce() -> Option<OtelValue>) -> &mut Self {
        if self.meta.record_outputs != Some(false) {
            self.plain(key, value());
        }
        self
    }

    fn extend(&mut self, attrs: &Attrs) -> &mut Self {
        for (key, value) in &attrs.0 {
            self.attrs.0.insert(key.clone(), value.clone());
        }
        self
    }

    /// `assembleOperationName`.
    fn operation(&mut self, operation_id: &str) -> &mut Self {
        let function_id = self.meta.function_id.clone();
        let name = match &function_id {
            Some(function_id) => format!("{operation_id} {function_id}"),
            None => operation_id.to_string(),
        };
        self.plain("operation.name", text(name))
            .plain("resource.name", function_id.clone().and_then(text))
            .plain("ai.operationId", text(operation_id))
            .plain("ai.telemetry.functionId", function_id.and_then(text))
    }

    fn finish(&mut self) -> Attrs {
        std::mem::take(&mut self.attrs)
    }
}

fn text(value: impl Into<String>) -> Option<OtelValue> {
    Some(OtelValue::String(StringValue::from(value.into())))
}

fn int(value: Option<i64>) -> Option<OtelValue> {
    value.map(OtelValue::I64)
}

/// A JavaScript number: integral values travel as integers.
fn number(value: Option<f64>) -> Option<OtelValue> {
    let value = value.filter(|v| v.is_finite())?;
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        Some(OtelValue::I64(value as i64))
    } else {
        Some(OtelValue::F64(value))
    }
}

/// A string array; an empty one is left out.
fn strings(values: Vec<String>) -> Option<OtelValue> {
    if values.is_empty() {
        return None;
    }
    Some(OtelValue::Array(Array::String(
        values.into_iter().map(StringValue::from).collect(),
    )))
}

/// `sanitizeAttributeValue` for a JSON value: a primitive as it is, an array
/// only when its primitives share one type, anything else left out.
fn json_value(value: &Value) -> Option<OtelValue> {
    match value {
        Value::String(s) => text(s.clone()),
        Value::Bool(b) => Some(OtelValue::Bool(*b)),
        Value::Number(n) => number(n.as_f64()),
        Value::Array(items) => {
            let kinds: HashSet<&str> = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(_) => Some("string"),
                    Value::Number(_) => Some("number"),
                    Value::Bool(_) => Some("boolean"),
                    _ => None,
                })
                .collect();
            if kinds.len() != 1 {
                return None;
            }
            match kinds.into_iter().next() {
                Some("string") => strings(
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect(),
                ),
                Some("number") => {
                    let numbers: Vec<f64> = items.iter().filter_map(Value::as_f64).collect();
                    if numbers.iter().all(|n| n.fract() == 0.0) {
                        Some(OtelValue::Array(Array::I64(
                            numbers.into_iter().map(|n| n as i64).collect(),
                        )))
                    } else {
                        Some(OtelValue::Array(Array::F64(numbers)))
                    }
                }
                _ => Some(OtelValue::Array(Array::Bool(
                    items.iter().filter_map(Value::as_bool).collect(),
                ))),
            }
        }
        Value::Null | Value::Object(_) => None,
    }
}

/// The call settings the spans record (`ai.settings.*`, `gen_ai.request.*`).
#[derive(Debug, Clone, Default)]
struct Settings {
    max_output_tokens: Option<i64>,
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<f64>,
    presence_penalty: Option<f64>,
    frequency_penalty: Option<f64>,
    stop_sequences: Option<Vec<String>>,
    seed: Option<i64>,
    max_retries: Option<u32>,
}

/// `getBaseTelemetryAttributes`: the model, the settings, the runtime context
/// and the request headers.
fn base_attributes(
    provider: &str,
    model_id: &str,
    settings: &Settings,
    context: Option<&JsonObject>,
    headers: &Headers,
) -> Attrs {
    let mut attrs = Attrs::default();
    let mut put = |key: String, value: Option<OtelValue>| {
        if let Some(value) = value {
            attrs.0.insert(key, value);
        }
    };
    put("ai.model.provider".into(), text(provider));
    put("ai.model.id".into(), text(model_id));
    put(
        "ai.settings.maxOutputTokens".into(),
        int(settings.max_output_tokens),
    );
    put(
        "ai.settings.temperature".into(),
        number(settings.temperature),
    );
    put("ai.settings.topP".into(), number(settings.top_p));
    put("ai.settings.topK".into(), number(settings.top_k));
    put(
        "ai.settings.presencePenalty".into(),
        number(settings.presence_penalty),
    );
    put(
        "ai.settings.frequencyPenalty".into(),
        number(settings.frequency_penalty),
    );
    put(
        "ai.settings.stopSequences".into(),
        settings.stop_sequences.clone().and_then(strings),
    );
    put("ai.settings.seed".into(), int(settings.seed));
    put(
        "ai.settings.maxRetries".into(),
        settings.max_retries.map(|n| OtelValue::I64(n as i64)),
    );
    if let Some(context) = context {
        for (key, value) in context {
            context_attribute(&mut put, format!("ai.settings.context.{key}"), value);
        }
    }
    for (key, value) in headers {
        put(format!("ai.request.headers.{key}"), text(value.clone()));
    }
    attrs
}

/// Flattens a nested runtime context object into dotted keys; an array stays a
/// value.
fn context_attribute(put: &mut impl FnMut(String, Option<OtelValue>), key: String, value: &Value) {
    match value {
        Value::Null => {}
        Value::Object(map) => {
            for (nested, value) in map {
                context_attribute(put, format!("{key}.{nested}"), value);
            }
        }
        other => put(key, json_value(other)),
    }
}

/// `{ system, messages }` (and `prompt` for an object call), with the absent
/// ones left out, as `JSON.stringify` writes it.
fn prompt_json(entries: Vec<(&str, Option<Value>)>) -> String {
    let mut object = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            object.insert(key.to_string(), value);
        }
    }
    js_stringify(&Value::Object(object))
}

fn to_value<T: serde::Serialize>(value: &T) -> Option<Value> {
    serde_json::to_value(value).ok()
}

/// `stringifyForTelemetry`: the provider prompt with each file part's data as
/// plain text (base64, a URL, a reference or the text itself).
fn stringify_for_telemetry(prompt: &LanguageModelV4Prompt) -> String {
    let mut value = serde_json::to_value(prompt).unwrap_or(Value::Null);
    if let Value::Array(messages) = &mut value {
        for message in messages {
            let Some(Value::Array(parts)) = message.get_mut("content") else {
                continue;
            };
            for part in parts {
                if part.get("type").and_then(Value::as_str) != Some("file") {
                    continue;
                }
                let Some(data) = part.get_mut("data") else {
                    continue;
                };
                let flat = match data.get("type").and_then(Value::as_str) {
                    Some("data") => data.get("data").cloned(),
                    Some("url") => data.get("url").cloned(),
                    Some("reference") => data.get("reference").cloned(),
                    Some("text") => data.get("text").cloned(),
                    _ => None,
                };
                if let Some(flat) = flat {
                    *data = flat;
                }
            }
        }
    }
    js_stringify(&value)
}

fn usage_attributes(select: &mut Select<'_>, usage: &LanguageModelUsage, detailed: bool) {
    select
        .plain("ai.usage.inputTokens", int(usage.input_tokens))
        .plain("ai.usage.outputTokens", int(usage.output_tokens))
        .plain("ai.usage.totalTokens", int(usage.total_tokens))
        .plain(
            "ai.usage.reasoningTokens",
            int(usage.output_token_details.reasoning_tokens),
        )
        .plain(
            "ai.usage.cachedInputTokens",
            int(usage.input_token_details.cache_read_tokens),
        );
    if detailed {
        select
            .plain(
                "ai.usage.inputTokenDetails.noCacheTokens",
                int(usage.input_token_details.no_cache_tokens),
            )
            .plain(
                "ai.usage.inputTokenDetails.cacheReadTokens",
                int(usage.input_token_details.cache_read_tokens),
            )
            .plain(
                "ai.usage.inputTokenDetails.cacheWriteTokens",
                int(usage.input_token_details.cache_write_tokens),
            )
            .plain(
                "ai.usage.outputTokenDetails.textTokens",
                int(usage.output_token_details.text_tokens),
            )
            .plain(
                "ai.usage.outputTokenDetails.reasoningTokens",
                int(usage.output_token_details.reasoning_tokens),
            );
    }
}

fn gen_ai_response_attributes(
    select: &mut Select<'_>,
    finish_reason: FinishReason,
    response_id: &str,
    response_model: &str,
    usage: &LanguageModelUsage,
) {
    select
        .plain(
            "gen_ai.response.finish_reasons",
            strings(vec![finish_reason.as_str().to_string()]),
        )
        .plain("gen_ai.response.id", text(response_id))
        .plain("gen_ai.response.model", text(response_model))
        .plain("gen_ai.usage.input_tokens", int(usage.input_tokens))
        .plain("gen_ai.usage.output_tokens", int(usage.output_tokens));
}

/// The reasoning texts joined by newlines, when the step has reasoning.
fn reasoning_text(step: &StepResult) -> Option<OtelValue> {
    let parts: Vec<&ContentPart> = step
        .content
        .iter()
        .filter(|part| {
            matches!(
                part,
                ContentPart::Reasoning { .. } | ContentPart::ReasoningFile { .. }
            )
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    let texts: Vec<&str> = parts
        .iter()
        .filter_map(|part| match part {
            ContentPart::Reasoning { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    text(texts.join("\n"))
}

fn tool_calls_json<'a>(
    calls: impl IntoIterator<Item = &'a crate::ai::generate_text::TypedToolCall>,
) -> Option<OtelValue> {
    let calls: Vec<Value> = calls
        .into_iter()
        .map(|call| {
            json!({
                "toolCallId": call.tool_call_id,
                "toolName": call.tool_name,
                "input": call.input,
            })
        })
        .collect();
    if calls.is_empty() {
        return None;
    }
    text(js_stringify(&Value::Array(calls)))
}

fn files_json<'a>(
    files: impl IntoIterator<Item = &'a crate::ai::generate_text::GeneratedFile>,
) -> Option<OtelValue> {
    let files: Vec<Value> = files
        .into_iter()
        .map(|file| json!({ "type": "file", "mediaType": file.media_type, "data": file.base64 }))
        .collect();
    if files.is_empty() {
        return None;
    }
    text(js_stringify(&Value::Array(files)))
}

fn provider_metadata_json(metadata: Option<&JsonObject>) -> Option<OtelValue> {
    metadata.and_then(|metadata| text(js_stringify(&Value::Object(metadata.clone()))))
}

/// `recordSpanError`: an error is recorded as an `exception` event and the
/// span's status; anything else marks the status alone.
fn record_span_error(span: &opentelemetry::trace::SpanRef<'_>, error: Option<&anyhow::Error>) {
    let Some(error) = error else {
        span.set_status(Status::error(""));
        return;
    };
    let name = crate::ai::errors::error_name(error);
    let message = error.to_string();
    let mut attributes = Vec::new();
    if !name.is_empty() {
        attributes.push(KeyValue::new("exception.type", name));
    }
    if !message.is_empty() {
        attributes.push(KeyValue::new("exception.message", message.clone()));
    }
    if !attributes.is_empty() {
        span.add_event("exception", attributes);
    }
    span.set_status(Status::error(message));
}

/// What one call's spans share while it runs.
struct CallState {
    operation_id: String,
    meta: TelemetryMeta,
    root: Context,
    step: Option<Context>,
    embed_spans: HashMap<String, Context>,
    tool_spans: HashMap<String, Context>,
    base: Attrs,
    settings: Settings,
}

/// The AI SDK's `LegacyOpenTelemetry` integration: `ai.generateText` and its
/// `ai.generateText.doGenerate` steps, `ai.toolCall`, `ai.generateObject`,
/// `ai.embed` and their provider calls, under the tracer it is given.
pub(crate) struct LegacyOpenTelemetry {
    tracer: SdkTracer,
    call_states: Mutex<HashMap<String, CallState>>,
}

impl LegacyOpenTelemetry {
    pub(crate) fn new(tracer: SdkTracer) -> Self {
        Self {
            tracer,
            call_states: Mutex::new(HashMap::new()),
        }
    }

    fn start_span(&self, name: &str, attrs: Attrs, parent: &Context) -> Context {
        let span = self
            .tracer
            .span_builder(name.to_string())
            .with_attributes(attrs.into_key_values())
            .start_with_context(&self.tracer, parent);
        parent.with_span(span)
    }

    fn start_operation(
        &self,
        call_id: &str,
        operation_id: &str,
        meta: TelemetryMeta,
        attrs: Attrs,
        base: Attrs,
        settings: Settings,
    ) {
        let root = self.start_span(operation_id, attrs, &Context::current());
        self.call_states.lock().insert(
            call_id.to_string(),
            CallState {
                operation_id: operation_id.to_string(),
                meta,
                root,
                step: None,
                embed_spans: HashMap::new(),
                tool_spans: HashMap::new(),
                base,
                settings,
            },
        );
    }

    fn on_generate_start(&self, event: &GenerateTextStartEvent, meta: &TelemetryMeta) {
        let settings = Settings {
            max_output_tokens: event.max_output_tokens,
            temperature: event.temperature,
            top_p: event.top_p,
            top_k: event.top_k,
            presence_penalty: event.presence_penalty,
            frequency_penalty: event.frequency_penalty,
            stop_sequences: event.stop_sequences.clone(),
            seed: event.seed,
            max_retries: Some(event.max_retries),
        };
        let base = base_attributes(
            &event.provider,
            &event.model_id,
            &settings,
            Some(&event.runtime_context),
            &event.headers,
        );
        let attrs = Select::new(meta)
            .operation(event.operation_id)
            .extend(&base)
            .plain("ai.model.provider", text(event.provider.clone()))
            .plain("ai.model.id", text(event.model_id.clone()))
            .input("ai.prompt", || {
                text(prompt_json(vec![
                    ("system", event.instructions.as_ref().and_then(to_value)),
                    ("messages", to_value(&event.messages)),
                ]))
            })
            .finish();
        self.start_operation(
            &event.call_id,
            event.operation_id,
            meta.clone(),
            attrs,
            base,
            settings,
        );
    }

    fn on_object_operation_start(&self, event: &GenerateObjectStartEvent, meta: &TelemetryMeta) {
        let settings = Settings {
            max_output_tokens: event.max_output_tokens,
            temperature: event.temperature,
            top_p: event.top_p,
            top_k: event.top_k,
            presence_penalty: event.presence_penalty,
            frequency_penalty: event.frequency_penalty,
            stop_sequences: None,
            seed: event.seed,
            max_retries: Some(event.max_retries),
        };
        let base = base_attributes(
            &event.provider,
            &event.model_id,
            &settings,
            None,
            &event.headers,
        );
        let schema = event
            .schema
            .as_ref()
            .filter(|schema| crate::support::js::truthy(schema));
        let mut select = Select::new(meta);
        select
            .operation(event.operation_id)
            .extend(&base)
            .input("ai.prompt", || {
                text(prompt_json(vec![
                    ("system", event.system.as_ref().and_then(to_value)),
                    ("prompt", event.prompt.as_ref().and_then(to_value)),
                    ("messages", event.messages.as_ref().and_then(to_value)),
                ]))
            });
        if let Some(schema) = schema {
            select.input("ai.schema", || text(js_stringify(schema)));
        }
        let attrs = select
            .plain("ai.schema.name", event.schema_name.clone().and_then(text))
            .plain(
                "ai.schema.description",
                event.schema_description.clone().and_then(text),
            )
            .plain("ai.settings.output", text(event.output))
            .finish();
        self.start_operation(
            &event.call_id,
            event.operation_id,
            meta.clone(),
            attrs,
            base,
            settings,
        );
    }

    fn on_embed_operation_start(&self, event: &EmbedStartEvent, meta: &TelemetryMeta) {
        let settings = Settings {
            max_retries: Some(event.max_retries),
            ..Default::default()
        };
        let base = base_attributes(
            &event.provider,
            &event.model_id,
            &settings,
            Some(&event.runtime_context),
            &event.headers,
        );
        let mut select = Select::new(meta);
        select.operation(event.operation_id).extend(&base);
        if event.operation_id == "ai.embedMany" {
            select.input("ai.values", || {
                strings(
                    event
                        .value
                        .as_array()
                        .map(|values| values.iter().map(js_stringify).collect())
                        .unwrap_or_default(),
                )
            });
        } else {
            select.input("ai.value", || text(js_stringify(&event.value)));
        }
        let attrs = select.finish();
        self.start_operation(
            &event.call_id,
            event.operation_id,
            meta.clone(),
            attrs,
            base,
            settings,
        );
    }

    fn on_generate_end(&self, event: &GenerateTextEndEvent) {
        let Some(state) = self.call_states.lock().remove(&event.call_id) else {
            return;
        };
        let span = state.root.span();
        if event.finish_reason == FinishReason::Error {
            span.set_status(Status::error(""));
        }
        let final_step = event.steps.last();
        let mut select = Select::new(&state.meta);
        select
            .plain(
                "ai.response.finishReason",
                text(event.finish_reason.as_str()),
            )
            .output("ai.response.text", || text(event.text.clone()))
            .output("ai.response.reasoning", || {
                final_step.and_then(|step| reasoning_text(step))
            })
            .output("ai.response.toolCalls", || {
                tool_calls_json(event.tool_calls.iter())
            })
            .output("ai.response.files", || {
                files_json(event.steps.iter().flat_map(|step| step.files()))
            })
            .plain(
                "ai.response.providerMetadata",
                provider_metadata_json(event.provider_metadata.as_ref()),
            );
        usage_attributes(&mut select, &event.total_usage, true);
        span.set_attributes(select.finish().into_key_values());
        span.end();
    }

    fn on_object_operation_end(&self, event: &GenerateObjectEndEvent) {
        let Some(state) = self.call_states.lock().remove(&event.call_id) else {
            return;
        };
        let span = state.root.span();
        if event.finish_reason == FinishReason::Error {
            span.set_status(Status::error(""));
        }
        let mut select = Select::new(&state.meta);
        select
            .plain(
                "ai.response.finishReason",
                text(event.finish_reason.as_str()),
            )
            .output("ai.response.object", || {
                (!event.object.is_null())
                    .then(|| js_stringify(&event.object))
                    .and_then(text)
            })
            .plain(
                "ai.response.providerMetadata",
                provider_metadata_json(event.provider_metadata.as_ref()),
            );
        usage_attributes(&mut select, &event.usage, false);
        span.set_attributes(select.finish().into_key_values());
        span.end();
    }

    fn on_embed_operation_end(&self, event: &EmbedEndEvent) {
        let Some(state) = self.call_states.lock().remove(&event.call_id) else {
            return;
        };
        let span = state.root.span();
        let mut select = Select::new(&state.meta);
        if state.operation_id == "ai.embedMany" {
            select.output("ai.embeddings", || {
                strings(
                    event
                        .embedding
                        .as_array()
                        .map(|list| list.iter().map(js_stringify).collect())
                        .unwrap_or_default(),
                )
            });
        } else {
            select.output("ai.embedding", || text(js_stringify(&event.embedding)));
        }
        select.plain("ai.usage.tokens", number(Some(event.tokens)));
        span.set_attributes(select.finish().into_key_values());
        span.end();
    }
}

impl Telemetry for LegacyOpenTelemetry {
    fn on_start(&self, event: &OperationStartEvent, meta: &TelemetryMeta) {
        match event {
            OperationStartEvent::GenerateText(event) => self.on_generate_start(event, meta),
            OperationStartEvent::GenerateObject(event) => {
                self.on_object_operation_start(event, meta)
            }
            OperationStartEvent::Embed(event) => self.on_embed_operation_start(event, meta),
        }
    }

    fn on_step_start(&self, event: &GenerateTextStepStartEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let step_operation_id = if state.operation_id == "ai.streamText" {
            "ai.streamText.doStream"
        } else {
            "ai.generateText.doGenerate"
        };
        let settings = &state.settings;
        let attrs = Select::new(&state.meta)
            .operation(step_operation_id)
            .extend(&state.base)
            .plain("ai.model.provider", text(event.provider.clone()))
            .plain("ai.model.id", text(event.model_id.clone()))
            .input("ai.prompt.messages", || {
                text(stringify_for_telemetry(&event.prompt_messages))
            })
            .input("ai.prompt.tools", || {
                event
                    .step_tools
                    .as_ref()
                    .and_then(|tools| strings(tools.iter().map(to_js_json).collect()))
            })
            .input("ai.prompt.toolChoice", || {
                text(to_js_json(&event.step_tool_choice))
            })
            .plain("gen_ai.system", text(event.provider.clone()))
            .plain("gen_ai.request.model", text(event.model_id.clone()))
            .plain(
                "gen_ai.request.frequency_penalty",
                number(settings.frequency_penalty),
            )
            .plain("gen_ai.request.max_tokens", int(settings.max_output_tokens))
            .plain(
                "gen_ai.request.presence_penalty",
                number(settings.presence_penalty),
            )
            .plain(
                "gen_ai.request.stop_sequences",
                settings.stop_sequences.clone().and_then(strings),
            )
            .plain("gen_ai.request.temperature", number(settings.temperature))
            .plain("gen_ai.request.top_k", number(settings.top_k))
            .plain("gen_ai.request.top_p", number(settings.top_p))
            .finish();
        let step = self.start_span(step_operation_id, attrs, &state.root);
        state.step = Some(step);
    }

    fn on_tool_execution_start(&self, event: &ToolExecutionStartEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let Some(step) = state.step.clone() else {
            return;
        };
        let call = &event.tool_call;
        let context_attrs = Attrs(
            state
                .base
                .0
                .iter()
                .filter(|(key, _)| key.starts_with("ai.settings.context."))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        );
        let attrs = Select::new(&state.meta)
            .operation("ai.toolCall")
            .extend(&context_attrs)
            .plain("ai.toolCall.name", text(call.tool_name.clone()))
            .plain("ai.toolCall.id", text(call.tool_call_id.clone()))
            .output("ai.toolCall.args", || text(js_stringify(&call.input)))
            .finish();
        let span = self.start_span("ai.toolCall", attrs, &step);
        state.tool_spans.insert(call.tool_call_id.clone(), span);
    }

    fn on_tool_execution_end(&self, event: &ToolExecutionEndEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let Some(entry) = state.tool_spans.remove(&event.tool_call.tool_call_id) else {
            return;
        };
        let span = entry.span();
        match &event.tool_output {
            ToolOutput::Result(result) => {
                let attrs = Select::new(&state.meta)
                    .output("ai.toolCall.result", || text(js_stringify(&result.output)))
                    .finish();
                span.set_attributes(attrs.into_key_values());
            }
            ToolOutput::Error(error) => match &error.error {
                ToolErrorValue::Error(error) => record_span_error(&span, Some(error.as_ref())),
                ToolErrorValue::Message(_) | ToolErrorValue::Json(_) => {
                    record_span_error(&span, None)
                }
            },
        }
        span.end();
    }

    fn on_step_end(&self, event: &StepResult, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let Some(step) = state.step.take() else {
            return;
        };
        let span = step.span();
        if event.finish_reason == FinishReason::Error {
            span.set_status(Status::error(""));
        }
        let mut select = Select::new(&state.meta);
        select
            .plain(
                "ai.response.finishReason",
                text(event.finish_reason.as_str()),
            )
            .output("ai.response.text", || text(event.text()))
            .output("ai.response.reasoning", || reasoning_text(event))
            .output("ai.response.toolCalls", || {
                tool_calls_json(event.tool_calls())
            })
            .output("ai.response.files", || files_json(event.files()))
            .plain("ai.response.id", text(event.response.id.clone()))
            .plain("ai.response.model", text(event.response.model_id.clone()))
            .plain(
                "ai.response.timestamp",
                text(crate::support::iso(&event.response.timestamp)),
            )
            .plain(
                "ai.response.providerMetadata",
                provider_metadata_json(event.provider_metadata.as_ref()),
            );
        usage_attributes(&mut select, &event.usage, true);
        gen_ai_response_attributes(
            &mut select,
            event.finish_reason,
            &event.response.id,
            &event.response.model_id,
            &event.usage,
        );
        span.set_attributes(select.finish().into_key_values());
        span.end();
    }

    fn on_object_step_start(&self, event: &GenerateObjectStepStartEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let step_operation_id = if state.operation_id == "ai.streamObject" {
            "ai.streamObject.doStream"
        } else {
            "ai.generateObject.doGenerate"
        };
        let settings = &state.settings;
        let attrs = Select::new(&state.meta)
            .operation(step_operation_id)
            .extend(&state.base)
            .input("ai.prompt.messages", || {
                text(stringify_for_telemetry(&event.prompt_messages))
            })
            .plain("gen_ai.system", text(event.provider.clone()))
            .plain("gen_ai.request.model", text(event.model_id.clone()))
            .plain(
                "gen_ai.request.frequency_penalty",
                number(settings.frequency_penalty),
            )
            .plain("gen_ai.request.max_tokens", int(settings.max_output_tokens))
            .plain(
                "gen_ai.request.presence_penalty",
                number(settings.presence_penalty),
            )
            .plain("gen_ai.request.temperature", number(settings.temperature))
            .plain("gen_ai.request.top_k", number(settings.top_k))
            .plain("gen_ai.request.top_p", number(settings.top_p))
            .finish();
        let step = self.start_span(step_operation_id, attrs, &state.root);
        state.step = Some(step);
    }

    fn on_object_step_end(&self, event: &GenerateObjectStepEndEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let Some(step) = state.step.take() else {
            return;
        };
        let span = step.span();
        if event.finish_reason == FinishReason::Error {
            span.set_status(Status::error(""));
        }
        let mut select = Select::new(&state.meta);
        select
            .plain(
                "ai.response.finishReason",
                text(event.finish_reason.as_str()),
            )
            .output("ai.response.object", || {
                match serde_json::from_str::<Value>(&event.object_text) {
                    Ok(object) => text(js_stringify(&object)),
                    Err(_) => text(event.object_text.clone()),
                }
            })
            .plain("ai.response.id", text(event.response.id.clone()))
            .plain("ai.response.model", text(event.response.model_id.clone()))
            .plain(
                "ai.response.timestamp",
                text(crate::support::iso(&event.response.timestamp)),
            )
            .plain(
                "ai.response.providerMetadata",
                provider_metadata_json(event.provider_metadata.as_ref()),
            );
        usage_attributes(&mut select, &event.usage, false);
        gen_ai_response_attributes(
            &mut select,
            event.finish_reason,
            &event.response.id,
            &event.response.model_id,
            &event.usage,
        );
        span.set_attributes(select.finish().into_key_values());
        span.end();
    }

    fn on_embed_start(&self, event: &EmbeddingModelCallStartEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let attrs = Select::new(&state.meta)
            .operation(event.operation_id)
            .extend(&state.base)
            .input("ai.values", || {
                strings(
                    event
                        .values
                        .iter()
                        .map(|value| js_stringify(&Value::String(value.clone())))
                        .collect(),
                )
            })
            .finish();
        let span = self.start_span(event.operation_id, attrs, &state.root);
        state.embed_spans.insert(event.embed_call_id.clone(), span);
    }

    fn on_embed_end(&self, event: &EmbeddingModelCallEndEvent, _meta: &TelemetryMeta) {
        let mut states = self.call_states.lock();
        let Some(state) = states.get_mut(&event.call_id) else {
            return;
        };
        let Some(entry) = state.embed_spans.remove(&event.embed_call_id) else {
            return;
        };
        let span = entry.span();
        let attrs = Select::new(&state.meta)
            .output("ai.embeddings", || {
                strings(
                    event
                        .embeddings
                        .iter()
                        .map(|embedding| {
                            js_stringify(&Value::Array(
                                embedding
                                    .iter()
                                    .map(|n| crate::support::js::number(*n))
                                    .collect(),
                            ))
                        })
                        .collect(),
                )
            })
            .plain("ai.usage.tokens", number(Some(event.tokens)))
            .finish();
        span.set_attributes(attrs.into_key_values());
        span.end();
    }

    fn on_end(&self, event: &OperationEndEvent, _meta: &TelemetryMeta) {
        match event {
            OperationEndEvent::GenerateText(event) => self.on_generate_end(event),
            OperationEndEvent::GenerateObject(event) => self.on_object_operation_end(event),
            OperationEndEvent::Embed(event) => self.on_embed_operation_end(event),
        }
    }

    fn on_error(&self, call_id: &str, error: &anyhow::Error, _meta: &TelemetryMeta) {
        let Some(state) = self.call_states.lock().remove(call_id) else {
            return;
        };
        if let Some(step) = &state.step {
            let span = step.span();
            record_span_error(&span, Some(error));
            span.end();
        }
        for embed in state.embed_spans.values() {
            let span = embed.span();
            record_span_error(&span, Some(error));
            span.end();
        }
        let root = state.root.span();
        record_span_error(&root, Some(error));
        root.end();
    }
}

#[cfg(test)]
mod tests;
