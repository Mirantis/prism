//! Resolve a model ID to its input-context window, for the context-window
//! indicator.
//!
//! Why models.dev is the source: the window is not discoverable from either
//! provider this runtime talks to. Anthropic's Models API — the only source of
//! `max_input_tokens` — is first-party only (unavailable on both Bedrock and
//! Microsoft Foundry), and Bedrock's `GetFoundationModel` returns modalities and
//! lifecycle but no context length.
//!
//! This module is a pure resolver; `lib/model_catalog.rs` owns the data as two
//! layers — a bundled floor that always answers, plus an overlay fetched once at
//! boot when `MODELS_DEV_URL` opts into it, so a newly-released model isn't
//! unmeasurable until the next release. Reads here are synchronous, which is what
//! lets an unfinished refresh fall back to the floor for free.
//!
//! Unknown IDs return `None` rather than a guess. A wrong window silently
//! misreports how much room is left, which is worse than showing nothing — so
//! callers must render nothing when this returns `None`.

use std::sync::LazyLock;

use indexmap::IndexSet;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::CONFIG;
use crate::lib::model_catalog::model_catalog;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextWindow {
    /// Max input tokens the model accepts.
    pub tokens: i64,
}

/// One thread's context occupancy, as measured by a single turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageSnapshot {
    pub thread_id: String,
    /// The model that actually ran — may differ from the agent's configured model.
    pub model_id: String,
    pub used_tokens: i64,
    pub window_tokens: i64,
    /// Share of the window consumed, as an integer 0-100. Clamped, so an
    /// overflowing prompt reads 100 rather than something above it.
    ///
    /// Emitted as *consumed* rather than remaining because that's what both clients
    /// render, so neither needs arithmetic and the figure agrees exactly with the
    /// raw token counts shown beside it.
    pub used_percent: i64,
}

/// Derive a snapshot from a raw measurement, or `None` when it can't be expressed
/// as a percentage (no measurement, or an unrecognized model).
///
/// Pure, and deliberately lives here rather than on the context usage service:
/// both the live path and the stored-thread read path need it, and the service
/// already depends on the conversation service — putting it there would make that
/// a cycle.
pub fn build_context_snapshot(
    thread_id: &str,
    model_id: Option<&str>,
    used_tokens: Option<i64>,
) -> Option<ContextUsageSnapshot> {
    let model_id = model_id.filter(|id| !id.is_empty())?;
    let used_tokens = used_tokens?;

    let window = context_window_for(model_id)?;

    let used_percent = ((100 * used_tokens) as f64 / window.tokens as f64).round() as i64;
    Some(ContextUsageSnapshot {
        thread_id: thread_id.to_string(),
        model_id: model_id.to_string(),
        used_tokens,
        window_tokens: window.tokens,
        used_percent: used_percent.clamp(0, 100),
    })
}

/// Bedrock cross-region inference profiles prefix the model ID with a geo scope
/// (`us.`, `eu.`, `au.`, `jp.`, `global.`). models.dev lists most of these
/// explicitly, but new geos appear before the registry catches up, so strip a known
/// prefix and retry rather than going dark on `sa.anthropic.claude-opus-5`.
static REGION_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:us|eu|apac|au|jp|ca|sa|global)\.").unwrap());

/// Bedrock version suffixes (`-v1:0`, `-v2:1`, `-v1`) that some ID spellings omit.
static VERSION_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-v\d+(?::\d+)?$").unwrap());

static ANTHROPIC_SEGMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^anthropic\.").unwrap());

/// The input-context window for `model_id`, or `None` when it can't be determined.
///
/// `model_id` must be the *resolved* model — what `invoke_stream()` actually passed
/// to the provider — so per-agent and per-scope (heartbeat/cron) overrides are
/// covered without any scope-specific handling here.
pub fn context_window_for(model_id: &str) -> Option<ContextWindow> {
    if model_id.is_empty() {
        return None;
    }

    // An operator-set window wins over the registry.
    if let Some(tokens) = CONFIG.context_window_tokens
        && tokens > 0
    {
        return Some(ContextWindow { tokens });
    }

    // Read the catalog once: it's the bundled floor plus any overlay the boot-time
    // refresh installed, already merged, so this is a plain lookup.
    let catalog = model_catalog();

    // Prefer the active provider's own entry. Every `context` value in the bundled
    // floor happens to agree across providers and regions, so this preference is not
    // yet observable there — but the registry tracks them separately and they do
    // diverge in practice, and a remote overlay can introduce a context divergence
    // at any time.
    let active = CONFIG.llm_provider.as_str();
    let preferred = catalog.get(active);
    let others = catalog
        .iter()
        .filter(|(provider, _)| provider.as_str() != active)
        .map(|(_, models)| models);
    let ordered: Vec<_> = preferred.into_iter().chain(others).collect();

    for candidate in id_candidates(model_id) {
        // Exact provider match first, then the other provider(s) as a fallback — an
        // operator can point LLM_PROVIDER=azure at a Bedrock-style ID.
        for models in &ordered {
            if let Some(hit) = models.get(&candidate) {
                return Some(ContextWindow {
                    tokens: hit.context,
                });
            }
        }
    }

    None
}

