//! Antigravity CLI (`agy`) as a coding agent: `agy -p <prompt> --output-format
//! stream-json` read back as the neutral events of `CodingAgent`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use futures::StreamExt;
use indexmap::IndexMap;
use serde_json::Value;

use crate::config::{CONFIG, CodingAgentName, TierSet};
use crate::lib::coding_agents::cli_probe::probe_cli;
use crate::lib::coding_agents::cli_run::{CliRunSpec, ParseLine, run_cli};
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentEvent, CodingAgentEvents, CodingAgentHome, CodingAgentMode,
    CodingAgentRefusal, CodingAgentRun, CodingAgentStopReason, CodingAgentTask, CodingAgentUsage,
    PLAN_ONLY_INSTRUCTION,
};
use crate::lib::execution_environments::docker::volumes::CONTAINER_PATHS;
use crate::lib::execution_environments::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ProcessEnv, ProcessMark,
};
use crate::lib::execution_environments::get_execution_environment::{
    get_execution_environment, get_execution_environment_for,
};
use crate::lib::telemetry::track_event;

pub const DISPLAY_NAME: &str = "Antigravity CLI";
pub const COMMAND: &str = "agy";

/// The name a usage row gets when `agy` runs the model its own settings choose.
const UNNAMED_MODEL: &str = "agy";

pub struct AgyAgent {
    /// A test hook; production runs in the selected environment.
    environment: Option<Arc<dyn ExecutionEnvironment>>,
}

pub fn create_agy_agent(
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgent> {
    Arc::new(AgyAgent { environment })
}

impl AgyAgent {
    fn target(&self) -> Arc<dyn ExecutionEnvironment> {
        self.environment
            .clone()
            .unwrap_or_else(get_execution_environment)
    }
}

#[async_trait]
impl CodingAgent for AgyAgent {
    fn id(&self) -> CodingAgentName {
        CodingAgentName::Agy
    }

    fn display_name(&self) -> &str {
        DISPLAY_NAME
    }

    /// Reports the CLI's home directory without mutating the user's `~/.gemini`.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        let env = self.target();
        let base_env = env.base_env();
        let home = home_dir_in(&*env, &base_env);
        let config_dir = match &home {
            Some(home) => format!("{home}/.gemini/antigravity-cli"),
            None => ".gemini/antigravity-cli".to_string(),
        };
        let skills_linked = match &home {
            Some(home) => {
                let link = format!("{home}/.agents/skills");
                let skills_dir = env.paths().skills_dir;
                let files = env.files();
                let (from, to) = tokio::join!(files.realpath(&link), files.realpath(&skills_dir));
                matches!((from, to), (Ok(from), Ok(to)) if from == to)
            }
            None => false,
        };
        Ok(CodingAgentHome {
            config_dir,
            skills_linked,
        })
    }

    /// Available when credentials exist in the execution environment and `agy --version` exits 0.
    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool> {
        let target = self.target();
        if !has_agy_credentials(&*target, env).await {
            return Ok(false);
        }
        let args = vec!["--version".to_string()];
        Ok(probe_cli(&*target, COMMAND, &args, env.clone(), None)
            .await
            .is_ok_and(|run| run.exit_code == Some(0)))
    }

    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        let started_at = crate::support::now_ms();
        let mut props = IndexMap::new();
        props.insert("task.id".to_string(), task.task_id.clone());
        let owner = CONFIG.owner_user_id();
        track_event("agy task started", Some(&owner), Some(props.clone()));

        let run_in = self
            .environment
            .clone()
            .unwrap_or_else(|| get_execution_environment_for(task.workdir.as_deref()));
        let models = CONFIG.coding_agent_models.agy.clone();
        let requested_model = model_for(&task, &models);
        let run = run_cli(
            CliRunSpec {
                task_id: task.task_id.clone(),
                display_name: DISPLAY_NAME.to_string(),
                command: COMMAND.to_string(),
                args: build_args(&task, &models),
                cwd: task.workdir.clone(),
                env: task.env.clone(),
                parse_line: create_parser(
                    requested_model.unwrap_or_else(|| UNNAMED_MODEL.to_string()),
                ),
            },
            Some(run_in),
        );

        let stopped = Arc::new(AtomicBool::new(false));
        let events = run.take_events().map(|events| {
            finished_after(
                events,
                Finish {
                    owner,
                    props,
                    started_at,
                    stopped: stopped.clone(),
                    status: "error",
                    done: false,
                },
            )
        });
        Arc::new(TrackedRun {
            run,
            stopped,
            events: parking_lot::Mutex::new(events),
        })
    }
}

