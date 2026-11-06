//! Slack Connection Source
//!
//! Thin passthrough over `slack_config` (env-sourced Slack connection).
//! Call sites (`slack_adapter_service`, `slack_mapping_service`,
//! `slack_thread_provider`) import from here to keep the indirection
//! available if we ever need a non-env source again.

use crate::lib::slack_config::get_slack_config;

pub use crate::lib::slack_config::SlackConnectionRecord;

pub async fn get_active_slack_connections() -> anyhow::Result<Vec<SlackConnectionRecord>> {
    let cfg = get_slack_config().await?;
    Ok(cfg.into_iter().collect())
}

pub async fn get_slack_connection() -> anyhow::Result<Option<SlackConnectionRecord>> {
    // Exactly one connection in this runtime. Legacy mappings persisted a
    // SlackMapping.connectionId that may or may not match the current
    // token's teamId — return the singleton either way since there's
    // nowhere else the token could have come from.
    get_slack_config().await
}
