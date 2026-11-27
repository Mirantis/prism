//! Codex as a coding agent: `codex exec --json` read back as the neutral events
//! of `CodingAgent`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::Value;

use super::credentials::{
    CodexAuthMethod, SUBSCRIPTION_CONFIG_ARGS, SavedCodexLogin, codex_api_key, codex_auth_method,
    has_saved_codex_login, read_codex_login, subscription_environment,
};
use crate::config::{CONFIG, CodexTierModel, CodingAgentName, TierSet};
use crate::lib::coding_agents::bedrock_credentials::bedrock_region;
use crate::lib::coding_agents::cli_run::{CliRunSpec, ParseLine, run_cli};
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentEvent, CodingAgentHome, CodingAgentMode, CodingAgentRun,
    CodingAgentStopReason, CodingAgentTask, CodingAgentUsage, PLAN_ONLY_INSTRUCTION,
};
use crate::lib::coding_agents::deferred_run::{aborted, deferred_run};
use crate::lib::coding_agents::shared_skills_home::prepare_shared_skills_home;
use crate::lib::coding_agents::subscription::not_signed_in_message;
use crate::lib::coding_agents::subscription_switch::uses_subscription;
use crate::lib::coding_agents::tracked_run::track_run;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::get_execution_environment::{
    get_execution_environment, get_execution_environment_for,
};
use crate::lib::telemetry::track_event;

pub const DISPLAY_NAME: &str = "Codex";
pub const COMMAND: &str = "codex";

pub struct CodexAgent {
    /// A test hook; production runs in the selected environment.
    environment: Option<Arc<dyn ExecutionEnvironment>>,
    /// Read once, when availability is probed at boot: a task's argv is built
    /// synchronously and the home may be a round trip away.
    saved_login: AtomicBool,
}

pub fn create_codex_agent(
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgent> {
    Arc::new(CodexAgent {
        environment,
        saved_login: AtomicBool::new(false),
    })
}

impl CodexAgent {
    fn target(&self) -> Arc<dyn ExecutionEnvironment> {
        self.environment
            .clone()
            .unwrap_or_else(get_execution_environment)
    }
}

#[async_trait]
impl CodingAgent for CodexAgent {
    fn id(&self) -> CodingAgentName {
        CodingAgentName::Codex
    }

    fn display_name(&self) -> &str {
        DISPLAY_NAME
    }

    /// The environment's `codex_home`, unless `CODEX_HOME` names it.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        let env = self.target();
        let operator_home = std::env::var("CODEX_HOME").ok();
        prepare_shared_skills_home(&*env, &env.paths().codex_home, operator_home.as_deref()).await
    }

    /// Reads the saved login once, then whether any auth method applies.
    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool> {
        let saved_login = has_saved_codex_login(&*self.target()).await;
        self.saved_login.store(saved_login, Ordering::SeqCst);
        Ok(codex_auth_method(env, saved_login).is_some())
    }

    /// Emits `codex task started` now and `codex task finished` (with `status`
    /// the stop reason, or `stopped`, and `elapsed_ms`) when the events end. On
    /// the subscription the run is deferred until the home's login reads
    /// `chatgpt`; otherwise the CLI starts at once with `CODEX_API_KEY`.
    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        let subscription = uses_subscription(CodingAgentName::Codex);
        let auth_method = if subscription {
            Some(CodexAuthMethod::Subscription)
        } else {
            codex_auth_method(&task.env, self.saved_login.load(Ordering::SeqCst))
        };
        let started_at = crate::support::now_ms();
        let mut props = IndexMap::new();
        props.insert("task.id".to_string(), task.task_id.clone());
        props.insert(
            "auth.method".to_string(),
            auth_method
                .map_or("none", CodexAuthMethod::as_str)
                .to_string(),
        );
        let owner = CONFIG.owner_user_id();
        track_event("codex task started", Some(&owner), Some(props.clone()));
        // The environment the CLI runs in, which is also where its home is.
        let run_in = self
            .environment
            .clone()
            .unwrap_or_else(|| get_execution_environment_for(task.workdir.as_deref()));
        let home = run_in.paths().codex_home;
        let models = CONFIG.coding_agent_models.codex.clone();
        let launch = {
            let task = task.clone();
            let run_in = run_in.clone();
            let home = home.clone();
            move |mut env: ProcessEnv| {
                env.insert("CODEX_HOME".to_string(), home);
                if task.debug == Some(true) {
                    env.insert("RUST_LOG".to_string(), "debug".to_string());
                }
                run_cli(
                    CliRunSpec {
                        task_id: task.task_id.clone(),
                        display_name: DISPLAY_NAME.to_string(),
                        command: COMMAND.to_string(),
                        args: build_args(&task, auth_method, &models),
                        cwd: task.workdir.clone(),
                        env,
                        parse_line: create_parser(
                            model_for(&task, auth_method, &models)
                                .unwrap_or_else(|| UNNAMED_MODEL.to_string()),
                            subscription,
                        ),
                        flush: None,
                    },
                    Some(run_in),
                )
            }
        };
        let run = if subscription {
            let task_id = task.task_id.clone();
            deferred_run(
                &task_id,
                DISPLAY_NAME,
                Box::new(move |signal| {
                    Box::pin(async move {
                        // Asked on every run, so a sign-in or a sign-out applies to the
                        // next task. Anything but a ChatGPT login fails the task, which
                        // then bills nothing.
                        let login =
                            read_codex_login(&*run_in, &task.env, &home, Some(signal.clone()))
                                .await?;
                        if login != SavedCodexLogin::Chatgpt {
                            // A folder outside the deployment's environment runs here, on
                            // a home Coding agents doesn't sign in.
                            let host_home = task
                                .workdir
                                .as_deref()
                                .filter(|workdir| {
                                    !workdir.is_empty()
                                        && !get_execution_environment().serves_path(workdir)
                                })
                                .map(|_| home.clone());
                            anyhow::bail!(not_signed_in_message(
                                CodingAgentName::Codex,
                                host_home.as_deref()
                            ));
                        }
                        if signal.is_cancelled() {
                            return Err(aborted());
                        }
                        Ok(launch(subscription_environment(&task.env)))
                    })
                }),
            )
        } else {
            let mut env = task.env.clone();
            match codex_api_key(&task.env) {
                Some(key) => {
                    env.insert("CODEX_API_KEY".to_string(), key);
                }
                None => {
                    env.shift_remove("CODEX_API_KEY");
                }
            }
            launch(env)
        };
        track_run(run, "codex task finished", owner, props, started_at)
    }
}