/// The home directory where `agy` keeps `.gemini` inside `environment`.
fn home_dir_in(environment: &dyn ExecutionEnvironment, env: &ProcessEnv) -> Option<String> {
    if let Some(home) = env.get("HOME").filter(|value| !value.is_empty()) {
        return Some(home.trim_end_matches('/').to_string());
    }
    if environment.id() == ExecutionEnvironmentName::Docker {
        return Some(CONTAINER_PATHS.home_dir.to_string());
    }
    None
}

/// Whether `agy` has an API key, ADC enabled, or a saved login config in `environment`.
pub async fn has_agy_credentials(environment: &dyn ExecutionEnvironment, env: &ProcessEnv) -> bool {
    let set = |key: &str| env.get(key).is_some_and(|v| !v.is_empty());
    if set("GEMINI_API_KEY") || set("GOOGLE_API_KEY") {
        return true;
    }
    if env
        .get("AGY_ADC_AUTH")
        .is_some_and(|v| crate::support::js::trim(v).eq_ignore_ascii_case("true"))
    {
        return true;
    }
    let Some(home) = home_dir_in(environment, env) else {
        return false;
    };
    environment
        .files()
        .stat(&format!("{home}/.gemini/config/config.json"))
        .await
        .is_ok()
}

/// `-p <prompt> --output-format stream-json`, `--mode plan` for plan tasks or
/// `--dangerously-skip-permissions` for edit tasks, plus optional `--model`,
/// `--effort` and `--resume`.
///
/// Headless `agy` denies shell commands under `accept-edits` when stdin is
/// closed, so edit tasks pass `--dangerously-skip-permissions`. Plan tasks pass
/// `--mode plan` and prepend `PLAN_ONLY_INSTRUCTION`.
fn build_args(task: &CodingAgentTask, models: &TierSet<String>) -> Vec<String> {
    let prompt = [
        (task.mode == CodingAgentMode::Plan).then_some(PLAN_ONLY_INSTRUCTION),
        task.append_system_prompt.as_deref(),
        Some(task.prompt.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");

    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
    ];

    match task.mode {
        CodingAgentMode::Plan => {
            args.push("--mode".to_string());
            args.push("plan".to_string());
        }
        CodingAgentMode::Edit => {
            args.push("--dangerously-skip-permissions".to_string());
        }
    }

    if let Some(model) = model_for(task, models) {
        args.push("--model".to_string());
        args.push(model);
    }
    if let Some(effort) = task.effort {
        args.push("--effort".to_string());
        args.push(effort.as_str().to_string());
    }
    if let Some(session_id) = task.session_id.as_deref().filter(|id| !id.is_empty()) {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    }
    args
}

fn model_for(task: &CodingAgentTask, models: &TierSet<String>) -> Option<String> {
    task.model_tier
        .map(|tier| models.get(tier.as_str()).expect("every tier has a model"))
        .cloned()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn non_empty_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    text(value, key).filter(|value| !value.is_empty())
}

fn count(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .map_or(0, |count| count as i64)
}

/// Parses `agy --output-format stream-json` NDJSON lines into neutral events.
fn create_parser(initial_model: String) -> ParseLine {
    let mut model = initial_model;
    let mut answer = String::new();
    Box::new(move |line| {
        let event: Value = serde_json::from_str(line)?;
        if event.is_null() {
            anyhow::bail!("Cannot read properties of null (reading 'event')");
        }
        match text(&event, "event") {
            Some("init") => {
                if let Some(init_model) = event
                    .get("init")
                    .and_then(|init| non_empty_text(init, "model"))
                {
                    model = init_model.to_string();
                }
                if let Some(session_id) = non_empty_text(&event, "conversation_id") {
                    return Ok(vec![CodingAgentEvent::Session {
                        session_id: session_id.to_string(),
                    }]);
                }
                Ok(vec![])
            }
            Some("step_update") => {
                let Some(step) = event.get("step_update") else {
                    return Ok(vec![]);
                };
                if text(step, "step_type") == Some("agent_response")
                    && let Some(delta) = non_empty_text(step, "text_delta")
                {
                    answer.push_str(delta);
                    return Ok(vec![CodingAgentEvent::Text {
                        text: delta.to_string(),
                    }]);
                }
                Ok(vec![])
            }
            Some("result") => {
                let payload = event.get("result").unwrap_or(&event);
                let mut events = Vec::new();
                if let Some(usage) = payload.get("usage") {
                    let input_tokens = count(usage, "input_tokens");
                    let cache_read_tokens = count(usage, "cache_read_tokens");
                    let output_tokens = count(usage, "output_tokens");
                    if input_tokens > 0 || cache_read_tokens > 0 || output_tokens > 0 {
                        events.push(CodingAgentEvent::Usage {
                            usage: CodingAgentUsage {
                                model: model.clone(),
                                input_tokens,
                                cache_read_tokens,
                                cache_write_tokens: 0,
                                long_cache_write_tokens: 0,
                                output_tokens,
                                cost_usd: None,
                                subscription: false,
                            },
                        });
                    }
                }
                let refusals = denied_actions_of(payload);
                let status = text(payload, "status");
                let stop_reason = if status == Some("SUCCESS") {
                    CodingAgentStopReason::EndTurn
                } else {
                    CodingAgentStopReason::Error
                };
                let message = match stop_reason {
                    CodingAgentStopReason::EndTurn => non_empty_text(payload, "response")
                        .map(str::to_string)
                        .unwrap_or_else(|| answer.clone()),
                    CodingAgentStopReason::Error | CodingAgentStopReason::MaxTurns => {
                        non_empty_text(payload, "error")
                            .or_else(|| non_empty_text(payload, "response"))
                            .or(status)
                            .unwrap_or("Antigravity CLI task failed")
                            .to_string()
                    }
                };
                events.push(CodingAgentEvent::Result {
                    stop_reason,
                    turns: count(payload, "num_turns"),
                    message,
                    refusals,
                });
                Ok(events)
            }
            _ => Ok(vec![]),
        }
    })
}

fn denied_actions_of(payload: &Value) -> Option<Vec<CodingAgentRefusal>> {
    let refusals: Vec<CodingAgentRefusal> = payload
        .get("denied_actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| {
            let action = non_empty_text(entry, "action")
                .or_else(|| non_empty_text(entry, "display_name"))
                .unwrap_or_default()
                .to_string();
            let target = non_empty_text(entry, "target")
                .or_else(|| non_empty_text(entry, "display_name"))
                .unwrap_or_default()
                .to_string();
            CodingAgentRefusal { action, target }
        })
        .collect();
    (!refusals.is_empty()).then_some(refusals)
}

