//! Session Manager Service
//!
//! Manages agent session lifecycle:
//! - Daily reset at user-configured time (dailyResetHour)
//! - Optional idle timeout
//! - Unique session ID generation
//!
//! Session Rules (from molt.bot):
//! 1. DAILY RESET - Fresh context each day at dailyResetHour
//! 2. IDLE TIMEOUT - Optional sliding window reset on inactivity
//! 3. MANUAL RESET - User can explicitly start fresh
//!
//! Memory always persists across sessions; only conversation resets.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::anyhow;
use chrono::{DateTime, Timelike, Utc};
use diesel::prelude::*;
use parking_lot::Mutex;
use serde_json::json;
use tokio::task::AbortHandle;

use crate::config::{CONFIG, ThreadMode};
use crate::db::models::{AgentType, AgentWorkspace, AgentWorkspaceChangeset};
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::lib::log_redaction::err_json;
use crate::lib::timezone::resolve_timezone;
use crate::services::conversation_service::{CONVERSATION_SERVICE, StartThreadOptions};
use crate::support::js;
use crate::{log_error, log_info, log_warn};

// ============================================================================
// Types
// ============================================================================

struct SessionState {
    session_id: String,
    daily_reset_timeout: Option<AbortHandle>,
    idle_timeout: Option<AbortHandle>,
    last_activity: DateTime<Utc>,
}

impl SessionState {
    fn new(session_id: String) -> Self {
        SessionState {
            session_id,
            daily_reset_timeout: None,
            idle_timeout: None,
            last_activity: Utc::now(),
        }
    }
}

/// Why a session is reset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResetReason {
    Daily,
    Idle,
    #[default]
    Manual,
}

impl ResetReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ResetReason::Daily => "daily",
            ResetReason::Idle => "idle",
            ResetReason::Manual => "manual",
        }
    }
}

crate::support::display_as_str!(ResetReason);

/// Spawn `work` after `ms`, and answer the handle that cancels it.
fn after(ms: i64, work: impl std::future::Future<Output = ()> + Send + 'static) -> AbortHandle {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms.max(0) as u64)).await;
        work.await;
    })
    .abort_handle()
}

// ============================================================================
// Session Manager Service
// ============================================================================

pub struct SessionManagerService {
    sessions: Mutex<HashMap<String, SessionState>>,
    is_initialized: AtomicBool,
}

impl SessionManagerService {
    pub fn new() -> Self {
        SessionManagerService {
            sessions: Mutex::new(HashMap::new()),
            is_initialized: AtomicBool::new(false),
        }
    }

    /// Initialize session manager for all existing agents. Single-thread mode
    /// schedules no resets: a reset's whole effect is a new conversation, and
    /// single-thread mode keeps one.
    pub async fn initialize(&'static self) {
        if self.is_initialized.load(Ordering::SeqCst) {
            log_info!("Session manager already initialized");
            return;
        }

        // A reset's whole effect is a new conversation, and single-thread mode keeps one.
        if CONFIG.thread_mode == ThreadMode::Single {
            log_info!("Single-thread mode: no daily or idle session resets");
            self.is_initialized.store(true, Ordering::SeqCst);
            return;
        }

        log_info!("Initializing session manager...");

        let initialized: anyhow::Result<usize> = async {
            // Get all agents
            let agents = crate::db::run(|conn| {
                Ok(aw::agent_workspaces
                    .select(AgentWorkspace::as_select())
                    .load(conn)?)
            })
            .await?;

            // Set up daily reset schedules for each agent
            for agent in &agents {
                self.schedule_daily_reset(&agent.user_id, agent.daily_reset_hour, &agent.timezone)?;

                // Track current session
                if let Some(session_id) = &agent.current_session_id {
                    self.sessions
                        .lock()
                        .insert(agent.user_id.clone(), SessionState::new(session_id.clone()));
                }
            }
            Ok(agents.len())
        }
        .await;

        match initialized {
            Ok(count) => {
                self.is_initialized.store(true, Ordering::SeqCst);
                log_info!("Session manager initialized for {} agent(s)", count);
            }
            Err(err) => {
                log_error!("Failed to initialize session manager: {}", err);
            }
        }
    }

