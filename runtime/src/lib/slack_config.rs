//! Slack Config
//!
//! Slack configuration comes from env (`SLACK_BOT_TOKEN`). At first access
//! we validate the token via Slack's `auth.test` + `bots.info` and cache
//! the resulting [`SlackConnectionRecord`] singleton. Downstream services
//! (`slack_adapter_service`, `slack_mapping_service`, `slack_thread_provider`)
//! consume the same shape.
//!
//! If `SLACK_EXPECTED_APP_ID` is set, the bot token's `app_id` must match.
//! Unset means "any app accepted".

use futures::future::{BoxFuture, Shared};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackConnectionRecord {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub bot_token: String,
    pub bot_id: String,
    pub bot_user_id: String,
    /// ISO text of when the record was built.
    pub installed_at: String,
    pub is_active: bool,
}

/// One load from env, shared by every caller that arrives while it runs. The
/// error is shared too, so it is behind an `Arc`.
type SlackConfigLoad =
    Shared<BoxFuture<'static, Result<Option<SlackConnectionRecord>, Arc<anyhow::Error>>>>;

#[derive(Default)]
struct SlackConfigCache {
    /// `None` until a load succeeds; then its result, `Some(None)` when Slack is
    /// disabled.
    cached: Option<Option<SlackConnectionRecord>>,
    /// The load in progress, cleared when it settles.
    inflight: Option<SlackConfigLoad>,
}

static CACHE: LazyLock<parking_lot::Mutex<SlackConfigCache>> =
    LazyLock::new(|| parking_lot::Mutex::new(SlackConfigCache::default()));

/// Validates `SLACK_BOT_TOKEN` and builds the record.
///
/// - No token: logs `[SlackConfig] SLACK_BOT_TOKEN not set — Slack disabled` and
///   answers `None`.
/// - No local shape check: platform-injected credentials arrive as
///   `__nexus_cred:<uuid>__` sentinels that get rewritten to real tokens at the
///   MITM proxy on outbound Slack calls. `auth.test` is the real validation — it
///   goes through the proxy and sees the swapped-in token.
/// - Boot awaits this call, and nothing else in the process starts until it
///   resolves — the HTTP server included. The client is bounded
///   (`BOUNDED_SLACK_CLIENT_OPTIONS`) with a tighter 10 s deadline here: this is a
///   JSON round trip with the port waiting on it, not the file upload the default
///   is sized for.
/// - `team_id` empty fails with `Failed to determine Slack workspace ID from bot
///   token`; `team` defaults to `Unknown Workspace`, `user_id` to `unknown`; a
///   missing `bot_id` fails with `Failed to determine Slack bot ID from bot token`.
/// - With `slack_expected_app_id` set, `bots.info` must name an app
///   (`Failed to determine Slack app ID from bot token`) equal to it
///   (`Slack app ID mismatch: token is from app <appId>, expected <expected>`).
/// - Logs `{ teamId, teamName, botUserId }` `[SlackConfig] validated bot token from
///   env`, and answers the record with `id` = `team_id` (synthetic — stable, unique
///   per workspace), `installed_at` = now, `is_active` = true.
async fn load_from_env() -> anyhow::Result<Option<SlackConnectionRecord>> {
    todo!()
}

/// Get the env-sourced Slack connection, cached after first successful load.
/// Returns `None` when `SLACK_BOT_TOKEN` is unset (Slack disabled).
/// Fails on validation failure so startup fails loudly; a failed load is not
/// cached, and every caller that waited on it gets the same error.
pub async fn get_slack_config() -> anyhow::Result<Option<SlackConnectionRecord>> {
    todo!()
}

/// Test-only: reset the cached singleton. Not for production use.
#[doc(hidden)]
pub fn __reset_slack_config_for_tests() {
    *CACHE.lock() = SlackConfigCache::default();
}
