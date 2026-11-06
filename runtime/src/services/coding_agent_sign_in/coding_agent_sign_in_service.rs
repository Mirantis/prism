//! Signing a coding agent in to the person's own Claude or ChatGPT
//! subscription, and out again.
//!
//! One attempt per coding agent at a time, held in memory: starting another
//! ends the one before, so an old link or code can never complete a newer
//! sign-in, and a restart ends them all. A confirmation and a sign-out of one
//! coding agent run one after the other, and an attempt that a sign-out or a
//! newer attempt ended turns nothing on. The code Claude shows goes from the
//! person's sheet to the CLI's stdin. Nothing stores, logs or shows it to a
//! model.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::task::AbortHandle;

use crate::config::{CODING_AGENTS, CONFIG, CodingAgentName};
use crate::lib::coding_agents::claude_code::authenticated_home::{SavedLogin, read_saved_login};
use crate::lib::coding_agents::codex::credentials::{SavedCodexLogin, read_codex_login};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::telemetry::track_event;
use crate::services::coding_agent_sign_in::cli_sign_in::{CliSignIn, start_cli_sign_in};
use crate::services::coding_agent_sign_in::coding_agent_account::{
    SubscriptionAccount, cli_installed, home_of, read_account, sign_out_cli,
};
use crate::services::coding_agent_sign_in::coding_agent_sign_in_request_service::{
    CODING_AGENT_SIGN_IN_REQUEST_SERVICE, NAMES, PROVIDERS,
};
use crate::{log_error, log_warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Waiting,
    Checking,
    SignedIn,
    Failed,
    Expired,
}

impl AttemptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AttemptStatus::Waiting => "waiting",
            AttemptStatus::Checking => "checking",
            AttemptStatus::SignedIn => "signed_in",
            AttemptStatus::Failed => "failed",
            AttemptStatus::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInAttempt {
    pub id: String,
    pub agent: CodingAgentName,
    pub status: AttemptStatus,
    pub url: Option<String>,
    pub user_code: Option<String>,
    /// `toISOString()` text.
    pub expires_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentRow {
    pub agent: CodingAgentName,
    pub name: String,
    pub available: bool,
    pub subscription: bool,
    /// The deployment's environment holds the subscription on, so a sign-out leaves it on.
    pub forced: bool,
    pub account: Option<SubscriptionAccount>,
    pub attempt: Option<SignInAttempt>,
}

/// A sign-in the coding agent's CLI cannot run here.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SignInUnavailableError(pub String);

/// A code for an attempt that is not waiting for one.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SignInClosedError(pub String);

/// The hosts a sign-in and the tasks after it reach, named when one fails.
fn hosts(agent: CodingAgentName) -> &'static str {
    match agent {
        CodingAgentName::ClaudeCode => "platform.claude.com, api.anthropic.com and claude.ai",
        CodingAgentName::Codex => "auth.openai.com, chatgpt.com and api.openai.com",
    }
}

/// How long a link stays good. Codex's own code lasts 15 minutes; Claude's is not stated.
pub const ATTEMPT_TTL_MS: i64 = 10 * 60_000;
/// How long the CLI gets to print its link.
const PROMPT_TIMEOUT_MS: u64 = 30_000;
/// How long the CLI gets to check Claude's code.
const CODE_TIMEOUT_MS: u64 = 60_000;

fn failed_message(agent: CodingAgentName) -> String {
    format!(
        "The sign-in didn't finish. If it keeps failing, check that the agent's website access allows {}.",
        hosts(agent)
    )
}

/// The attempt under way for a coding agent.
struct Running {
    attempt: parking_lot::Mutex<SignInAttempt>,
    cli: Arc<dyn CliSignIn>,
    started_at: i64,
    /// The expiry timer.
    timer: parking_lot::Mutex<Option<AbortHandle>>,
    /// Its outcome is counted: finished, replaced or signed out.
    closed: AtomicBool,
}

/// How an attempt ended without a status of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndReason {
    Replaced,
    SignedOut,
}

impl EndReason {
    fn as_str(self) -> &'static str {
        match self {
            EndReason::Replaced => "replaced",
            EndReason::SignedOut => "signed_out",
        }
    }
}

/// What the sign-in reads from and does to a coding agent's CLI. Tests replace
/// it through `SIGN_IN_DEPS`.
#[async_trait]
pub trait SignInDeps: Send + Sync {
    fn start_cli_sign_in(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
        home: &str,
    ) -> Arc<dyn CliSignIn>;
    async fn read_account(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
    ) -> Option<SubscriptionAccount>;
    async fn sign_out_cli(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
    ) -> anyhow::Result<()>;
    async fn cli_installed(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
    ) -> bool;
    async fn read_saved_login(
        &self,
        environment: &dyn ExecutionEnvironment,
        env: &ProcessEnv,
        home: &str,
    ) -> anyhow::Result<SavedLogin>;
    async fn read_codex_login(
        &self,
        environment: &dyn ExecutionEnvironment,
        env: &ProcessEnv,
        home: &str,
    ) -> anyhow::Result<SavedCodexLogin>;
}

