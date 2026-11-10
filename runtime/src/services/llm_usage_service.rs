//! Token spend, read from `llm_calls`.
//!
//! The table holds one row per model call, written as the call returns, so a
//! suppressed heartbeat, a compaction and a classification gate all count.

use std::sync::LazyLock;

use diesel::dsl::count_star;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::CONFIG;
use crate::db::schema::llm_calls::dsl as l;
use crate::db::sql_types::DbDateTime;

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
        let since = DbDateTime(crate::support::from_ms(
            crate::support::now_ms() - window_hours * 60 * 60 * 1000,
        ));

        let Some(owner) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            return Ok(empty_usage(window_hours));
        };

        let (totals, per_model) = crate::db::read(move |conn| {
            // Counted inside the same aggregate, so the token total and the call
            // count come from one snapshot. Recording is fire-and-forget, so a call
            // can land between two reads.
            let totals: Totals = l::llm_calls
                .filter(l::agent_id.eq(&owner))
                .filter(l::created_at.ge(since))
                .select((
                    count_star(),
                    int_sum(l::total_tokens),
                    int_sum(l::input_tokens),
                    int_sum(l::output_tokens),
                    int_sum(l::cache_read_tokens),
                    int_sum(l::cache_write_tokens),
                    int_sum(l::no_cache_tokens),
                ))
                .get_result(conn)?;

            let per_model: Vec<PerModel> = l::llm_calls
                .filter(l::agent_id.eq(&owner))
                .filter(l::created_at.ge(since))
                .group_by(l::model)
                .select((
                    l::model,
                    count_star(),
                    int_sum(l::total_tokens),
                    int_sum(l::input_tokens),
                    int_sum(l::output_tokens),
                ))
                .load(conn)?;
            Ok((totals, per_model))
        })
        .await?;

        let mut by_model: Vec<ModelUsage> = per_model
            .into_iter()
            .map(|(model, calls, total, input, output)| ModelUsage {
                model,
                calls,
                total_tokens: total.unwrap_or(0),
                input_tokens: input.unwrap_or(0),
                output_tokens: output.unwrap_or(0),
            })
            .collect();
        by_model.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

        let (calls, total, input, output, cache_read, cache_write, no_cache) = totals;
        let cache_read_tokens = cache_read.unwrap_or(0);
        let cache_write_tokens = cache_write.unwrap_or(0);
        let no_cache_tokens = no_cache.unwrap_or(0);

        Ok(LlmUsageSummary {
            window_hours,
            total_tokens: total.unwrap_or(0),
            input_tokens: input.unwrap_or(0),
            output_tokens: output.unwrap_or(0),
            cache_read_tokens,
            cache_write_tokens,
            no_cache_tokens,
            cache_hit_percent: cache_hit_percent(
                cache_read_tokens,
                cache_write_tokens,
                no_cache_tokens,
            ),
            calls,
            by_model,
        })
    }
}

/// The window's call count and token sums; a sum is `None` over no rows.
type Totals = (
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

/// One model's call count and token sums.
type PerModel = (String, i64, Option<i64>, Option<i64>, Option<i64>);

#[diesel::declare_sql_function]
extern "SQL" {
    /// SQLite's `SUM` over an integer column, which it answers as an integer.
    #[aggregate]
    #[sql_name = "SUM"]
    fn int_sum(
        x: diesel::sql_types::BigInt,
    ) -> diesel::sql_types::Nullable<diesel::sql_types::BigInt>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewLlmCall;
    use crate::db::testing::test_db;

    fn call(model: &str, tokens: [i64; 6], age_ms: i64) -> NewLlmCall {
        let mut row = NewLlmCall::new("test-agent-id", "chat", model);
        row.total_tokens = tokens[0];
        row.input_tokens = tokens[1];
        row.output_tokens = tokens[2];
        row.cache_read_tokens = tokens[3];
        row.cache_write_tokens = tokens[4];
        row.no_cache_tokens = tokens[5];
        row.created_at = DbDateTime(crate::support::from_ms(crate::support::now_ms() - age_ms));
        row
    }

    fn insert(rows: Vec<NewLlmCall>) {
        for row in &rows {
            crate::services::memory_store::tests::ensure_agent(&row.agent_id);
        }
        crate::db::run_sync(move |conn| {
            diesel::insert_into(l::llm_calls)
                .values(&rows)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn cache_hit_rate_reads_the_three_details_and_null_for_unmeasured() {
        // 700 read of a 1000-token prompt (700+100+200), not of 1100.
        assert_eq!(cache_hit_percent(700, 100, 200), Some(70));
        assert_eq!(cache_hit_percent(0, 0, 0), None);
        assert_eq!(cache_hit_percent(0, 0, 1000), Some(0));
        assert_eq!(cache_hit_percent(1, 1, 0), Some(50));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sums_the_window_for_the_owner_and_breaks_it_down_by_model() {
        let _db = test_db();
        let day = 24 * 60 * 60 * 1000;
        let mut other_agent = call("small-model", [5, 5, 0, 0, 0, 0], 0);
        other_agent.agent_id = "someone-else".to_string();
        insert(vec![
            call("small-model", [300, 250, 50, 150, 50, 50], 0),
            call("large-model", [800, 750, 50, 550, 50, 150], 0),
            call("large-model", [999, 999, 0, 0, 0, 0], 2 * day),
            other_agent,
        ]);

        let summary = LLM_USAGE_SERVICE.summarize(24).await.unwrap();

        assert_eq!(summary.window_hours, 24);
        assert_eq!(summary.calls, 2);
        assert_eq!(
            (
                summary.total_tokens,
                summary.input_tokens,
                summary.output_tokens
            ),
            (1100, 1000, 100)
        );
        assert_eq!(summary.cache_hit_percent, Some(70));
        assert_eq!(
            summary.by_model,
            vec![
                ModelUsage {
                    model: "large-model".into(),
                    calls: 1,
                    total_tokens: 800,
                    input_tokens: 750,
                    output_tokens: 50
                },
                ModelUsage {
                    model: "small-model".into(),
                    calls: 1,
                    total_tokens: 300,
                    input_tokens: 250,
                    output_tokens: 50
                },
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn is_all_zeros_and_a_null_rate_on_an_empty_window() {
        let _db = test_db();
        let summary = LLM_USAGE_SERVICE.summarize(24).await.unwrap();
        assert_eq!(summary, empty_usage(24));
        assert_eq!(
            serde_json::to_string(&summary).unwrap(),
            r#"{"windowHours":24,"totalTokens":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"noCacheTokens":0,"cacheHitPercent":null,"calls":0,"byModel":[]}"#
        );
    }
}

impl Default for LlmUsageService {
    fn default() -> Self {
        Self::new()
    }
}

pub static LLM_USAGE_SERVICE: LazyLock<LlmUsageService> = LazyLock::new(LlmUsageService::new);
