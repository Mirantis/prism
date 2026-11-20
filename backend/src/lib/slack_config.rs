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
//!
//! In routed mode the token belongs to a proxy, which binds it to a workspace
//! when the agent is added to Slack. Until then `auth.test` answers
//! `invalid_auth`, and the connection stays absent until the router reports the
//! agent connected ([`reload_slack_config`]).

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, LazyLock};

use crate::config::CONFIG;
use crate::lib::slack_web_client::{SlackWebClient, WebClientOptions, slack_platform_error_code};
use crate::log_info;

/// How Slack events reach this runtime: over a Socket Mode connection of the
/// app's own, from a router through the `slack` listener, or not at all, which
/// leaves a bot token that only posts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlackMode {
    Socket,
    Routed,
    PostOnly,
}

impl SlackMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SlackMode::Socket => "socket",
            SlackMode::Routed => "routed",
            SlackMode::PostOnly => "post-only",
        }
    }
}

/// The mode the environment selects: `SLACK_APP_TOKEN` for Socket Mode, else
/// `SLACK_API_URL` for routed mode.
pub fn slack_mode() -> SlackMode {
    if std::env::var("SLACK_APP_TOKEN").is_ok_and(|token| !token.is_empty()) {
        return SlackMode::Socket;
    }
    if CONFIG.slack_api_url.is_some() {
        SlackMode::Routed
    } else {
        SlackMode::PostOnly
    }
}

/// The `auth.test` errors of a proxy token that is not bound to a workspace yet.
const UNBOUND_TOKEN_ERRORS: [&str; 2] = ["invalid_auth", "not_authed"];

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
    /// Bumped by every reload and clear. A load started before the bump neither
    /// fills the cache nor answers its callers with its own record: a
    /// `disconnected` envelope that lands while boot's `auth.test` is still out
    /// must not be undone when that call returns.
    generation: u64,
}

static CACHE: LazyLock<parking_lot::Mutex<SlackConfigCache>> =
    LazyLock::new(|| parking_lot::Mutex::new(SlackConfigCache::default()));

/// Validates `SLACK_BOT_TOKEN` and builds the record.
async fn load_from_env() -> anyhow::Result<Option<SlackConnectionRecord>> {
    load_with(
        CONFIG.slack_bot_token.as_deref(),
        CONFIG.slack_expected_app_id.as_deref(),
        slack_mode(),
    )
    .await
}