/// `exec --json --skip-git-repo-check -c approval_policy="never" -c
/// sandbox_mode="danger-full-access"`, then the provider for the auth method,
/// `--model`, `model_reasoning_effort`, `developer_instructions`, `resume <id>`,
/// and `-- <mode instruction>\n\n<prompt>`.
///
/// Every task runs without Codex's sandbox: in an unprivileged container, the
/// deployed shape, the sandbox cannot start and every command in it fails.
/// Nothing can answer an approval request, so none is asked.
fn build_args(
    task: &CodingAgentTask,
    auth_method: Option<CodexAuthMethod>,
    models: &TierSet<CodexTierModel>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "sandbox_mode=\"danger-full-access\"",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    let use_bedrock = auth_method == Some(CodexAuthMethod::Bedrock);
    if use_bedrock {
        // Bedrock identifies these models with the vendor prefix `openai.`; the
        // OpenAI endpoint uses bare ids. Tier defaults below follow the same rule.
        args.push("-c".to_string());
        args.push("model_provider=\"amazon-bedrock\"".to_string());
        if task.model_tier.is_none() {
            args.push("-c".to_string());
            args.push(format!("model=\"{BEDROCK_DEFAULT_MODEL}\""));
        }
        args.push("-c".to_string());
        args.push(format!(
            "model_providers.amazon-bedrock.aws.region={}",
            Value::String(bedrock_region(&task.env))
        ));
    } else if auth_method == Some(CodexAuthMethod::Subscription) {
        // A repository's `.codex/config.toml` cannot move the task off this login:
        // Codex 0.163 ignores its `model_provider`, `model_providers` and `profiles`.
        args.extend(SUBSCRIPTION_CONFIG_ARGS.iter().map(|arg| arg.to_string()));
    } else {
        args.push("-c".to_string());
        args.push("model_provider=\"openai\"".to_string());
        if auth_method == Some(CodexAuthMethod::Api) {
            args.push("-c".to_string());
            args.push("forced_login_method=\"api\"".to_string());
        }
        if auth_method == Some(CodexAuthMethod::Saved) {
            args.push("-c".to_string());
            args.push("cli_auth_credentials_store=\"file\"".to_string());
        }
    }
    // An omitted tier or effort must emit no selection flag here, preserving
    // deployment configuration and the existing Bedrock default above. Keep
    // both optional on resume too; a default tier would silently replace it.
    if task.model_tier.is_some()
        && let Some(model) = model_for(task, auth_method, models)
    {
        args.push("--model".to_string());
        args.push(model);
    }
    if let Some(effort) = task.effort {
        args.push("-c".to_string());
        args.push(format!("model_reasoning_effort=\"{}\"", effort.as_str()));
    }
    if let Some(append) = task
        .append_system_prompt
        .as_deref()
        .filter(|a| !a.is_empty())
    {
        args.push("-c".to_string());
        args.push(format!(
            "developer_instructions={}",
            Value::String(append.to_string())
        ));
    }
    if let Some(session_id) = task.session_id.as_deref().filter(|id| !id.is_empty()) {
        args.push("resume".to_string());
        args.push(session_id.to_string());
    }
    // Mode is a per-turn instruction; developer instructions persist across resume.
    // With no sandbox, the instruction is all that keeps a plan task read-only.
    let mode = if task.mode == CodingAgentMode::Plan {
        PLAN_ONLY_INSTRUCTION
    } else {
        "Implement the requested changes and verify the result."
    };
    args.push("--".to_string());
    args.push(format!("{mode}\n\n{}", task.prompt));
    args
}