    /// Start or resume a session for a user.
    /// Returns the current session ID.
    pub async fn start_session(&'static self, user_id: &str) -> anyhow::Result<String> {
        let agent = self.get_agent_by_user_id(user_id).await?;
        let has_state = self.sessions.lock().contains_key(user_id);

        // If no session or session is stale, create new one
        if !has_state || agent.current_session_id.is_none() {
            let session_id = self.generate_session_id();
            self.write_session_id(&agent.id, &session_id).await?;

            self.sessions
                .lock()
                .insert(user_id.to_string(), SessionState::new(session_id.clone()));
            log_info!("Started new session {} for user {}", session_id, user_id);

            // Set up daily reset
            self.schedule_daily_reset(user_id, agent.daily_reset_hour, &agent.timezone)?;

            // Set up idle timeout if configured
            if let Some(minutes) = agent.idle_timeout_mins.filter(|minutes| *minutes != 0) {
                self.start_idle_timeout(user_id, minutes);
            }
            return Ok(session_id);
        }

        // Update last activity, and restart the idle timeout if configured
        let (session_id, restart) = {
            let mut sessions = self.sessions.lock();
            let state = sessions
                .get_mut(user_id)
                .ok_or_else(|| anyhow!("No session for user {user_id}"))?;
            state.last_activity = Utc::now();
            let restart = agent
                .idle_timeout_mins
                .filter(|minutes| *minutes != 0)
                .filter(|_| match &state.idle_timeout {
                    Some(handle) => {
                        handle.abort();
                        true
                    }
                    None => false,
                });
            (state.session_id.clone(), restart)
        };
        if let Some(minutes) = restart {
            self.start_idle_timeout(user_id, minutes);
        }
        Ok(session_id)
    }

