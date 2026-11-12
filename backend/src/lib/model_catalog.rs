//! The model catalog: which input-context window each model has.
//!
//! Two layers. The **bundled floor** (`model_limits.generated.json`, vendored from
//! models.dev by `scripts/generate_model_limits.rs`) is always present and always
//! sufficient on its own — by default it is the only layer. Setting
//! `MODELS_DEV_URL` opts into a **remote overlay** fetched once at startup, so a
//! model released since the last build gets a real window instead of being
//! silently unmeasurable.
//!
//! Why models.dev is the source at all: none of the providers this runtime talks to
//! report a context window. Anthropic's Models API — the only source of
//! `max_input_tokens` — is first-party only, unavailable on both Bedrock and
//! Microsoft Foundry; Bedrock's `GetFoundationModel` returns modalities and
//! lifecycle but no context length; and OpenAI's model listing has no limit fields
//! either.
//!
//! Invariants the rest of the runtime depends on:
//! - **Reads are synchronous and always answerable.** `model_catalog()` never
//!   returns empty and never awaits, which is what makes "fall back to the bundle
//!   while the fetch is in flight" free rather than something to engineer.
//! - **The overlay merges, never replaces.** A degraded payload can add or update an
//!   entry but can never lose one, per provider.
//! - **The bundled catalog is never mutated.** Every merge allocates a fresh
//!   catalog.
//!
//! One boundary worth stating, because the safety analysis rests on it: a window
//! size from here reaches a percentage on a screen, a column in the database, and
//! exactly one programmatic consumer — the auto-compaction trigger
//! (`COMPACTION_SERVICE.maybe_auto_compact`, which fires when occupancy ≥
//! COMPACTION_THRESHOLD_PERCENT of the window) — and **never a prompt**. The
//! registry is community-maintained and its model IDs are lookup keys only, never
//! echoed into model input; the compaction prompt is fixed text, so a wrong or
//! hostile window still cannot *steer* the model. What it can do is cause spurious
//! or suppressed compactions, and that blast radius is deliberately bounded:
//! `CONTEXT_WINDOW_TOKENS` (operator-set) wins over the registry; windows under
//! `MIN_PLAUSIBLE_CONTEXT` are rejected outright (a tiny window would otherwise
//! force compaction on every turn); the newest tail messages are always preserved
//! and nothing is deleted (originals stay in the DB); and the nothing-to-compact +
//! once-per-exchange guards cap the damage at wasted summarize calls.

use std::sync::{Arc, LazyLock};

use indexmap::{IndexMap, IndexSet};
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use std::time::Duration;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::lib::proxy_dispatcher::get_proxy_dispatcher;
use crate::lib::telemetry::track_event;
use crate::support::now_ms;
use crate::{log_debug, log_info, log_warn};

/// The bundled floor, as vendored from models.dev.
const BUNDLED_JSON: &str = include_str!("model_limits.generated.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// Max input tokens the model accepts.
    pub context: i64,
    pub output: Option<i64>,
}

/// Provider (`bedrock` | `azure` | `openai` | `anthropic`) -> model ID -> limits.
pub type ModelCatalog = IndexMap<String, IndexMap<String, CatalogEntry>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogState {
    /// No refresh configured — the bundled floor is the whole story.
    Disabled,
    /// A refresh is in flight; reads are served from the bundled floor.
    Pending,
    /// No refresh has run (or none will) and the floor is current.
    Bundled,
    /// A remote overlay is installed.
    Remote,
    /// A refresh ran and did not produce a usable overlay.
    Failed,
}

impl CatalogState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Pending => "pending",
            Self::Bundled => "bundled",
            Self::Remote => "remote",
            Self::Failed => "failed",
        }
    }
}

/// models.dev provider id -> the `LLM_PROVIDER` value it serves. Shared with the
/// generator so the two can't drift on which providers are in scope.
pub const REGISTRY_PROVIDERS: [(&str, &str); 4] = [
    ("amazon-bedrock", "bedrock"),
    ("azure", "azure"),
    ("openai", "openai"),
    ("anthropic", "anthropic"),
];

/// The model family each registry provider contributes, scoped per provider: on
/// the Claude-serving vendors only Claude models reach `invoke_stream()`, and
/// azure's registry entry lists plenty of GPT models that would be noise in that
/// bucket — while the `openai` bucket exists precisely for GPT (and
/// o-series/codex) ids and would find no Claude there.
static CLAUDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)claude|fable|mythos").unwrap());
static OPENAI_FAMILY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^gpt|^o\d|^codex").unwrap());