/// `agy task finished`, emitted once when a run's events end or are dropped.
struct Finish {
    owner: String,
    props: IndexMap<String, String>,
    started_at: i64,
    stopped: Arc<AtomicBool>,
    status: &'static str,
    done: bool,
}

impl Finish {
    fn emit(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        let mut props = self.props.clone();
        let status = if self.stopped.load(Ordering::SeqCst) {
            "stopped"
        } else {
            self.status
        };
        props.insert("status".to_string(), status.to_string());
        props.insert(
            "elapsed_ms".to_string(),
            (crate::support::now_ms() - self.started_at).to_string(),
        );
        track_event("agy task finished", Some(&self.owner), Some(props));
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.emit();
    }
}

fn finished_after(events: CodingAgentEvents, finish: Finish) -> CodingAgentEvents {
    futures::stream::unfold((Some(events), finish), |(events, mut finish)| async move {
        let mut events = events?;
        match events.next().await {
            Some(event) => {
                if let CodingAgentEvent::Result { stop_reason, .. } = &event {
                    finish.status = stop_reason.as_str();
                }
                Some((event, (Some(events), finish)))
            }
            None => {
                finish.emit();
                None
            }
        }
    })
    .boxed()
}

/// The CLI's run, its stop remembered for the finished event.
struct TrackedRun {
    run: Arc<dyn CodingAgentRun>,
    stopped: Arc<AtomicBool>,
    events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for TrackedRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        self.run.exited()
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.run.mark()
    }

    async fn started(&self) {
        self.run.started().await
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.run.stop();
    }
}

#[cfg(test)]
#[path = "agy_agent_tests.rs"]
mod tests;