    /// Record activity for a user (resets idle timeout)
    pub fn record_activity(&'static self, user_id: &str) {
        let restart = {
            let mut sessions = self.sessions.lock();
            let Some(state) = sessions.get_mut(user_id) else {
                return;
            };
            state.last_activity = Utc::now();

            // Restart idle timeout if active
            match &state.idle_timeout {
                Some(handle) => {
                    handle.abort();
                    true
                }
                None => false,
            }
        };
        if restart {
            // Re-fetch agent to get idle timeout
            let user_id = user_id.to_string();
            tokio::spawn(async move {
                if let Err(err) = self.restart_idle_timeout(&user_id).await {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "Failed to restart the idle timeout for user {}",
                        user_id
                    );
                }
            });
        }
    }

    /// Reset session (manual or automatic).
    /// Starts a fresh conversation thread (which becomes the latest), carrying the
    /// current thread's workspace root forward.
    pub async fn reset_session(
        &self,
        user_id: &str,
        reason: ResetReason,
    ) -> anyhow::Result<String> {
        log_info!(
            "Resetting session for user {} (reason: {})",
            user_id,
            reason
        );

        let agent = self.get_agent_by_user_id(user_id).await?;

        // Start a fresh thread so the next message opens a clean conversation.
        // Carry the current thread's workspaceRoot forward — daily/idle resets can
        // fire while a CLI session is connected, and the CLI only sends its cwd
        // once per launch; without this the agent would silently fall back to the
        // global SHELL_WORKSPACE_ROOT after a reset.
        let started: anyhow::Result<()> = async {
            let latest = CONVERSATION_SERVICE
                .find_latest_web_thread(&agent.id, user_id)
                .await?;
            CONVERSATION_SERVICE
                .start_new_thread(
                    &agent.id,
                    user_id,
                    Some(StartThreadOptions {
                        workspace_root: latest.and_then(|thread| thread.workspace_root),
                    }),
                )
                .await?;
            Ok(())
        }
        .await;
        if started.is_err() {
            log_warn!(
                "Failed to start a new thread on session reset for user {}",
                user_id
            );
        }

        // Generate new session ID
        let new_session_id = self.generate_session_id();
        self.write_session_id(&agent.id, &new_session_id).await?;

        // Update local state
        {
            let mut sessions = self.sessions.lock();
            match sessions.get_mut(user_id) {
                Some(state) => {
                    state.session_id = new_session_id.clone();
                    state.last_activity = Utc::now();
                }
                None => {
                    sessions.insert(
                        user_id.to_string(),
                        SessionState::new(new_session_id.clone()),
                    );
                }
            }
        }

        log_info!(
            "Created new session {} for user {}",
            new_session_id,
            user_id
        );
        Ok(new_session_id)
    }

    /// Get current session ID for a user
    pub fn get_session_id(&self, user_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .get(user_id)
            .map(|state| state.session_id.clone())
            .filter(|id| !id.is_empty())
    }

    /// Check if user has an active session
    pub fn has_active_session(&self, user_id: &str) -> bool {
        self.sessions.lock().contains_key(user_id)
    }

    /// Schedule daily reset for a user. Fails on a time zone that is not one.
    fn schedule_daily_reset(
        &'static self,
        user_id: &str,
        reset_hour: i64,
        timezone: &str,
    ) -> anyhow::Result<()> {
        // Clear existing timeout
        if let Some(handle) = self
            .sessions
            .lock()
            .get(user_id)
            .and_then(|state| state.daily_reset_timeout.as_ref())
        {
            handle.abort();
        }

        // Calculate time until next reset
        let ms_until_reset = self.calculate_ms_until_reset(reset_hour, timezone)?;

        let timeout = {
            let user_id = user_id.to_string();
            let timezone = timezone.to_string();
            after(ms_until_reset, async move {
                if let Err(err) = self.reset_session(&user_id, ResetReason::Daily).await {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "Failed to reset the session for user {}",
                        user_id
                    );
                    return;
                }
                // Schedule next daily reset
                if let Err(err) = self.schedule_daily_reset(&user_id, reset_hour, &timezone) {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "Failed to schedule the daily reset for user {}",
                        user_id
                    );
                }
            })
        };

        // Update state
        if let Some(state) = self.sessions.lock().get_mut(user_id) {
            state.daily_reset_timeout = Some(timeout);
        }

        let hours_until = js::round(ms_until_reset as f64 / (1000.0 * 60.0 * 60.0) * 10.0) / 10.0;
        log_info!(
            "Scheduled daily reset for user {} in {} hours",
            user_id,
            js::number_text(hours_until)
        );
        Ok(())
    }

    /// Calculate milliseconds until next reset hour
    fn calculate_ms_until_reset(&self, reset_hour: i64, timezone: &str) -> anyhow::Result<i64> {
        let zone = resolve_timezone(timezone)
            .ok_or_else(|| anyhow!("Invalid time zone specified: {timezone}"))?;
        // Get current time in user's timezone
        let user_time = Utc::now().with_timezone(&zone);
        Ok(ms_until_reset(
            reset_hour,
            user_time.hour() as i64,
            user_time.minute() as i64,
            user_time.second() as i64,
        ))
    }

    /// Start idle timeout for a user
    fn start_idle_timeout(&'static self, user_id: &str, idle_timeout_mins: i64) {
        let mut sessions = self.sessions.lock();
        let Some(state) = sessions.get_mut(user_id) else {
            return;
        };

        // Clear existing timeout
        if let Some(handle) = &state.idle_timeout {
            handle.abort();
        }

        let timeout_ms = idle_timeout_mins * 60 * 1000;

        let owner = user_id.to_string();
        state.idle_timeout = Some(after(timeout_ms, async move {
            log_info!("Idle timeout reached for user {}", owner);
            if let Err(err) = self.reset_session(&owner, ResetReason::Idle).await {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "Failed to reset the session for user {}",
                    owner
                );
            }
        }));
        drop(sessions);

        log_info!(
            "Started idle timeout for user {}: {} minutes",
            user_id,
            idle_timeout_mins
        );
    }

    /// Restart idle timeout after activity
    async fn restart_idle_timeout(&'static self, user_id: &str) -> anyhow::Result<()> {
        let owner = user_id.to_string();
        let minutes: Option<Option<i64>> = crate::db::run(move |conn| {
            Ok(aw::agent_workspaces
                .filter(aw::user_id.eq(&owner))
                .select(aw::idle_timeout_mins)
                .first(conn)
                .optional()?)
        })
        .await?;

        if let Some(minutes) = minutes.flatten().filter(|minutes| *minutes != 0) {
            self.start_idle_timeout(user_id, minutes);
        }
        Ok(())
    }

    /// Get the agent for a user (direct DB access). Fails with
    /// `No agent found for user <id>` when there is none.
    async fn get_agent_by_user_id(&self, user_id: &str) -> anyhow::Result<AgentWorkspace> {
        let owner = user_id.to_string();
        let agent = crate::db::run(move |conn| {
            Ok(aw::agent_workspaces
                .filter(aw::user_id.eq(&owner))
                .filter(aw::agent_type.eq(AgentType::Agent))
                .select(AgentWorkspace::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        agent.ok_or_else(|| anyhow!("No agent found for user {user_id}"))
    }

    /// Store the agent's current session id.
    async fn write_session_id(&self, agent_id: &str, session_id: &str) -> anyhow::Result<()> {
        let agent_id = agent_id.to_string();
        let session_id = session_id.to_string();
        crate::db::run(move |conn| {
            let updated = diesel::update(aw::agent_workspaces.filter(aw::id.eq(&agent_id)))
                .set(&AgentWorkspaceChangeset {
                    current_session_id: Some(Some(session_id)),
                    ..AgentWorkspaceChangeset::default()
                })
                .execute(conn)?;
            if updated == 0 {
                return Err(anyhow!("Record to update not found."));
            }
            Ok(())
        })
        .await
    }

    /// Generate a unique session ID
    fn generate_session_id(&self) -> String {
        format!("sess_{}", uuid::Uuid::new_v4().simple())
    }

    /// Clean up session for a user (on logout or removal)
    pub fn cleanup(&self, user_id: &str) {
        if let Some(state) = self.sessions.lock().remove(user_id) {
            if let Some(handle) = state.daily_reset_timeout {
                handle.abort();
            }
            if let Some(handle) = state.idle_timeout {
                handle.abort();
            }
        }
    }

    /// Stop all sessions (for shutdown)
    pub fn stop_all(&self) {
        {
            let mut sessions = self.sessions.lock();
            for state in sessions.values() {
                if let Some(handle) = &state.daily_reset_timeout {
                    handle.abort();
                }
                if let Some(handle) = &state.idle_timeout {
                    handle.abort();
                }
            }
            sessions.clear();
        }
        log_info!("All sessions stopped");
    }
}

/// Milliseconds from the given wall-clock time to the next `reset_hour`: tomorrow
/// when that hour has started today.
fn ms_until_reset(reset_hour: i64, hour: i64, minutes: i64, seconds: i64) -> i64 {
    // Calculate hours until reset
    let mut hours_until_reset = reset_hour - hour;
    if hours_until_reset <= 0 {
        hours_until_reset += 24; // Tomorrow
    }

    // Convert to milliseconds
    ((hours_until_reset * 60 * 60) - (minutes * 60) - seconds) * 1000
}

impl Default for SessionManagerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static SESSION_MANAGER_SERVICE: LazyLock<SessionManagerService> =
    LazyLock::new(SessionManagerService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;

    fn service() -> &'static SessionManagerService {
        Box::leak(Box::new(SessionManagerService::new()))
    }

    async fn insert_agent(user_id: &str, session_id: Option<&str>, idle: Option<i64>) -> String {
        let mut agent = NewAgentWorkspace::new(user_id, "soul", "user", "memory", "heartbeat", "");
        agent.current_session_id = session_id.map(str::to_string);
        agent.idle_timeout_mins = idle;
        let id = agent.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(aw::agent_workspaces)
                .values(&agent)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        id
    }

    async fn stored_session(agent_id: &str) -> Option<String> {
        let agent_id = agent_id.to_string();
        crate::db::run(move |conn| {
            Ok(aw::agent_workspaces
                .filter(aw::id.eq(&agent_id))
                .select(aw::current_session_id)
                .first(conn)?)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn creates_a_new_session_when_the_user_has_none() {
        let _db = crate::db::testing::test_db();
        let agent_id = insert_agent("user-123", None, None).await;
        let service = service();

        let session_id = service.start_session("user-123").await.unwrap();

        assert!(session_id.starts_with("sess_"));
        assert_eq!(stored_session(&agent_id).await, Some(session_id.clone()));
        assert_eq!(service.get_session_id("user-123"), Some(session_id));
        service.stop_all();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn returns_the_existing_session_when_one_is_active() {
        let _db = crate::db::testing::test_db();
        let agent_id = insert_agent("user-123", Some("sess_existing123"), None).await;
        let service = service();
        service.sessions.lock().insert(
            "user-123".into(),
            SessionState::new("sess_existing123".into()),
        );

        let session_id = service.start_session("user-123").await.unwrap();

        assert_eq!(session_id, "sess_existing123");
        assert_eq!(
            stored_session(&agent_id).await.as_deref(),
            Some("sess_existing123")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn starts_the_idle_timeout_when_one_is_configured() {
        let _db = crate::db::testing::test_db();
        insert_agent("user-123", None, Some(30)).await;
        let service = service();

        service.start_session("user-123").await.unwrap();

        let sessions = service.sessions.lock();
        let state = sessions.get("user-123").unwrap();
        assert!(state.idle_timeout.is_some());
        assert!(state.daily_reset_timeout.is_some());
        drop(sessions);
        service.stop_all();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_for_a_user_with_no_agent() {
        let _db = crate::db::testing::test_db();
        let err = service().start_session("nobody").await.unwrap_err();
        assert_eq!(err.to_string(), "No agent found for user nobody");
    }

    #[tokio::test]
    async fn records_activity_only_for_a_user_with_a_session() {
        let service = service();
        service.record_activity("user-123");
        assert!(!service.has_active_session("user-123"));

        let before = Utc::now() - chrono::Duration::hours(1);
        let mut state = SessionState::new("sess_1".into());
        state.last_activity = before;
        service.sessions.lock().insert("user-123".into(), state);
        service.record_activity("user-123");
        assert!(service.sessions.lock()["user-123"].last_activity > before);
    }

    #[test]
    fn answers_the_session_state() {
        let service = SessionManagerService::new();
        assert_eq!(service.get_session_id("user-123"), None);
        assert!(!service.has_active_session("user-123"));
        service
            .sessions
            .lock()
            .insert("user-123".into(), SessionState::new("sess_abc".into()));
        assert_eq!(service.get_session_id("user-123"), Some("sess_abc".into()));
        assert!(service.has_active_session("user-123"));
        service.cleanup("user-123");
        assert!(!service.has_active_session("user-123"));
    }

    #[tokio::test]
    async fn stops_every_session_and_its_timers() {
        let service = service();
        let timer = after(60_000, async {});
        let mut state = SessionState::new("sess_1".into());
        state.idle_timeout = Some(timer.clone());
        service.sessions.lock().insert("user-1".into(), state);
        service
            .sessions
            .lock()
            .insert("user-2".into(), SessionState::new("sess_2".into()));

        service.stop_all();

        assert!(!service.has_active_session("user-1"));
        assert!(!service.has_active_session("user-2"));
        for _ in 0..100 {
            if timer.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(timer.is_finished());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn initializes_the_sessions_of_every_agent_once() {
        let _db = crate::db::testing::test_db();
        insert_agent("user-1", Some("sess_1"), None).await;
        insert_agent("user-2", None, None).await;
        let service = service();

        service.initialize().await;
        if CONFIG.thread_mode == ThreadMode::Single {
            assert!(!service.has_active_session("user-1"));
            return;
        }
        assert_eq!(service.get_session_id("user-1"), Some("sess_1".into()));
        assert!(!service.has_active_session("user-2"));

        // A second call changes nothing.
        service.sessions.lock().clear();
        service.initialize().await;
        assert!(!service.has_active_session("user-1"));
    }

    #[test]
    fn waits_until_the_reset_hour_today_or_tomorrow() {
        // 01:30:15 with a reset at 04:00: 2h29m45s.
        assert_eq!(
            ms_until_reset(4, 1, 30, 15),
            (2 * 3600 + 29 * 60 + 45) * 1000
        );
        // At 04:00 itself the next reset is tomorrow.
        assert_eq!(ms_until_reset(4, 4, 0, 0), 24 * 3600 * 1000);
        // 23:59:59 with a reset at midnight.
        assert_eq!(ms_until_reset(0, 23, 59, 59), 1000);
    }

    #[test]
    fn refuses_a_time_zone_that_is_not_one() {
        let err = SessionManagerService::new()
            .calculate_ms_until_reset(4, "Nope/Zone")
            .unwrap_err();
        assert_eq!(err.to_string(), "Invalid time zone specified: Nope/Zone");
    }
}