fn registry_family(registry_id: &str) -> Option<&'static Regex> {
    match registry_id {
        "amazon-bedrock" | "azure" | "anthropic" => Some(&CLAUDE),
        "openai" => Some(&OPENAI_FAMILY),
        _ => None,
    }
}

/// Smallest window we'll believe. The generator historically accepted anything
/// `> 0`, but a handful-of-tokens window renders "100% context used" forever — the
/// exact "a wrong number is worse than none" failure the indicator exists to
/// avoid. Shared with the generator so both layers reject the same nonsense.
pub const MIN_PLAUSIBLE_CONTEXT: i64 = 1_000;

/// Beyond this ratio to the bundled value, a remote entry is worth a warning.
const DIVERGENCE_FACTOR: f64 = 2.0;

/// True when a registry entry is in its provider's model family (see
/// `registry_family`) with a believable window. `model` is the registry's JSON for
/// one model (`{ limit?: { context?, output? } }`).
pub fn is_usable_registry_entry(id: &str, model: &Value, registry_id: &str) -> bool {
    let Some(family) = registry_family(registry_id) else {
        return false;
    };
    if !family.is_match(id) {
        return false;
    }
    match model
        .get("limit")
        .and_then(|limit| limit.get("context"))
        .and_then(Value::as_f64)
    {
        Some(context) => context.is_finite() && context >= MIN_PLAUSIBLE_CONTEXT as f64,
        None => false,
    }
}

static BUNDLED_CATALOG: LazyLock<Arc<ModelCatalog>> = LazyLock::new(|| {
    let catalog: ModelCatalog =
        serde_json::from_str(BUNDLED_JSON).expect("the bundled model catalog parses");
    Arc::new(catalog)
});

static EFFECTIVE: LazyLock<RwLock<Arc<ModelCatalog>>> =
    LazyLock::new(|| RwLock::new(BUNDLED_CATALOG.clone()));
static STATE: Mutex<CatalogState> = Mutex::new(CatalogState::Bundled);
static CONTROLLER: Mutex<Option<CancellationToken>> = Mutex::new(None);

/// The catalog to resolve against. Synchronous; never empty.
pub fn model_catalog() -> Arc<ModelCatalog> {
    EFFECTIVE.read().clone()
}

/// The bundled floor, for tests and for diffing an overlay against it.
pub fn bundled_model_catalog() -> Arc<ModelCatalog> {
    BUNDLED_CATALOG.clone()
}

pub fn model_catalog_state() -> CatalogState {
    *STATE.lock()
}

