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
use std::sync::atomic::AtomicBool;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio::task::AbortHandle;

use crate::db::models::AgentWorkspace;

// ============================================================================
// Types
// ============================================================================

struct SessionState {
    user_id: String,
    session_id: String,
    daily_reset_timeout: Option<AbortHandle>,
    idle_timeout: Option<AbortHandle>,
    last_activity: DateTime<Utc>,
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

impl std::fmt::Display for ResetReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
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
    pub async fn initialize(&self) {
        todo!()
    }

    /// Start or resume a session for a user.
    /// Returns the current session ID.
    pub async fn start_session(&self, user_id: &str) -> anyhow::Result<String> {
        todo!()
    }

    /// Record activity for a user (resets idle timeout)
    pub fn record_activity(&self, user_id: &str) {
        todo!()
    }

    /// Reset session (manual or automatic).
    /// Starts a fresh conversation thread (which becomes the latest), carrying the
    /// current thread's workspace root forward.
    pub async fn reset_session(
        &self,
        user_id: &str,
        reason: ResetReason,
    ) -> anyhow::Result<String> {
        todo!()
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

    /// Schedule daily reset for a user
    fn schedule_daily_reset(&self, user_id: &str, reset_hour: i64, timezone: &str) {
        todo!()
    }

    /// Calculate milliseconds until next reset hour
    fn calculate_ms_until_reset(&self, reset_hour: i64, timezone: &str) -> i64 {
        todo!()
    }

    /// Start idle timeout for a user
    fn start_idle_timeout(&self, user_id: &str, idle_timeout_mins: i64) {
        todo!()
    }

    /// Restart idle timeout after activity
    async fn restart_idle_timeout(&self, user_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Get the agent for a user (direct DB access). Fails with
    /// `No agent found for user <id>` when there is none.
    async fn get_agent_by_user_id(&self, user_id: &str) -> anyhow::Result<AgentWorkspace> {
        todo!()
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
        todo!()
    }
}

impl Default for SessionManagerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static SESSION_MANAGER_SERVICE: LazyLock<SessionManagerService> =
    LazyLock::new(SessionManagerService::new);
