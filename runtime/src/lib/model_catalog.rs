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
use serde_json::Value;
use tokio_util::sync::CancellationToken;

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
                    if ratio > DIVERGENCE_FACTOR || ratio < 1.0 / DIVERGENCE_FACTOR {
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
    todo!()
}

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
async fn fetch_registry(url: &str, signal: &CancellationToken) -> anyhow::Result<ModelCatalog> {
    todo!()
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
    todo!()
}
