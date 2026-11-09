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
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::task::AbortHandle;

use crate::config::{CODING_AGENTS, CONFIG, CodingAgentName};
use crate::lib::coding_agents::availability::redetect_coding_agents;
use crate::lib::coding_agents::claude_code::authenticated_home::{SavedLogin, read_saved_login};
use crate::lib::coding_agents::codex::credentials::{SavedCodexLogin, read_codex_login};
use crate::lib::coding_agents::get_coding_agent::get_coding_agent;
use crate::lib::coding_agents::subscription_switch::{
    set_subscription, subscription_forced, uses_subscription,
};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::services::coding_agent_sign_in::cli_sign_in::{CliSignIn, SignInEnd, start_cli_sign_in};
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
        read_saved_login(environment, env, home, None).await
    }

    async fn read_codex_login(
        &self,
        environment: &dyn ExecutionEnvironment,
        env: &ProcessEnv,
        home: &str,
    ) -> anyhow::Result<SavedCodexLogin> {
        read_codex_login(environment, env, home, None).await
    }
}

/// The CLI module seam, replaced in tests.
pub static SIGN_IN_DEPS: LazyLock<parking_lot::RwLock<Arc<dyn SignInDeps>>> =
    LazyLock::new(|| parking_lot::RwLock::new(Arc::new(CliSignInDeps)));

pub struct CodingAgentSignInService {
    inner: Arc<Inner>,
}

struct Inner {
    running: parking_lot::Mutex<HashMap<CodingAgentName, Arc<Running>>>,
    /// Each coding agent's confirmations and sign-outs, run one after the other
    /// in the order they were asked for.
    settling: parking_lot::Mutex<HashMap<CodingAgentName, Arc<tokio::sync::Mutex<()>>>>,
}

fn deps() -> Arc<dyn SignInDeps> {
    SIGN_IN_DEPS.read().clone()
}