/// Turn a raw models.dev payload into a provider-scoped catalog, or `None` when
/// it's unusable as a whole.
///
/// Pure, and shared with `scripts/generate_model_limits.rs` so the filter
/// predicate cannot drift between build time and runtime. The two differ only in
/// error policy: the generator throws on shape drift, the runtime degrades.
///
/// Tolerant per entry (a bad row is dropped) but strict per payload: if no
/// configured provider yields a single usable entry, the shape has drifted far
/// enough that installing it would do more harm than keeping the floor.
pub fn reshape_registry(raw: &Value) -> Option<ModelCatalog> {
    let Value::Object(registry) = raw else {
        return None;
    };

    let mut out = ModelCatalog::new();
    let mut total = 0usize;

    for (registry_id, provider) in REGISTRY_PROVIDERS {
        let Some(Value::Object(models)) = registry.get(registry_id).and_then(|p| p.get("models"))
        else {
            continue;
        };

        let mut entries: IndexMap<String, CatalogEntry> = IndexMap::new();
        for (id, model) in models {
            if !model.is_object() {
                continue;
            }
            if !is_usable_registry_entry(id, model, registry_id) {
                continue;
            }
            let limit = &model["limit"];
            let context = limit["context"].as_f64().unwrap_or(0.0) as i64;
            let output = limit
                .get("output")
                .and_then(Value::as_f64)
                .map(|o| o as i64);
            entries.insert(id.clone(), CatalogEntry { context, output });
            total += 1;
        }

        // A provider that yielded nothing is left absent rather than emitted empty,
        // so the merge leaves that provider entirely at its bundled values.
        if !entries.is_empty() {
            out.insert(provider.to_string(), entries);
        }
    }

    if total > 0 { Some(out) } else { None }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallResult {
    /// Entries the bundle didn't have.
    pub added: i64,
    /// Entries whose context differs from the bundled value.
    pub changed: i64,
    /// Of those, ones differing by more than DIVERGENCE_FACTOR — worth a look.
    pub diverged: i64,
}

/// Merge a remote catalog over the bundled floor and make it the effective one.
///
/// Builds a fresh catalog rather than mutating: `context_window_for` runs per step,
/// so the cost belongs here (once per boot) rather than on the lookup path, and the
/// bundled catalog must stay pristine.
pub fn install_remote_catalog(remote: &ModelCatalog) -> InstallResult {
    let bundled = BUNDLED_CATALOG.clone();
    let mut merged = ModelCatalog::new();
    let mut result = InstallResult::default();

    let providers: IndexSet<&String> = bundled.keys().chain(remote.keys()).collect();
    let empty = IndexMap::new();
    for provider in providers {
        let floor = bundled.get(provider).unwrap_or(&empty);
        let overlay = remote.get(provider).unwrap_or(&empty);

        for (id, entry) in overlay {
            match floor.get(id) {
                None => result.added += 1,
                Some(previous) if previous.context != entry.context => {
                    result.changed += 1;
                    let ratio = entry.context as f64 / previous.context as f64;
                    if !(1.0 / DIVERGENCE_FACTOR..=DIVERGENCE_FACTOR).contains(&ratio) {
                        result.diverged += 1;
                    }
                }
                Some(_) => {}
            }
        }

        // Overlay wins per entry; anything only the floor has survives.
        let mut models = floor.clone();
        for (id, entry) in overlay {
            models.insert(id.clone(), *entry);
        }
        merged.insert(provider.clone(), models);
    }

    *EFFECTIVE.write() = Arc::new(merged);
    result
}

/// Test-only: drop any installed overlay and return to the bundled floor.
pub fn reset_model_catalog() {
    *EFFECTIVE.write() = BUNDLED_CATALOG.clone();
    *STATE.lock() = CatalogState::Bundled;
    *CONTROLLER.lock() = None;
}

/// models.dev answers in ~0.4 s, so 5 s is >10x headroom. Past that it is almost
/// certainly a blocked egress path rather than a slow one, and waiting longer buys
/// nothing — the bundled floor is already serving every lookup. Keeping it short
/// also bounds how long a SIGTERM during boot has to wait on a dangling socket.
const FETCH_TIMEOUT_MS: u64 = 5_000;

/// Refuse to buffer a pathological body. The real payload is ~3.3 MB uncompressed
/// (~314 KB on the wire); 16 MB is generous headroom that still protects a
/// memory-capped container from an unbounded read.
const MAX_BODY_BYTES: u64 = 16 * 1024 * 1024;

/// Why a refresh failed — reported as an enum, never as raw error text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    Timeout,
    Http,
    Network,
    Parse,
    Shape,
}

impl FailureKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Http => "http",
            Self::Network => "network",
            Self::Parse => "parse",
            Self::Shape => "shape",
        }
    }
}

/// Why the payload was unusable.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct RejectedPayload {
    kind: FailureKind,
    message: String,
}