/// Validates `bot_token` and builds the record.
///
/// - No token: logs `[SlackConfig] SLACK_BOT_TOKEN not set — Slack disabled` and
///   answers `None`.
/// - `team_id` empty fails with `Failed to determine Slack workspace ID from bot
///   token`; `team` defaults to `Unknown Workspace`, `user_id` to `unknown`; a
///   missing `bot_id` fails with `Failed to determine Slack bot ID from bot token`.
/// - With `expected_app_id` set, `bots.info` must name an app
///   (`Failed to determine Slack app ID from bot token`) equal to it
///   (`Slack app ID mismatch: token is from app <appId>, expected <expected>`).
async fn load_with(
    bot_token: Option<&str>,
    expected_app_id: Option<&str>,
    mode: SlackMode,
) -> anyhow::Result<Option<SlackConnectionRecord>> {
    let Some(bot_token) = bot_token.filter(|token| !token.is_empty()) else {
        log_info!("[SlackConfig] SLACK_BOT_TOKEN not set — Slack disabled");
        return Ok(None);
    };

    // No local shape check: platform-injected credentials arrive as
    // `__nexus_cred:<uuid>__` sentinels that get rewritten to real tokens at
    // the MITM proxy on outbound Slack calls. auth.test() below is the real
    // validation — it goes through the proxy and sees the swapped-in token.
    //
    // Boot awaits this call, and nothing else in the process starts until it
    // resolves — the HTTP server included. The client is therefore bounded
    // (see BOUNDED_SLACK_CLIENT_OPTIONS); the SDK's own defaults would let one
    // hanging Slack request hold the port for ~30 minutes. A tighter deadline than
    // the shared default here: this is a JSON round trip with the port waiting on
    // it, not the file upload the default is sized for.
    let client = SlackWebClient::new(
        Some(bot_token),
        Some(WebClientOptions {
            timeout_ms: Some(10_000),
            ..WebClientOptions::default()
        }),
    );
    let auth_result = match client.auth_test().await {
        Ok(result) => result,
        Err(error) => {
            let unbound = slack_platform_error_code(&error)
                .is_some_and(|code| UNBOUND_TOKEN_ERRORS.contains(&code.as_str()));
            if unbound && mode == SlackMode::Routed {
                log_info!(
                    "[SlackConfig] the agent is not in a Slack workspace yet; Slack waits for the router"
                );
                return Ok(None);
            }
            return Err(error);
        }
    };
    let team_id = auth_result.team_id.unwrap_or_default();
    let team_name = auth_result
        .team
        .filter(|team| !team.is_empty())
        .unwrap_or_else(|| "Unknown Workspace".to_string());
    let bot_user_id = auth_result
        .user_id
        .filter(|user| !user.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    if team_id.is_empty() {
        anyhow::bail!("Failed to determine Slack workspace ID from bot token");
    }

    let Some(bot_id) = auth_result.bot_id.filter(|id| !id.is_empty()) else {
        anyhow::bail!("Failed to determine Slack bot ID from bot token");
    };

    // App-id safety check is optional — when unset, any app is accepted.
    if let Some(expected) = expected_app_id.filter(|id| !id.is_empty()) {
        let bots_info_result = client.bots_info(&bot_id).await?;
        let app_id = bots_info_result
            .bot
            .and_then(|bot| bot.app_id)
            .unwrap_or_default();
        if app_id.is_empty() {
            anyhow::bail!("Failed to determine Slack app ID from bot token");
        }
        if app_id != expected {
            anyhow::bail!("Slack app ID mismatch: token is from app {app_id}, expected {expected}");
        }
    }

    log_info!(
        json!({ "teamId": team_id, "teamName": team_name, "botUserId": bot_user_id }),
        "[SlackConfig] validated bot token from env"
    );

    Ok(Some(SlackConnectionRecord {
        id: team_id.clone(), // synthetic id — stable, unique per workspace
        team_id,
        team_name,
        bot_token: bot_token.to_string(),
        bot_id,
        bot_user_id,
        installed_at: crate::support::now_iso(),
        is_active: true,
    }))
}

/// Get the env-sourced Slack connection, cached after first successful load.
/// Returns `None` when `SLACK_BOT_TOKEN` is unset (Slack disabled), or while a
/// routed agent is in no Slack workspace.
/// Fails on validation failure so startup fails loudly; a failed load is not
/// cached, and every caller that waited on it gets the same error.
pub async fn get_slack_config() -> anyhow::Result<Option<SlackConnectionRecord>> {
    get_or_load(|| load_from_env().boxed()).await
}

/// The cached record, or the load in progress, or a new load from `load`.
async fn get_or_load(
    load: impl FnOnce() -> BoxFuture<'static, anyhow::Result<Option<SlackConnectionRecord>>>,
) -> anyhow::Result<Option<SlackConnectionRecord>> {
    let (inflight, generation) = {
        let mut cache = CACHE.lock();
        if let Some(cached) = &cache.cached {
            return Ok(cached.clone());
        }
        let generation = cache.generation;
        match &cache.inflight {
            Some(inflight) => (inflight.clone(), generation),
            None => {
                let started = load();
                let shared = async move {
                    let result = started.await.map_err(Arc::new);
                    let mut cache = CACHE.lock();
                    // A reload or a clear came after this load started: the
                    // newer state wins, and this load fills nothing.
                    if cache.generation == generation {
                        if let Ok(record) = &result {
                            cache.cached = Some(record.clone());
                        }
                        cache.inflight = None;
                    }
                    result
                }
                .boxed()
                .shared();
                cache.inflight = Some(shared.clone());
                (shared, generation)
            }
        }
    };
    let result = inflight.await;
    if CACHE.lock().generation != generation {
        return Box::pin(get_slack_config()).await;
    }
    result.map_err(|err| anyhow::anyhow!("{}", err))
}

/// Validate the token again: the router reported the agent added to a workspace.
pub async fn reload_slack_config() -> anyhow::Result<Option<SlackConnectionRecord>> {
    {
        let mut cache = CACHE.lock();
        cache.generation += 1;
        cache.cached = None;
        cache.inflight = None;
    }
    get_slack_config().await
}

/// Forget the connection: the router reported the agent removed from its workspace.
pub fn clear_slack_config() {
    let mut cache = CACHE.lock();
    cache.generation += 1;
    cache.cached = Some(None);
    cache.inflight = None;
}

/// Test-only: reset the cached singleton. Not for production use.
#[doc(hidden)]
pub fn __reset_slack_config_for_tests() {
    let mut cache = CACHE.lock();
    let generation = cache.generation + 1;
    *cache = SlackConfigCache {
        generation,
        ..SlackConfigCache::default()
    };
}

/// Test-only: the record every later `get_slack_config` answers.
#[cfg(test)]
pub(crate) fn set_slack_config_for_tests(record: Option<SlackConnectionRecord>) {
    let mut cache = CACHE.lock();
    let generation = cache.generation + 1;
    *cache = SlackConfigCache {
        cached: Some(record),
        inflight: None,
        generation,
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::slack_web_client::set_test_api_url;
    use crate::lib::slack_web_client::testing::fake_slack_api;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn answers(auth: Value, bots: Value) -> crate::lib::slack_web_client::testing::Handler {
        Arc::new(move |method, _| match method {
            "auth.test" => (200, auth.clone()),
            "bots.info" => (200, bots.clone()),
            _ => (404, json!({ "ok": false })),
        })
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_none_when_no_bot_token_is_set() {
        assert_eq!(
            load_with(None, None, SlackMode::Socket).await.unwrap(),
            None
        );
        assert_eq!(
            load_with(Some(""), None, SlackMode::Socket).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn passes_a_platform_credential_sentinel_unchanged() {
        let api = fake_slack_api(answers(
            json!({ "ok": true, "team_id": "T999", "team": "Sentinel Team", "user_id": "UBOT", "bot_id": "B999" }),
            json!({}),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let result = load_with(Some("__nexus_cred:abc-123__"), None, SlackMode::Socket).await;
        set_test_api_url(None);
        assert_eq!(result.unwrap().unwrap().team_id, "T999");
        // auth.test went out with the sentinel verbatim — the proxy swaps it on the wire.
        assert_eq!(
            api.calls("auth.test")[0]
                .headers
                .get("authorization")
                .unwrap(),
            "Bearer __nexus_cred:abc-123__"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn builds_the_record_from_auth_test_when_no_app_id_is_expected() {
        let api = fake_slack_api(answers(
            json!({ "ok": true, "team_id": "T123", "team": "Test Team", "user_id": "UBOT", "bot_id": "B123" }),
            json!({}),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let record = load_with(Some("xoxb-TEST"), None, SlackMode::Socket).await;
        set_test_api_url(None);
        let record = record.unwrap().unwrap();
        assert_eq!(
            record,
            SlackConnectionRecord {
                id: "T123".into(),
                team_id: "T123".into(),
                team_name: "Test Team".into(),
                bot_token: "xoxb-TEST".into(),
                bot_id: "B123".into(),
                bot_user_id: "UBOT".into(),
                installed_at: record.installed_at.clone(),
                is_active: true,
            }
        );
        assert!(crate::support::parse_iso(&record.installed_at).is_some());
        // bots.info is only called when the app-id check is enabled
        assert!(api.calls("bots.info").is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn validates_the_app_id_when_one_is_expected() {
        let api = fake_slack_api(answers(
            json!({ "ok": true, "team_id": "T123", "team": "Test Team", "user_id": "UBOT", "bot_id": "B123" }),
            json!({ "ok": true, "bot": { "app_id": "A_EXPECTED" } }),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let record = load_with(Some("xoxb-TEST"), Some("A_EXPECTED"), SlackMode::Socket).await;
        set_test_api_url(None);
        assert_eq!(record.unwrap().unwrap().team_id, "T123");
        assert_eq!(
            api.calls("bots.info")[0].field("bot").as_deref(),
            Some("B123")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_when_the_app_id_does_not_match() {
        let api = fake_slack_api(answers(
            json!({ "ok": true, "team_id": "T123", "team": "Test Team", "user_id": "UBOT", "bot_id": "B123" }),
            json!({ "ok": true, "bot": { "app_id": "A_OTHER" } }),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let err = load_with(Some("xoxb-TEST"), Some("A_EXPECTED"), SlackMode::Socket)
            .await
            .unwrap_err();
        set_test_api_url(None);
        assert_eq!(
            err.to_string(),
            "Slack app ID mismatch: token is from app A_OTHER, expected A_EXPECTED"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_when_auth_test_names_no_workspace() {
        let api = fake_slack_api(answers(
            json!({ "ok": true, "team_id": "", "bot_id": "B123" }),
            json!({}),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let err = load_with(Some("xoxb-TEST"), None, SlackMode::Socket)
            .await
            .unwrap_err();
        set_test_api_url(None);
        assert_eq!(
            err.to_string(),
            "Failed to determine Slack workspace ID from bot token"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_when_auth_test_names_no_bot() {
        let api = fake_slack_api(answers(
            json!({ "ok": true, "team_id": "T123", "team": "Test" }),
            json!({}),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let err = load_with(Some("xoxb-TEST"), None, SlackMode::Socket)
            .await
            .unwrap_err();
        set_test_api_url(None);
        assert_eq!(
            err.to_string(),
            "Failed to determine Slack bot ID from bot token"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn caches_the_result_after_the_first_load() {
        __reset_slack_config_for_tests();
        let loads = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let counter = loads.clone();
            get_or_load(move || {
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(None)
                }
                .boxed()
            })
            .await
            .unwrap();
        }
        __reset_slack_config_for_tests();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn does_not_cache_a_failed_load() {
        __reset_slack_config_for_tests();
        let failed = get_or_load(|| async { anyhow::bail!("boom") }.boxed()).await;
        assert_eq!(failed.unwrap_err().to_string(), "boom");
        let loaded = get_or_load(|| async { Ok(None) }.boxed()).await.unwrap();
        __reset_slack_config_for_tests();
        assert_eq!(loaded, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_routed_token_not_bound_to_a_workspace_yet_is_no_connection() {
        let api = fake_slack_api(answers(
            json!({ "ok": false, "error": "invalid_auth" }),
            json!({ "ok": true }),
        ))
        .await;
        set_test_api_url(Some(api.url.clone()));
        let routed = load_with(Some("xoxb-PROXY"), None, SlackMode::Routed).await;
        let socket = load_with(Some("xoxb-TEST"), None, SlackMode::Socket).await;
        set_test_api_url(None);
        assert_eq!(routed.unwrap(), None);
        assert!(socket.unwrap_err().to_string().contains("invalid_auth"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_clear_during_a_load_wins_over_the_load() {
        __reset_slack_config_for_tests();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let load = tokio::spawn(get_or_load(move || {
            async move {
                let _ = released.await;
                Ok(Some(SlackConnectionRecord {
                    id: "T1".into(),
                    team_id: "T1".into(),
                    team_name: "Acme".into(),
                    bot_token: "xoxb".into(),
                    bot_id: "B1".into(),
                    bot_user_id: "U1".into(),
                    installed_at: String::new(),
                    is_active: true,
                }))
            }
            .boxed()
        }));
        tokio::task::yield_now().await;
        clear_slack_config();
        release.send(()).unwrap();
        let answered = load.await.unwrap().unwrap();
        let cached = get_slack_config().await.unwrap();
        __reset_slack_config_for_tests();
        assert_eq!(answered, None);
        assert_eq!(cached, None);
    }
}