impl CodingAgentSignInService {
    pub fn new() -> Self {
        CodingAgentSignInService {
            inner: Arc::new(Inner {
                running: parking_lot::Mutex::new(HashMap::new()),
                settling: parking_lot::Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn list(&self) -> Vec<CodingAgentRow> {
        futures::future::join_all(CODING_AGENTS.iter().map(|agent| self.row(*agent))).await
    }

    pub async fn row(&self, agent: CodingAgentName) -> CodingAgentRow {
        self.inner.row(agent).await
    }

    /// The attempt `id` of the coding agent, while it is the newest one.
    pub fn get(&self, agent: CodingAgentName, id: &str) -> Option<SignInAttempt> {
        let running = self.inner.running.lock().get(&agent).cloned()?;
        let attempt = running.attempt.lock();
        (attempt.id == id).then(|| attempt.clone())
    }

    /// Starts a sign-in, ending any earlier one, and answers once the CLI shows its
    /// link. Fails with `SignInUnavailableError` when the CLI is not installed.
    pub async fn start(&self, agent: CodingAgentName) -> anyhow::Result<SignInAttempt> {
        self.inner.start(agent).await
    }

    /// Claude's code, typed into the waiting CLI. Answers once the CLI has taken it
    /// or refused it. Fails with `SignInClosedError` ("That sign-in is closed. Get a
    /// new link.") when attempt `id` is not waiting for a code.
    pub async fn submit_code(&self, id: &str, code: &str) -> anyhow::Result<SignInAttempt> {
        self.inner.submit_code(id, code).await
    }

    /// Signs the CLI out and puts coding tasks back on the deployment's models.
    pub async fn sign_out(&self, agent: CodingAgentName) -> anyhow::Result<CodingAgentRow> {
        self.inner.sign_out(agent).await
    }
}

impl Inner {
    async fn row(&self, agent: CodingAgentName) -> CodingAgentRow {
        let environment = get_execution_environment();
        let subscription = uses_subscription(agent);
        let deps = deps();
        let (available, account) = tokio::join!(deps.cli_installed(&*environment, agent), async {
            if subscription {
                deps.read_account(&*environment, agent).await
            } else {
                None
            }
        });
        // A finished attempt is read by its id; the row lists only one still under way.
        let attempt = self
            .running
            .lock()
            .get(&agent)
            .map(|running| running.attempt.lock().clone())
            .filter(|attempt| {
                matches!(
                    attempt.status,
                    AttemptStatus::Waiting | AttemptStatus::Checking
                )
            });
        CodingAgentRow {
            agent,
            name: NAMES.get(agent).to_string(),
            available,
            subscription,
            forced: subscription_forced(agent),
            account,
            attempt,
        }
    }

    fn is_current(&self, agent: CodingAgentName, running: &Arc<Running>) -> bool {
        self.running
            .lock()
            .get(&agent)
            .is_some_and(|current| Arc::ptr_eq(current, running))
    }

    async fn start(self: &Arc<Self>, agent: CodingAgentName) -> anyhow::Result<SignInAttempt> {
        let environment = get_execution_environment();
        let deps = deps();
        if !deps.cli_installed(&*environment, agent).await {
            return Err(SignInUnavailableError(format!(
                "{} isn't available on this agent.",
                NAMES.get(agent)
            ))
            .into());
        }
        let home = home_of(&*environment, agent);
        // Codex refuses a home that does not exist yet.
        let _ = environment.files().mkdir(&home).await;
        // One lock from the end of the earlier attempt to the record of this one,
        // so two starts at once can't both find the slot empty and leave one CLI
        // that nothing ends.
        let running = {
            let mut slots = self.running.lock();
            if let Some(previous) = slots.remove(&agent) {
                self.close(&previous, EndReason::Replaced);
            }
            let cli = deps.start_cli_sign_in(&*environment, agent, &home);
            let started_at = crate::support::now_ms();
            let expires_at = chrono::DateTime::from_timestamp_millis(started_at + ATTEMPT_TTL_MS)
                .unwrap_or_default();
            let running = Arc::new(Running {
                attempt: parking_lot::Mutex::new(SignInAttempt {
                    id: uuid::Uuid::new_v4().to_string(),
                    agent,
                    status: AttemptStatus::Checking,
                    url: None,
                    user_code: None,
                    expires_at: crate::support::iso(&expires_at),
                    error: None,
                }),
                cli,
                started_at,
                timer: parking_lot::Mutex::new(None),
                closed: AtomicBool::new(false),
            });
            let id = running.attempt.lock().id.clone();
            let inner = self.clone();
            let timer = tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ATTEMPT_TTL_MS as u64)).await;
                inner.expire(agent, &id);
            });
            *running.timer.lock() = Some(timer.abort_handle());
            slots.insert(agent, running.clone());
            running
        };
        let mut props = IndexMap::new();
        props.insert("coding_agent.name".to_string(), agent.as_str().to_string());
        track_event(
            "coding agent sign-in started",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );

        let prompt = match tokio::time::timeout(
            std::time::Duration::from_millis(PROMPT_TIMEOUT_MS),
            running.cli.prompt(),
        )
        .await
        {
            Ok(prompt) => prompt,
            Err(_) => Err(anyhow::anyhow!("no sign-in link in time")),
        };
        match prompt {
            Ok(prompt) => {
                let mut attempt = running.attempt.lock();
                attempt.status = AttemptStatus::Waiting;
                attempt.url = Some(prompt.url);
                attempt.user_code = prompt.user_code;
            }
            Err(err) => {
                // A newer attempt or a sign-out ended this one, and counted it.
                if !self.is_current(agent, &running) {
                    return Ok(running.attempt.lock().clone());
                }
                log_warn!(
                    json!({ "err": err_json(&err), "agent": agent }),
                    "[CodingAgents] Sign-in showed no link"
                );
                self.finish(&running, AttemptStatus::Failed, Some(failed_message(agent)));
                return Ok(running.attempt.lock().clone());
            }
        }
        // Codex's command ends once the person has entered the code on OpenAI's
        // page; Claude's ends on its own only when something went wrong.
        let inner = self.clone();
        let watched = running.clone();
        tokio::spawn(async move {
            let end = watched.cli.ended().await;
            // A newer attempt that replaced this one ended it; that is no failure.
            if watched.attempt.lock().status != AttemptStatus::Waiting
                || !inner.is_current(agent, &watched)
            {
                return;
            }
            if agent == CodingAgentName::Codex && end == SignInEnd::Exited {
                watched.attempt.lock().status = AttemptStatus::Checking;
                let confirming = inner.clone();
                tokio::spawn(async move {
                    if let Err(err) = confirming.confirm(watched).await {
                        log_error!(
                            json!({ "err": err_json(&err), "agent": agent }),
                            "[CodingAgents] Could not confirm the sign-in"
                        );
                    }
                });
            } else {
                inner.finish(&watched, AttemptStatus::Failed, Some(failed_message(agent)));
            }
        });
        let attempt = running.attempt.lock().clone();
        Ok(attempt)
    }

