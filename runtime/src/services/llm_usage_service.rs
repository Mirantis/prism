//! Token spend, read from `llm_calls`.
//!
//! The table holds one row per model call, written as the call returns, so a
//! suppressed heartbeat, a compaction and a classification gate all count.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsageSummary {
    pub window_hours: i64,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub no_cache_tokens: i64,
    /// Share of the prompt served from cache, 0-100. `None` where nothing in the
    /// window reported a cache breakdown.
    pub cache_hit_percent: Option<i64>,
    /// Model calls in the window: one per step of a turn, plus each gate,
    /// compaction and thread title.
    pub calls: i64,
    /// The same window per model, most tokens first.
    pub by_model: Vec<ModelUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub calls: i64,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Zeros and a null rate, for a runtime with no agent resolved yet.
fn empty_usage(window_hours: i64) -> LlmUsageSummary {
    LlmUsageSummary {
        window_hours,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        no_cache_tokens: 0,
        cache_hit_percent: None,
        calls: 0,
        by_model: Vec::new(),
    }
}

/// `Math.round((read / prompt) * 100)`, or `None` when nothing reported a
/// breakdown. The three details are the prompt, so they are the denominator;
/// `input_tokens` already includes the cache reads and writes.
fn cache_hit_percent(
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    no_cache_tokens: i64,
) -> Option<i64> {
    let prompt = cache_read_tokens + cache_write_tokens + no_cache_tokens;
    if prompt <= 0 {
        return None;
    }
    Some(((cache_read_tokens as f64 / prompt as f64) * 100.0 + 0.5).floor() as i64)
}

pub struct LlmUsageService;

impl LlmUsageService {
    pub fn new() -> Self {
        LlmUsageService
    }

    /// Token usage for the window ending now.
    ///
    /// Filters on the owning agent alone: subagent work is already recorded
    /// against the owner, with the child kept in `subagentId` for provenance.
    /// The totals and the call count come from one aggregate, so they read one
    /// snapshot; the per-model rows are sorted by total tokens, most first.
    pub async fn summarize(&self, window_hours: i64) -> anyhow::Result<LlmUsageSummary> {
        todo!()
    }
}

impl Default for LlmUsageService {
    fn default() -> Self {
        Self::new()
    }
}

pub static LLM_USAGE_SERVICE: LazyLock<LlmUsageService> = LazyLock::new(LlmUsageService::new);