/// Fetch models.dev once and install the result as an overlay.
///
/// **Total — never fails.** Every failure degrades to the bundled floor, which was
/// already serving lookups, so there is nothing for a caller to handle. Spawn it;
/// do not await it on the boot path.
///
/// Without `MODELS_DEV_URL` the state becomes `disabled` and it logs at debug
/// `[ModelCatalog] MODELS_DEV_URL unset; using the bundled catalog (no outbound
/// call)`. Otherwise the state is `pending` while the fetch runs (one deadline of
/// `FETCH_TIMEOUT_MS` composed with the cancel token), then `remote` with the info
/// line `[ModelCatalog] refreshed from models.dev in ${ms}ms (${provider=count …},
/// ${added} new, ${changed} changed)` and, when entries diverged, the warning
/// `[ModelCatalog] ${diverged} model(s) diverge from the bundled catalog by more
/// than 2x; regenerate the snapshot to review`. A cancel returns the state to
/// `bundled` (debug `[ModelCatalog] refresh canceled`); a rejected payload sets
/// `failed` and warns `[ModelCatalog] models.dev payload rejected (${message});
/// using the bundled catalog`; any other failure sets `failed` and warns `{ err }`
/// `[ModelCatalog] refresh failed; using the bundled catalog`. Each outcome but the
/// cancel emits `model catalog refreshed`.
pub async fn refresh_model_catalog() {
    let Some(url) = CONFIG.models_dev_url.clone().filter(|url| !url.is_empty()) else {
        *STATE.lock() = CatalogState::Disabled;
        // debug, not info: this is the default, so an info line would add one entry
        // to every boot log saying nothing happened.
        log_debug!(
            "[ModelCatalog] MODELS_DEV_URL unset; using the bundled catalog (no outbound call)"
        );
        return;
    };

    *STATE.lock() = CatalogState::Pending;
    let started_at = now_ms();
    let controller = CancellationToken::new();
    *CONTROLLER.lock() = Some(controller.clone());

    let outcome = tokio::select! {
        _ = controller.cancelled() => Err(RefreshError::Canceled),
        fetched = tokio::time::timeout(
            Duration::from_millis(FETCH_TIMEOUT_MS),
            fetch_registry(&url),
        ) => match fetched {
            Ok(Ok(remote)) => Ok(remote),
            Ok(Err(error)) => Err(RefreshError::Failed(error)),
            Err(_) => Err(RefreshError::Timeout),
        },
    };

    match outcome {
        Ok(remote) => {
            let counts = install_remote_catalog(&remote);
            *STATE.lock() = CatalogState::Remote;

            let per_provider = remote
                .iter()
                .map(|(provider, models)| format!("{}={}", provider, models.len()))
                .collect::<Vec<_>>()
                .join(" ");
            log_info!(
                "[ModelCatalog] refreshed from models.dev in {}ms ({}, {} new, {} changed)",
                now_ms() - started_at,
                per_provider,
                counts.added,
                counts.changed
            );
            if counts.diverged > 0 {
                // Not rejected: a legitimate window upgrade (200k -> 1M) is a 5x jump,
                // so a rejection band would block the main thing this feature is for.
                // Surfaced so a bad upstream edit is at least visible.
                log_warn!(
                    "[ModelCatalog] {} model(s) diverge from the bundled catalog by more than 2x; regenerate the snapshot to review",
                    counts.diverged
                );
            }

            emit_outcome("remote", started_at, Some(&remote), Some(&counts), None);
        }
        // Our own abort means shutdown, which is not an outcome worth reporting.
        Err(RefreshError::Canceled) => {
            *STATE.lock() = CatalogState::Bundled;
            log_debug!("[ModelCatalog] refresh canceled");
        }
        Err(RefreshError::Failed(error)) if error.downcast_ref::<RejectedPayload>().is_some() => {
            *STATE.lock() = CatalogState::Failed;
            let rejected = error
                .downcast_ref::<RejectedPayload>()
                .expect("checked above");
            log_warn!(
                "[ModelCatalog] models.dev payload rejected ({}); using the bundled catalog",
                rejected.message
            );
            let outcome = if matches!(rejected.kind, FailureKind::Shape | FailureKind::Parse) {
                "rejected"
            } else {
                "failed"
            };
            emit_outcome(outcome, started_at, None, None, Some(rejected.kind));
        }
        Err(other) => {
            *STATE.lock() = CatalogState::Failed;
            let (kind, error) = match other {
                RefreshError::Timeout => (
                    FailureKind::Timeout,
                    anyhow::anyhow!("The operation was aborted due to timeout"),
                ),
                RefreshError::Failed(error) => (FailureKind::Network, error),
                RefreshError::Canceled => unreachable!("handled above"),
            };
            log_warn!(
                json!({ "err": err_json(&error) }),
                "[ModelCatalog] refresh failed; using the bundled catalog"
            );
            emit_outcome("failed", started_at, None, None, Some(kind));
        }
    }

    *CONTROLLER.lock() = None;
}

/// How a refresh ended without a catalog.
enum RefreshError {
    Canceled,
    Timeout,
    Failed(anyhow::Error),
}

/// The client for a direct fetch, which reads no proxy settings, as Node's `fetch` reads none.
static DIRECT_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("the HTTP client builds")
});