    async fn submit_code(self: &Arc<Self>, id: &str, code: &str) -> anyhow::Result<SignInAttempt> {
        let running = self
            .running
            .lock()
            .get(&CodingAgentName::ClaudeCode)
            .cloned()
            .filter(|running| {
                let attempt = running.attempt.lock();
                attempt.id == id && attempt.status == AttemptStatus::Waiting
            });
        let Some(running) = running else {
            return Err(
                SignInClosedError("That sign-in is closed. Get a new link.".to_string()).into(),
            );
        };
        running.attempt.lock().status = AttemptStatus::Checking;
        running.cli.submit_code(code);
        let end = tokio::time::timeout(
            std::time::Duration::from_millis(CODE_TIMEOUT_MS),
            running.cli.ended(),
        )
        .await;
        match end {
            Ok(SignInEnd::Exited) => self.confirm(running.clone()).await?,
            Ok(SignInEnd::InvalidCode) => self.finish(
                &running,
                AttemptStatus::Failed,
                Some(
                    "That code didn't work. Get a new link and paste the code it shows."
                        .to_string(),
                ),
            ),
            _ => self.finish(
                &running,
                AttemptStatus::Failed,
                Some(failed_message(CodingAgentName::ClaudeCode)),
            ),
        }
        let attempt = running.attempt.lock().clone();
        Ok(attempt)
    }