/// `model_id` plus progressively-normalized spellings, most specific first.
fn id_candidates(model_id: &str) -> Vec<String> {
    let mut seen: IndexSet<String> = IndexSet::new();
    let bare = REGION_PREFIX.replace(model_id, "").into_owned();
    let without_vendor = ANTHROPIC_SEGMENT.replace(&bare, "").into_owned();

    for id in [
        model_id.to_string(),
        bare.clone(),
        VERSION_SUFFIX.replace(model_id, "").into_owned(),
        VERSION_SUFFIX.replace(&bare, "").into_owned(),
        // Azure deployment names are bare (`claude-opus-5`) while Bedrock IDs have
        // an `anthropic.` vendor segment; try across that boundary too.
        without_vendor.clone(),
        VERSION_SUFFIX.replace(&without_vendor, "").into_owned(),
    ] {
        if !id.is_empty() {
            seen.insert(id);
        }
    }

    seen.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::model_catalog::reset_model_catalog;

    // The IDs the configuration defaults to. If the models.dev snapshot stops
    // covering these, the indicator disappears for every default deployment.
    const BEDROCK_CHAT_DEFAULT: &str = "global.anthropic.claude-opus-5-5";
    const AZURE_CHAT_DEFAULT: &str = "claude-opus-5";
    const OPENAI_CHAT_DEFAULT: &str = "gpt-5.6-sol";
    const OPENAI_CLASSIFICATION_DEFAULT: &str = "gpt-5.6-luna";

    /// The lookups below read the bundled floor; an operator-set window replaces it.
    fn window(model_id: &str) -> Option<i64> {
        reset_model_catalog();
        context_window_for(model_id).map(|window| window.tokens)
    }

    fn without_override() -> bool {
        CONFIG.context_window_tokens.is_none()
    }

    #[test]
    #[serial_test::serial]
    fn resolves_the_runtime_defaults() {
        if !without_override() {
            return;
        }
        assert_eq!(window(BEDROCK_CHAT_DEFAULT), Some(1_000_000));
        assert_eq!(window(AZURE_CHAT_DEFAULT), Some(1_000_000));
        assert_eq!(window(OPENAI_CHAT_DEFAULT), Some(1_050_000));
        assert_eq!(window(OPENAI_CLASSIFICATION_DEFAULT), Some(1_050_000));
    }

    #[test]
    #[serial_test::serial]
    fn normalizes_region_prefixes_and_version_suffixes() {
        if !without_override() {
            return;
        }
        // `sa.` is a plausible future geo the registry does not list yet.
        assert_eq!(window("sa.anthropic.claude-opus-5"), Some(1_000_000));
        assert_eq!(window("us.anthropic.claude-opus-5-v1:0"), Some(1_000_000));
        // Cross-provider fallback: either spelling of a known model resolves.
        assert_eq!(window("claude-haiku-4-5"), Some(200_000));
        assert_eq!(window("us.anthropic.claude-opus-5"), Some(1_000_000));
    }

    #[test]
    #[serial_test::serial]
    fn resolves_each_region_spelling_and_a_model_only_one_provider_lists() {
        if !without_override() {
            return;
        }
        for region in ["us", "eu", "au", "jp", "global"] {
            assert_eq!(
                window(&format!("{region}.anthropic.claude-sonnet-4-6")),
                Some(1_000_000)
            );
        }
        assert_eq!(window("claude-opus-4-6"), Some(1_000_000));
    }

    #[test]
    #[serial_test::serial]
    fn knows_no_window_for_an_unknown_model() {
        if !without_override() {
            return;
        }
        assert_eq!(window("my-opus-deploy"), None);
        assert_eq!(window("amazon.titan-embed-text-v2:0"), None);
        assert_eq!(window(""), None);
    }

    #[test]
    #[serial_test::serial]
    fn builds_a_snapshot_against_the_models_window() {
        if !without_override() {
            return;
        }
        reset_model_catalog();
        let snapshot =
            build_context_snapshot("thread-1", Some(BEDROCK_CHAT_DEFAULT), Some(250_000)).unwrap();
        assert_eq!(snapshot.window_tokens, 1_000_000);
        assert_eq!(snapshot.used_percent, 25);
        let overflow =
            build_context_snapshot("thread-1", Some(BEDROCK_CHAT_DEFAULT), Some(2_000_000))
                .unwrap();
        assert_eq!(overflow.used_percent, 100);
        assert!(build_context_snapshot("thread-1", Some("my-opus-deploy"), Some(1)).is_none());
        assert!(build_context_snapshot("thread-1", None, Some(1)).is_none());
        assert!(build_context_snapshot("thread-1", Some(BEDROCK_CHAT_DEFAULT), None).is_none());
    }
}