/// Abort an in-flight refresh. Safe to call when none is running.
pub fn cancel_model_catalog_refresh() {
    if let Some(controller) = CONTROLLER.lock().take() {
        controller.cancel();
    }
}

/// `GET url` with `accept: application/json` through the proxy dispatcher. A
/// non-2xx is `http` (`HTTP ${status}`), a declared length over `MAX_BODY_BYTES`
/// is `http` (`body declares ${n} bytes`), a content type without `json` is
/// `shape` (`content-type ${type || 'absent'}`), an unparseable body is `parse`
/// (`body is not valid JSON`), and a payload `reshape_registry` refuses is `shape`
/// (`no usable models for any configured provider`).
async fn fetch_registry(url: &str) -> anyhow::Result<ModelCatalog> {
    let client = match get_proxy_dispatcher().await {
        Some(proxied) => proxied,
        None => DIRECT_CLIENT.clone(),
    };

    let res = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        return Err(rejected(
            FailureKind::Http,
            format!("HTTP {}", status.as_u16()),
        ));
    }

    let declared = res
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    if let Some(declared) = declared
        && declared > MAX_BODY_BYTES
    {
        return Err(rejected(
            FailureKind::Http,
            format!("body declares {declared} bytes"),
        ));
    }

    // Not paranoia: a captive portal or proxy interstitial answers HTTP 200 with
    // HTML, which would otherwise reach the JSON parser as a confusing syntax error.
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !content_type.contains("json") {
        let shown = if content_type.is_empty() {
            "absent"
        } else {
            content_type.as_str()
        };
        return Err(rejected(
            FailureKind::Shape,
            format!("content-type {shown}"),
        ));
    }

    let raw: Value = match res.bytes().await {
        Ok(body) => match serde_json::from_slice(&body) {
            Ok(raw) => raw,
            Err(_) => {
                return Err(rejected(
                    FailureKind::Parse,
                    "body is not valid JSON".into(),
                ));
            }
        },
        Err(_) => {
            return Err(rejected(
                FailureKind::Parse,
                "body is not valid JSON".into(),
            ));
        }
    };

    reshape_registry(&raw).ok_or_else(|| {
        rejected(
            FailureKind::Shape,
            "no usable models for any configured provider".into(),
        )
    })
}

fn rejected(kind: FailureKind, message: String) -> anyhow::Error {
    anyhow::Error::new(RejectedPayload { kind, message })
}