    async fn sign_out(self: &Arc<Self>, agent: CodingAgentName) -> anyhow::Result<CodingAgentRow> {
        // Ended before the wait, so a confirmation in flight finds its attempt gone.
        self.end(agent, EndReason::SignedOut);
        {
            let lock = self.settling_lock(agent);
            let _turn = lock.lock().await;
            deps()
                .sign_out_cli(&*get_execution_environment(), agent)
                .await?;
            set_subscription(agent, false).await?;
            // A coding agent that only the login made available is not available now.
            redetect_coding_agents().await;
        }
        let mut props = IndexMap::new();
        props.insert("coding_agent.name".to_string(), agent.as_str().to_string());
        track_event(
            "coding agent signed out",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
        Ok(self.row(agent).await)
    }

    /// The lock the agent's confirmations and sign-outs take in turn.
    fn settling_lock(&self, agent: CodingAgentName) -> Arc<tokio::sync::Mutex<()>> {
        self.settling.lock().entry(agent).or_default().clone()
    }

    /// Whether the CLI's home now holds the subscription the person signed in to.
    async fn confirm(self: &Arc<Self>, running: Arc<Running>) -> anyhow::Result<()> {
        let agent = running.attempt.lock().agent;
        let lock = self.settling_lock(agent);
        let _turn = lock.lock().await;
        if !self.is_current(agent, &running) {
            return Ok(());
        }
        // One more try: a probe that times out says nothing about the login.
        let signed_in = match self.read_subscription(agent).await {
            Ok(signed_in) => Ok(signed_in),
            Err(_) => self.read_subscription(agent).await,
        };
        let error = match signed_in {
            Ok(true) => None,
            Ok(false) => Some(format!(
                "That account has no {} subscription.",
                PROVIDERS.get(agent)
            )),
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err), "agent": agent }),
                    "[CodingAgents] Could not confirm the sign-in"
                );
                Some(failed_message(agent))
            }
        };
        if let Some(error) = error {
            // With the switch off, a login left in the home would run tasks on a plan
            // the row never shows.
            if self.is_current(agent, &running) && !uses_subscription(agent) {
                if let Err(err) = deps()
                    .sign_out_cli(&*get_execution_environment(), agent)
                    .await
                {
                    log_warn!(
                        json!({ "err": err_json(&err), "agent": agent }),
                        "[CodingAgents] Could not remove the unconfirmed login"
                    );
                }
            }
            self.finish(&running, AttemptStatus::Failed, Some(error));
            return Ok(());
        }
        if !self.is_current(agent, &running) {
            return Ok(());
        }
        set_subscription(agent, true).await?;
        if !self.is_current(agent, &running) {
            return Ok(());
        }
        self.finish(&running, AttemptStatus::SignedIn, None);
        let inner = self.clone();
        tokio::spawn(async move {
            let lock = inner.settling_lock(agent);
            let _turn = lock.lock().await;
            inner.after_sign_in(running).await;
        });
        Ok(())
    }

    async fn read_subscription(&self, agent: CodingAgentName) -> anyhow::Result<bool> {
        let environment = get_execution_environment();
        let home = home_of(&*environment, agent);
        let deps = deps();
        Ok(match agent {
            CodingAgentName::ClaudeCode => {
                deps.read_saved_login(&*environment, &environment.base_env(), &home)
                    .await?
                    == SavedLogin::Subscription
            }
            CodingAgentName::Codex => {
                deps.read_codex_login(&*environment, &environment.base_env(), &home)
                    .await?
                    == SavedCodexLogin::Chatgpt
            }
        })
    }

    async fn after_sign_in(&self, running: Arc<Running>) {
        let agent = running.attempt.lock().agent;
        let continued: anyhow::Result<()> = async {
            redetect_coding_agents().await;
            if CONFIG.available_coding_agents().contains(&agent) {
                get_coding_agent(Some(agent))?.prepare_home().await?;
            }
            // A sign-out since then continues no conversation.
            if !self.is_current(agent, &running) {
                return Ok(());
            }
            if let Some(agent_id) = CONFIG.agent_id() {
                CODING_AGENT_SIGN_IN_REQUEST_SERVICE
                    .signed_in(&agent_id, &CONFIG.owner_user_id(), agent)
                    .await?;
            }
            Ok(())
        }
        .await;
        if let Err(err) = continued {
            log_error!(
                json!({ "err": err_json(&err), "agent": agent }),
                "[CodingAgents] After sign-in failed"
            );
        }
    }

    fn expire(&self, agent: CodingAgentName, id: &str) {
        let Some(running) = self.running.lock().get(&agent).cloned() else {
            return;
        };
        {
            let attempt = running.attempt.lock();
            if attempt.id != id || attempt.status != AttemptStatus::Waiting {
                return;
            }
        }
        self.finish(&running, AttemptStatus::Expired, None);
    }

    /// Ends the agent's attempt, if one is running, without a trace in its status.
    fn end(&self, agent: CodingAgentName, reason: EndReason) {
        let Some(running) = self.running.lock().remove(&agent) else {
            return;
        };
        self.close(&running, reason);
    }

    /// Stops an attempt already taken out of its slot.
    fn close(&self, running: &Running, reason: EndReason) {
        if let Some(timer) = running.timer.lock().take() {
            timer.abort();
        }
        running.cli.kill();
        self.track(running, reason.as_str());
    }

    fn finish(&self, running: &Running, status: AttemptStatus, error: Option<String>) {
        if running.closed.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut attempt = running.attempt.lock();
            attempt.status = status;
            attempt.error = error;
        }
        if let Some(timer) = running.timer.lock().take() {
            timer.abort();
        }
        if status != AttemptStatus::SignedIn {
            running.cli.kill();
        }
        self.track(running, status.as_str());
    }

    /// Counts the attempt's outcome, once, as `coding agent sign-in finished` with
    /// the attempt status or the end reason.
    fn track(&self, running: &Running, status: &str) {
        if running.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut props = IndexMap::new();
        props.insert(
            "coding_agent.name".to_string(),
            running.attempt.lock().agent.as_str().to_string(),
        );
        props.insert("status".to_string(), status.to_string());
        props.insert(
            "elapsed_ms".to_string(),
            (crate::support::now_ms() - running.started_at).to_string(),
        );
        track_event(
            "coding agent sign-in finished",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
    }
}