/// The CLI modules themselves.
pub struct CliSignInDeps;

#[async_trait]
impl SignInDeps for CliSignInDeps {
    fn start_cli_sign_in(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
        home: &str,
    ) -> Arc<dyn CliSignIn> {
        start_cli_sign_in(environment, agent, home)
    }

    async fn read_account(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
    ) -> Option<SubscriptionAccount> {
        read_account(environment, agent).await
    }

    async fn sign_out_cli(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
    ) -> anyhow::Result<()> {
        sign_out_cli(environment, agent).await
    }

    async fn cli_installed(
        &self,
        environment: &dyn ExecutionEnvironment,
        agent: CodingAgentName,
    ) -> bool {
        cli_installed(environment, agent).await
    }

    async fn read_saved_login(
        &self,
        environment: &dyn ExecutionEnvironment,
        env: &ProcessEnv,
        home: &str,
    ) -> anyhow::Result<SavedLogin> {
        todo!()
    }

    async fn read_codex_login(
        &self,
        environment: &dyn ExecutionEnvironment,
        env: &ProcessEnv,
        home: &str,
    ) -> anyhow::Result<SavedCodexLogin> {
        todo!()
    }
}

/// The CLI module seam, replaced in tests.
pub static SIGN_IN_DEPS: LazyLock<parking_lot::RwLock<Arc<dyn SignInDeps>>> =
    LazyLock::new(|| parking_lot::RwLock::new(Arc::new(CliSignInDeps)));

pub struct CodingAgentSignInService {
    running: parking_lot::Mutex<HashMap<CodingAgentName, Arc<Running>>>,
    /// Each coding agent's confirmations and sign-outs, run one after the other
    /// in the order they were asked for.
    settling: parking_lot::Mutex<HashMap<CodingAgentName, Arc<tokio::sync::Mutex<()>>>>,
}

impl CodingAgentSignInService {
    pub fn new() -> Self {
        CodingAgentSignInService {
            running: parking_lot::Mutex::new(HashMap::new()),
            settling: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    pub async fn list(&self) -> Vec<CodingAgentRow> {
        todo!()
    }

    pub async fn row(&self, agent: CodingAgentName) -> CodingAgentRow {
        todo!()
    }

    /// The attempt `id` of the coding agent, while it is the newest one.
    pub fn get(&self, agent: CodingAgentName, id: &str) -> Option<SignInAttempt> {
        todo!()
    }

    /// Starts a sign-in, ending any earlier one, and answers once the CLI shows its
    /// link. Fails with `SignInUnavailableError` when the CLI is not installed.
    pub async fn start(&self, agent: CodingAgentName) -> anyhow::Result<SignInAttempt> {
        todo!()
    }

    /// Claude's code, typed into the waiting CLI. Answers once the CLI has taken it
    /// or refused it. Fails with `SignInClosedError` ("That sign-in is closed. Get a
    /// new link.") when attempt `id` is not waiting for a code.
    pub async fn submit_code(&self, id: &str, code: &str) -> anyhow::Result<SignInAttempt> {
        todo!()
    }

    /// Signs the CLI out and puts coding tasks back on the deployment's models.
    pub async fn sign_out(&self, agent: CodingAgentName) -> anyhow::Result<CodingAgentRow> {
        todo!()
    }

    /// The lock the agent's confirmations and sign-outs take in turn.
    fn settling_lock(&self, agent: CodingAgentName) -> Arc<tokio::sync::Mutex<()>> {
        self.settling.lock().entry(agent).or_default().clone()
    }

    /// Whether the CLI's home now holds the subscription the person signed in to.
    async fn confirm(&self, running: Arc<Running>) {
        todo!()
    }

    async fn read_subscription(&self, agent: CodingAgentName) -> anyhow::Result<bool> {
        todo!()
    }

    async fn after_sign_in(&self, running: Arc<Running>) {
        todo!()
    }

    fn expire(&self, agent: CodingAgentName, id: &str) {
        todo!()
    }

    /// Ends the agent's attempt, if one is running, without a trace in its status.
    fn end(&self, agent: CodingAgentName, reason: EndReason) {
        todo!()
    }

    fn finish(&self, running: &Running, status: AttemptStatus, error: Option<String>) {
        todo!()
    }

    /// Counts the attempt's outcome, once, as `coding agent sign-in finished` with
    /// the attempt status or the end reason.
    fn track(&self, running: &Running, status: &str) {
        todo!()
    }
}

impl Default for CodingAgentSignInService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CODING_AGENT_SIGN_IN_SERVICE: LazyLock<CodingAgentSignInService> =
    LazyLock::new(CodingAgentSignInService::new);