/// The model a Bedrock task runs on when it names no tier.
const BEDROCK_DEFAULT_MODEL: &str = "openai.gpt-5.6-terra";

/// The name a usage row gets when Codex runs the model its own configuration chooses.
const UNNAMED_MODEL: &str = "codex";

/// The model a task runs on, or `None` where Codex's own configuration chooses it.
fn model_for(
    task: &CodingAgentTask,
    auth_method: Option<CodexAuthMethod>,
    models: &TierSet<CodexTierModel>,
) -> Option<String> {
    let use_bedrock = auth_method == Some(CodexAuthMethod::Bedrock);
    match task.model_tier {
        Some(tier) => {
            let model = models.get(tier.as_str()).expect("every tier has a model");
            Some(if use_bedrock {
                model.bedrock.clone()
            } else {
                model.openai.clone()
            })
        }
        None => use_bedrock.then(|| BEDROCK_DEFAULT_MODEL.to_string()),
    }
}

/// A field's text: a string as it is, any other value as `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A field unless it is `null` or absent, as `??` reads it.
fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|field| !field.is_null())
}

/// Codex reports one turn for the whole exec task, including its tool calls.
/// The parser keeps the last answer and the last error between lines.
fn create_parser(model: String, subscription: bool) -> ParseLine {
    let mut answer = String::new();
    let mut error = String::new();
    Box::new(move |line| {
        let event: Value = serde_json::from_str(line)?;
        if event.is_null() {
            anyhow::bail!("Cannot read properties of null (reading 'type')");
        }
        let event_type = event.get("type").and_then(Value::as_str);
        if event_type == Some("thread.started")
            && let Some(thread_id) =
                present(&event, "thread_id").filter(|id| crate::support::js::truthy(id))
        {
            return Ok(vec![CodingAgentEvent::Session {
                session_id: js_string(thread_id),
            }]);
        }
        let item = present(&event, "item");
        if event_type == Some("item.completed")
            && item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("agent_message")
        {
            answer = item
                .and_then(|item| present(item, "text"))
                .map(js_string)
                .unwrap_or_default();
            return Ok(vec![CodingAgentEvent::Text {
                text: answer.clone(),
            }]);
        }
        if event_type == Some("error") {
            // Connection retries can emit errors before a successful terminal event.
            error = present(&event, "message")
                .map(js_string)
                .unwrap_or_default();
            return Ok(vec![]);
        }
        if event_type == Some("turn.failed") {
            let reported = present(&event, "error")
                .and_then(|error| error.get("message"))
                .filter(|message| crate::support::js::truthy(message))
                .map(js_string);
            let message = reported
                .or_else(|| (!error.is_empty()).then(|| error.clone()))
                .unwrap_or_else(|| "Codex task failed".to_string());
            return Ok(vec![CodingAgentEvent::Result {
                stop_reason: CodingAgentStopReason::Error,
                turns: 1,
                message,
                refusals: None,
            }]);
        }
        if event_type == Some("turn.completed") {
            let mut events = Vec::new();
            // `input_tokens` includes the cached and the cache-written ones.
            if let Some(usage) = present(&event, "usage") {
                let count = |key: &str| {
                    present(usage, key)
                        .and_then(Value::as_f64)
                        .map_or(0, |count| count as i64)
                };
                let (input, cached, written) = (
                    count("input_tokens"),
                    count("cached_input_tokens"),
                    count("cache_write_input_tokens"),
                );
                events.push(CodingAgentEvent::Usage {
                    usage: CodingAgentUsage {
                        model: model.clone(),
                        input_tokens: (input - cached - written).max(0),
                        cache_read_tokens: cached,
                        cache_write_tokens: written,
                        long_cache_write_tokens: 0,
                        output_tokens: count("output_tokens"),
                        cost_usd: None,
                        subscription,
                    },
                });
            }
            events.push(CodingAgentEvent::Result {
                stop_reason: CodingAgentStopReason::EndTurn,
                turns: 1,
                message: answer.clone(),
                refusals: None,
            });
            return Ok(events);
        }
        Ok(vec![])
    })
}

#[cfg(test)]
#[path = "codex_agent_tests.rs"]
mod tests;