impl Default for CodingAgentSignInService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CODING_AGENT_SIGN_IN_SERVICE: LazyLock<CodingAgentSignInService> =
    LazyLock::new(CodingAgentSignInService::new);

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;

    use tokio::sync::watch;

    use super::*;
    use crate::lib::coding_agents::subscription_switch::set_subscription_in_memory_for_tests;
    use crate::lib::coding_agents::testing::{FakeEnvironment, wait_for};
    use crate::lib::execution_environments::get_execution_environment::set_execution_environment_for_tests;
    use crate::services::coding_agent_sign_in::cli_sign_in::SignInPrompt;

    /// A CLI sign-in whose output and end the test decides.
    struct FakeCli {
        prompt: Result<SignInPrompt, String>,
        ended: watch::Sender<Option<SignInEnd>>,
        codes: parking_lot::Mutex<Vec<String>>,
        killed: AtomicBool,
    }

    impl FakeCli {
        fn new(prompt: Result<SignInPrompt, String>) -> Arc<FakeCli> {
            let cli = Arc::new(FakeCli {
                ended: watch::channel(None).0,
                codes: parking_lot::Mutex::new(Vec::new()),
                killed: AtomicBool::new(false),
                prompt,
            });
            if cli.prompt.is_err() {
                cli.end(SignInEnd::Failed);
            }
            cli
        }

        fn linked(url: &str, user_code: Option<&str>) -> Arc<FakeCli> {
            FakeCli::new(Ok(SignInPrompt {
                url: url.to_string(),
                user_code: user_code.map(str::to_string),
            }))
        }

        fn end(&self, end: SignInEnd) {
            self.ended.send_if_modified(|current| {
                if current.is_some() {
                    return false;
                }
                *current = Some(end);
                true
            });
        }

        fn killed(&self) -> bool {
            self.killed.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl CliSignIn for FakeCli {
        async fn prompt(&self) -> anyhow::Result<SignInPrompt> {
            self.prompt
                .clone()
                .map_err(|message| anyhow::anyhow!(message))
        }

        async fn ended(&self) -> SignInEnd {
            let mut ended = self.ended.subscribe();
            ended
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|end| *end)
                .unwrap_or(SignInEnd::Failed)
        }

        fn submit_code(&self, code: &str) {
            self.codes.lock().push(code.to_string());
        }

        fn kill(&self) {
            self.killed.store(true, Ordering::SeqCst);
            self.end(SignInEnd::Failed);
        }
    }

    /// The CLI modules as the test answers them.
    struct FakeDeps {
        installed: bool,
        clis: parking_lot::Mutex<VecDeque<Arc<FakeCli>>>,
        saved_login: parking_lot::Mutex<anyhow::Result<SavedLogin>>,
        sign_outs: AtomicUsize,
    }

    impl FakeDeps {
        fn new(clis: Vec<Arc<FakeCli>>) -> Arc<FakeDeps> {
            Arc::new(FakeDeps {
                installed: true,
                clis: parking_lot::Mutex::new(clis.into()),
                saved_login: parking_lot::Mutex::new(Ok(SavedLogin::Subscription)),
                sign_outs: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl SignInDeps for FakeDeps {
        fn start_cli_sign_in(
            &self,
            _environment: &dyn ExecutionEnvironment,
            _agent: CodingAgentName,
            _home: &str,
        ) -> Arc<dyn CliSignIn> {
            self.clis.lock().pop_front().expect("a CLI for each start")
        }

        async fn read_account(
            &self,
            _environment: &dyn ExecutionEnvironment,
            _agent: CodingAgentName,
        ) -> Option<SubscriptionAccount> {
            Some(SubscriptionAccount {
                email: "a@example.com".to_string(),
                plan: "Claude Max".to_string(),
            })
        }

        async fn sign_out_cli(
            &self,
            _environment: &dyn ExecutionEnvironment,
            _agent: CodingAgentName,
        ) -> anyhow::Result<()> {
            self.sign_outs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn cli_installed(
            &self,
            _environment: &dyn ExecutionEnvironment,
            _agent: CodingAgentName,
        ) -> bool {
            self.installed
        }

        async fn read_saved_login(
            &self,
            _environment: &dyn ExecutionEnvironment,
            _env: &ProcessEnv,
            _home: &str,
        ) -> anyhow::Result<SavedLogin> {
            match &*self.saved_login.lock() {
                Ok(login) => Ok(*login),
                Err(err) => Err(anyhow::anyhow!("{err}")),
            }
        }

        async fn read_codex_login(
            &self,
            _environment: &dyn ExecutionEnvironment,
            _env: &ProcessEnv,
            _home: &str,
        ) -> anyhow::Result<SavedCodexLogin> {
            Ok(SavedCodexLogin::Chatgpt)
        }
    }

    /// The fakes installed for one test, and the global state put back after it.
    struct Stage {
        _db: crate::db::testing::TestDb,
        deps: Arc<FakeDeps>,
        service: Arc<CodingAgentSignInService>,
    }

    fn stage(deps: Arc<FakeDeps>) -> Stage {
        let db = crate::db::testing::test_db();
        *SIGN_IN_DEPS.write() = deps.clone();
        set_execution_environment_for_tests(Some(FakeEnvironment::default().arc()));
        Stage {
            _db: db,
            deps,
            service: Arc::new(CodingAgentSignInService::new()),
        }
    }

    impl Drop for Stage {
        fn drop(&mut self) {
            *SIGN_IN_DEPS.write() = Arc::new(CliSignInDeps);
            set_execution_environment_for_tests(None);
            for agent in CODING_AGENTS {
                set_subscription_in_memory_for_tests(agent, false);
            }
            CONFIG.set_available_coding_agents(vec![CodingAgentName::ClaudeCode]);
            CONFIG.set_coding_agent(CodingAgentName::ClaudeCode);
            crate::lib::coding_agents::availability::reset_coding_agent_detection_for_tests();
        }
    }

    async fn status_of(
        service: &Arc<CodingAgentSignInService>,
        agent: CodingAgentName,
        id: &str,
    ) -> Option<AttemptStatus> {
        service.get(agent, id).map(|attempt| attempt.status)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn signs_claude_in_with_the_code_the_person_pastes_and_turns_the_subscription_on() {
        let cli = FakeCli::linked("https://claude.com/auth", None);
        let stage = stage(FakeDeps::new(vec![cli.clone()]));

        let attempt = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();
        assert_eq!(attempt.status, AttemptStatus::Waiting);
        assert_eq!(attempt.url.as_deref(), Some("https://claude.com/auth"));
        assert_eq!(attempt.user_code, None);

        let service = stage.service.clone();
        let id = attempt.id.clone();
        let checked = tokio::spawn(async move { service.submit_code(&id, "the-code").await });
        let typed = cli.clone();
        wait_for(move || !typed.codes.lock().is_empty()).await;
        assert_eq!(*cli.codes.lock(), ["the-code"]);
        cli.end(SignInEnd::Exited);
        let checked = checked.await.unwrap().unwrap();
        assert_eq!(checked.status, AttemptStatus::SignedIn);
        assert_eq!(checked.error, None);
        assert!(uses_subscription(CodingAgentName::ClaudeCode));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_a_refused_code_with_a_fresh_link_message_and_leaves_the_switch_alone() {
        let cli = FakeCli::linked("https://claude.com/auth", None);
        let stage = stage(FakeDeps::new(vec![cli.clone()]));
        let attempt = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();

        cli.end(SignInEnd::InvalidCode);
        let checked = stage
            .service
            .submit_code(&attempt.id, "wrong")
            .await
            .unwrap();

        assert_eq!(checked.status, AttemptStatus::Failed);
        assert_eq!(
            checked.error.as_deref(),
            Some("That code didn't work. Get a new link and paste the code it shows.")
        );
        assert!(!uses_subscription(CodingAgentName::ClaudeCode));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_an_account_without_a_subscription_and_removes_its_login() {
        let cli = FakeCli::linked("https://claude.com/auth", None);
        let deps = FakeDeps::new(vec![cli.clone()]);
        *deps.saved_login.lock() = Ok(SavedLogin::Other);
        let stage = stage(deps);
        let attempt = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();

        cli.end(SignInEnd::Exited);
        let checked = stage
            .service
            .submit_code(&attempt.id, "the-code")
            .await
            .unwrap();

        assert_eq!(checked.status, AttemptStatus::Failed);
        assert_eq!(
            checked.error.as_deref(),
            Some("That account has no Claude subscription.")
        );
        assert_eq!(stage.deps.sign_outs.load(Ordering::SeqCst), 1);
        assert!(!uses_subscription(CodingAgentName::ClaudeCode));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn checks_the_login_once_more_when_the_first_check_gets_no_answer_and_removes_it_after() {
        let cli = FakeCli::linked("https://claude.com/auth", None);
        let deps = FakeDeps::new(vec![cli.clone()]);
        *deps.saved_login.lock() =
            Err(anyhow::anyhow!("claude auth status did not answer in 10 s"));
        let stage = stage(deps);
        let attempt = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();

        cli.end(SignInEnd::Exited);
        let checked = stage
            .service
            .submit_code(&attempt.id, "the-code")
            .await
            .unwrap();

        assert_eq!(checked.status, AttemptStatus::Failed);
        assert_eq!(
            checked.error,
            Some(failed_message(CodingAgentName::ClaudeCode))
        );
        assert_eq!(stage.deps.sign_outs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn closes_an_older_attempt_when_a_new_one_starts_so_its_code_cannot_land() {
        let first = FakeCli::linked("https://claude.com/one", None);
        let second = FakeCli::linked("https://claude.com/two", None);
        let stage = stage(FakeDeps::new(vec![first.clone(), second.clone()]));

        let old = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();
        let new = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();

        assert!(first.killed());
        assert!(!second.killed());
        assert_eq!(
            status_of(&stage.service, CodingAgentName::ClaudeCode, &old.id).await,
            None
        );
        assert_eq!(
            status_of(&stage.service, CodingAgentName::ClaudeCode, &new.id).await,
            Some(AttemptStatus::Waiting)
        );
        let err = stage
            .service
            .submit_code(&old.id, "the-code")
            .await
            .unwrap_err();
        assert!(err.downcast_ref::<SignInClosedError>().is_some());
        assert_eq!(err.to_string(), "That sign-in is closed. Get a new link.");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn confirms_a_codex_sign_in_when_the_device_code_command_exits() {
        let cli = FakeCli::linked("https://auth.openai.com/codex/device", Some("TEST-CODE1"));
        let stage = stage(FakeDeps::new(vec![cli.clone()]));

        let attempt = stage.service.start(CodingAgentName::Codex).await.unwrap();
        assert_eq!(attempt.user_code.as_deref(), Some("TEST-CODE1"));
        cli.end(SignInEnd::Exited);

        let service = stage.service.clone();
        let id = attempt.id.clone();
        wait_for(move || {
            service.get(CodingAgentName::Codex, &id).map(|a| a.status)
                == Some(AttemptStatus::SignedIn)
        })
        .await;
        assert!(uses_subscription(CodingAgentName::Codex));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn names_the_hosts_to_allow_when_the_cli_shows_no_link() {
        let cli = FakeCli::new(Err(
            "codex sign-in ended before it showed a link".to_string()
        ));
        let stage = stage(FakeDeps::new(vec![cli]));

        let attempt = stage.service.start(CodingAgentName::Codex).await.unwrap();

        assert_eq!(attempt.status, AttemptStatus::Failed);
        assert_eq!(
            attempt.error.as_deref(),
            Some(
                "The sign-in didn't finish. If it keeps failing, check that the agent's website access allows auth.openai.com, chatgpt.com and api.openai.com."
            )
        );
    }

    #[tokio::test(start_paused = true)]
    #[serial_test::serial]
    async fn expires_a_link_nobody_finished() {
        let cli = FakeCli::linked("https://claude.com/auth", None);
        let stage = stage(FakeDeps::new(vec![cli.clone()]));
        let attempt = stage
            .service
            .start(CodingAgentName::ClaudeCode)
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(ATTEMPT_TTL_MS as u64 + 1)).await;

        assert_eq!(
            status_of(&stage.service, CodingAgentName::ClaudeCode, &attempt.id).await,
            Some(AttemptStatus::Expired)
        );
        assert!(cli.killed());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_sign_in_for_a_coding_agent_this_runtime_does_not_have() {
        let deps = Arc::new(FakeDeps {
            installed: false,
            ..Arc::into_inner(FakeDeps::new(vec![])).unwrap()
        });
        let stage = stage(deps);
        let err = stage
            .service
            .start(CodingAgentName::Codex)
            .await
            .unwrap_err();
        assert!(err.downcast_ref::<SignInUnavailableError>().is_some());
        assert_eq!(err.to_string(), "Codex isn't available on this agent.");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn signs_out_and_puts_tasks_back_on_the_deployment_models() {
        let stage = stage(FakeDeps::new(vec![]));
        set_subscription(CodingAgentName::ClaudeCode, true)
            .await
            .unwrap();

        let row = stage
            .service
            .sign_out(CodingAgentName::ClaudeCode)
            .await
            .unwrap();

        assert_eq!(stage.deps.sign_outs.load(Ordering::SeqCst), 1);
        assert!(!row.subscription);
        assert_eq!(row.account, None);
        assert!(!uses_subscription(CodingAgentName::ClaudeCode));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn lists_the_account_only_while_the_subscription_is_on() {
        let stage = stage(FakeDeps::new(vec![]));
        let rows = stage.service.list().await;
        assert_eq!(
            rows.iter().map(|row| row.agent).collect::<Vec<_>>(),
            CODING_AGENTS
        );
        assert!(
            rows.iter()
                .all(|row| row.account.is_none() && row.available)
        );

        set_subscription_in_memory_for_tests(CodingAgentName::ClaudeCode, true);
        let row = stage.service.row(CodingAgentName::ClaudeCode).await;
        assert!(row.subscription);
        assert_eq!(
            row.account,
            Some(SubscriptionAccount {
                email: "a@example.com".into(),
                plan: "Claude Max".into()
            })
        );
        assert_eq!(row.name, "Claude Code");
        assert!(!row.forced);
    }
}