/// The refresh's outcome event. Telemetry no-ops without an OTel logger, and
/// unlike the boot census these props are already in hand. A very fast shutdown
/// can settle this after the telemetry shutdown, losing the event.
///
/// Props: `catalog.outcome`, `catalog.duration_ms`, one `catalog.entries_${provider}`
/// per remote provider, `catalog.new_entries` / `catalog.changed_entries` /
/// `catalog.diverged_entries` with counts, and `catalog.failure_kind` — a closed
/// enum, never the raw error message, since an HTTP error can embed the proxy URL
/// and no URLs belong in telemetry.
fn emit_outcome(
    outcome: &str,
    started_at_ms: i64,
    remote: Option<&ModelCatalog>,
    counts: Option<&InstallResult>,
    kind: Option<FailureKind>,
) {
    let mut props: IndexMap<String, String> = IndexMap::new();
    props.insert("catalog.outcome".into(), outcome.to_string());
    props.insert(
        "catalog.duration_ms".into(),
        (now_ms() - started_at_ms).to_string(),
    );
    if let Some(remote) = remote {
        for (provider, models) in remote {
            props.insert(
                format!("catalog.entries_{provider}"),
                models.len().to_string(),
            );
        }
    }
    if let Some(counts) = counts {
        props.insert("catalog.new_entries".into(), counts.added.to_string());
        props.insert("catalog.changed_entries".into(), counts.changed.to_string());
        props.insert(
            "catalog.diverged_entries".into(),
            counts.diverged.to_string(),
        );
    }
    if let Some(kind) = kind {
        props.insert("catalog.failure_kind".into(), kind.as_str().to_string());
    }
    track_event("model catalog refreshed", None, Some(props));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BEDROCK_CHAT_DEFAULT: &str = "us.anthropic.claude-opus-5";

    /// A minimal models.dev-shaped payload.
    fn registry() -> Value {
        json!({
            "amazon-bedrock": {
                "models": {
                    "us.anthropic.claude-opus-5": { "limit": { "context": 1_000_000, "output": 128_000 } },
                    "amazon.titan-embed-text-v2:0": { "limit": { "context": 8_192, "output": 0 } },
                },
            },
            "azure": {
                "models": {
                    "claude-opus-5": { "limit": { "context": 1_000_000, "output": 128_000 } },
                },
            },
        })
    }

    fn entry(context: i64, output: Option<i64>) -> CatalogEntry {
        CatalogEntry { context, output }
    }

    fn catalog(provider: &str, entries: &[(&str, CatalogEntry)]) -> ModelCatalog {
        let mut models = IndexMap::new();
        for (id, entry) in entries {
            models.insert(id.to_string(), *entry);
        }
        let mut catalog = ModelCatalog::new();
        catalog.insert(provider.to_string(), models);
        catalog
    }

    #[test]
    #[serial_test::serial]
    fn serves_the_bundled_catalog_before_any_refresh() {
        reset_model_catalog();
        assert_eq!(*model_catalog(), *bundled_model_catalog());
        assert_eq!(model_catalog_state(), CatalogState::Bundled);
        let bedrock = &bundled_model_catalog()["bedrock"];
        assert!(!bedrock.is_empty());
        assert_eq!(bedrock[BEDROCK_CHAT_DEFAULT].context, 1_000_000);
    }

    #[test]
    fn keeps_claude_models_with_a_believable_window_in_the_claude_buckets() {
        assert!(is_usable_registry_entry(
            "claude-opus-5",
            &json!({ "limit": { "context": 1_000_000 } }),
            "azure"
        ));
        assert!(is_usable_registry_entry(
            "anthropic.claude-fable-5",
            &json!({ "limit": { "context": 200_000 } }),
            "amazon-bedrock"
        ));
    }

    #[test]
    fn drops_out_of_family_models_per_bucket() {
        assert!(!is_usable_registry_entry(
            "amazon.titan-embed-text-v2:0",
            &json!({ "limit": { "context": 8_192 } }),
            "amazon-bedrock"
        ));
        assert!(!is_usable_registry_entry(
            "gpt-5",
            &json!({ "limit": { "context": 400_000 } }),
            "azure"
        ));
        assert!(!is_usable_registry_entry(
            "claude-opus-5",
            &json!({ "limit": { "context": 1_000_000 } }),
            "openai"
        ));
    }

    #[test]
    fn keeps_gpt_o_series_and_codex_models_in_the_openai_bucket() {
        for id in ["gpt-5.6-sol", "o3-mini", "codex-mini-latest"] {
            assert!(is_usable_registry_entry(
                id,
                &json!({ "limit": { "context": 200_000 } }),
                "openai"
            ));
        }
    }

    #[test]
    fn drops_everything_for_an_unknown_registry_provider() {
        assert!(!is_usable_registry_entry(
            "claude-opus-5",
            &json!({ "limit": { "context": 1_000_000 } }),
            "acme"
        ));
    }

    #[test]
    fn drops_an_implausibly_small_or_missing_window() {
        for model in [
            json!({ "limit": { "context": 0 } }),
            json!({ "limit": { "context": -1 } }),
            json!({ "limit": { "context": 500 } }),
            json!({ "limit": {} }),
            json!({}),
        ] {
            assert!(!is_usable_registry_entry("claude-opus-5", &model, "azure"));
        }
        assert!(is_usable_registry_entry(
            "claude-opus-5",
            &json!({ "limit": { "context": MIN_PLAUSIBLE_CONTEXT } }),
            "azure"
        ));
    }

    #[test]
    fn scopes_per_provider_and_normalizes_a_missing_output() {
        let mut payload = registry();
        payload["azure"] =
            json!({ "models": { "claude-opus-5": { "limit": { "context": 1_000_000 } } } });
        let reshaped = reshape_registry(&payload).unwrap();
        assert_eq!(
            serde_json::to_value(&reshaped).unwrap(),
            json!({
                "bedrock": { "us.anthropic.claude-opus-5": { "context": 1_000_000, "output": 128_000 } },
                "azure": { "claude-opus-5": { "context": 1_000_000, "output": null } },
            })
        );
    }

    #[test]
    fn ignores_providers_it_is_not_configured_for() {
        let mut payload = registry();
        payload["openai"] =
            json!({ "models": { "claude-opus-5": { "limit": { "context": 1_000_000 } } } });
        let reshaped = reshape_registry(&payload).unwrap();
        assert_eq!(reshaped.keys().collect::<Vec<_>>(), ["bedrock", "azure"]);
    }

    #[test]
    fn omits_a_provider_that_yielded_nothing() {
        let mut payload = registry();
        payload["azure"] = json!({ "models": { "gpt-5": { "limit": { "context": 400_000 } } } });
        let reshaped = reshape_registry(&payload).unwrap();
        assert!(!reshaped.contains_key("azure"));
        assert!(reshaped.contains_key("bedrock"));
    }

    #[test]
    fn rejects_an_unusable_payload() {
        for payload in [
            Value::Null,
            json!([]),
            json!({}),
            json!("nope"),
            json!({ "openai": { "models": {} } }),
            json!({ "amazon-bedrock": { "models": { "gpt-5": { "limit": { "context": 9 } } } } }),
            json!({ "amazon-bedrock": { "models": "oops" } }),
        ] {
            assert!(reshape_registry(&payload).is_none(), "{payload}");
        }
    }

    #[test]
    #[serial_test::serial]
    fn lets_the_overlay_win_and_keeps_the_rest_of_the_floor() {
        reset_model_catalog();
        let azure_floor = bundled_model_catalog().get("azure").cloned();
        install_remote_catalog(&catalog(
            "bedrock",
            &[(BEDROCK_CHAT_DEFAULT, entry(2_000_000, Some(128_000)))],
        ));
        let effective = model_catalog();
        assert_eq!(
            effective["bedrock"][BEDROCK_CHAT_DEFAULT].context,
            2_000_000
        );
        assert_eq!(effective.get("azure").cloned(), azure_floor);
        assert_eq!(
            bundled_model_catalog()["bedrock"][BEDROCK_CHAT_DEFAULT].context,
            1_000_000
        );
        reset_model_catalog();
    }

    #[test]
    #[serial_test::serial]
    fn adds_a_model_the_bundle_has_never_heard_of() {
        reset_model_catalog();
        let result = install_remote_catalog(&catalog(
            "bedrock",
            &[(
                "us.anthropic.claude-brandnew-9",
                entry(5_000_000, Some(64_000)),
            )],
        ));
        assert_eq!(result.added, 1);
        assert_eq!(result.changed, 0);
        assert_eq!(
            model_catalog()["bedrock"]["us.anthropic.claude-brandnew-9"].context,
            5_000_000
        );
        assert!(!bundled_model_catalog()["bedrock"].contains_key("us.anthropic.claude-brandnew-9"));
        reset_model_catalog();
    }

    #[test]
    #[serial_test::serial]
    fn counts_a_large_divergence_separately_from_an_ordinary_change() {
        reset_model_catalog();
        let bedrock = &bundled_model_catalog()["bedrock"];
        let (other, other_entry) = bedrock
            .iter()
            .find(|(id, _)| id.as_str() != BEDROCK_CHAT_DEFAULT)
            .map(|(id, entry)| (id.clone(), *entry))
            .unwrap();
        let result = install_remote_catalog(&catalog(
            "bedrock",
            &[
                // 1M -> 900k: a real change, within the noise band.
                (BEDROCK_CHAT_DEFAULT, entry(900_000, Some(128_000))),
                // An order of magnitude down, worth a human look.
                (&other, entry(other_entry.context / 10, other_entry.output)),
            ],
        ));
        assert_eq!(result.changed, 2);
        assert_eq!(result.diverged, 1);
        reset_model_catalog();
    }

    #[test]
    #[serial_test::serial]
    fn does_not_count_an_identical_value_as_changed() {
        reset_model_catalog();
        let result = install_remote_catalog(&catalog(
            "bedrock",
            &[(BEDROCK_CHAT_DEFAULT, entry(1_000_000, Some(128_000)))],
        ));
        assert_eq!(result, InstallResult::default());
        reset_model_catalog();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn makes_no_outbound_call_without_a_url() {
        // CONFIG holds no MODELS_DEV_URL in tests.
        if CONFIG
            .models_dev_url
            .as_deref()
            .is_some_and(|url| !url.is_empty())
        {
            return;
        }
        reset_model_catalog();
        refresh_model_catalog().await;
        assert_eq!(model_catalog_state(), CatalogState::Disabled);
        reset_model_catalog();
    }
}
