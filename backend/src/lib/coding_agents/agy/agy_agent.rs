//! Antigravity CLI (`agy`) as a coding agent: `agy -p <prompt> --output-format
//! stream-json` read back as the neutral events of `CodingAgent`.

use std::sync::Arc;

use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::config::{CONFIG, CodingAgentName, TierSet};
use crate::lib::coding_agents::cli_probe::probe_cli;
use crate::lib::coding_agents::cli_run::{CliRunSpec, FlushEvents, ParseLine, run_cli};
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentEvent, CodingAgentHome, CodingAgentMode, CodingAgentRefusal,
    CodingAgentRun, CodingAgentStopReason, CodingAgentTask, CodingAgentUsage,
    PLAN_ONLY_INSTRUCTION,
};
use crate::lib::coding_agents::shared_skills_home::points_at;
use crate::lib::coding_agents::tracked_run::track_run;
use crate::lib::execution_environments::docker::volumes::CONTAINER_PATHS;
use crate::lib::execution_environments::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ProcessEnv, io_error_kind,
};
use crate::lib::execution_environments::get_execution_environment::{
    get_execution_environment, get_execution_environment_for,
};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_warn;

pub const DISPLAY_NAME: &str = "Antigravity CLI";
pub const COMMAND: &str = "agy";

/// The name a usage row gets when `agy` runs the model its own settings choose.
const UNNAMED_MODEL: &str = "agy";

/// Per-session settings passed to `agy` when `GEMINI_API_KEY` is set, routing
/// directly to the Gemini API without modifying `~/.gemini/antigravity-cli/settings.json`.
const GEMINI_API_KEY_SETTINGS: &str = r#"{"modelProvider":"gemini"}"#;

/// Maximum bytes read from an existing user-owned `~/.gemini/config/skills.json`.
const MAX_SKILLS_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgyAuthMethod {
    GeminiApiKey,
    Account,
}

impl AgyAuthMethod {
    fn as_str(self) -> &'static str {
        match self {
            AgyAuthMethod::GeminiApiKey => "gemini-api-key",
            AgyAuthMethod::Account => "account",
        }
    }
}

fn agy_auth_method(env: &ProcessEnv) -> AgyAuthMethod {
    if env
        .get("GEMINI_API_KEY")
        .is_some_and(|value| !value.trim().is_empty())
    {
        return AgyAuthMethod::GeminiApiKey;
    }
    AgyAuthMethod::Account
}

/// `agy` appends its active reasoning effort to the model id reported in `init`
/// (e.g. `gemini-3.8-flash-low`, `gemini-4-neon-xhigh`). Strip that suffix so
/// Spending matches the base model in the catalog.
fn strip_effort_suffix(model: &str) -> &str {
    for suffix in ["-low", "-medium", "-high", "-xhigh", "-max"] {
        if let Some(base) = model.strip_suffix(suffix)
            && !base.is_empty()
        {
            return base;
        }
    }
    model
}

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

    /// Shares the runtime's skills directory with `agy` via its global
    /// discovery manifest (`<home>/.gemini/config/skills.json`), which loads
    /// alongside any user-owned `~/.gemini/config/skills/` directory without
    /// replacing it.
    ///
    /// If `<home>/.gemini/config/skills` already points at the runtime's skills
    /// dir or `<home>/.gemini/config/skills.json` already exists, nothing is
    /// written and `skills_linked` reports whether the runtime's skills dir is
    /// already referenced. Any filesystem failure is logged and reported as
    /// `skills_linked: false` so startup never fails for optional skills.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        let env = self.target();
        let base_env = env.base_env();
        let Some(home) = home_dir_in(&*env, &base_env) else {
            return Ok(CodingAgentHome {
                config_dir: String::new(),
                skills_linked: false,
            });
        };
        let config_dir = format!("{home}/.gemini/config");
        let skills_dir = env.paths().skills_dir;
        let link = format!("{config_dir}/skills");
        let manifest = format!("{config_dir}/skills.json");
        let files = env.files();

        if points_at(&*env, &link, &skills_dir).await {
            return Ok(CodingAgentHome {
                config_dir,
                skills_linked: true,
            });
        }

        match files.lstat(&manifest).await {
            Ok(_) => Ok(CodingAgentHome {
                config_dir: config_dir.clone(),
                skills_linked: manifest_references_skills(
                    &*env,
                    &config_dir,
                    &manifest,
                    &skills_dir,
                )
                .await,
            }),
            Err(err) if io_error_kind(&err) == Some(std::io::ErrorKind::NotFound) => {
                if let Err(err) = files.mkdir(&config_dir).await {
                    log_warn!(
                        json!({ "configDir": config_dir, "err": err_json(&err) }),
                        "[Startup] Could not prepare Antigravity CLI skills directory"
                    );
                    return Ok(CodingAgentHome {
                        config_dir,
                        skills_linked: false,
                    });
                }
                let target = files
                    .realpath(&skills_dir)
                    .await
                    .unwrap_or_else(|_| skills_dir.clone());
                let content = format!(
                    "{}\n",
                    serde_json::to_string_pretty(&json!({
                        "entries": [{ "path": target }]
                    }))?
                );
                if let Err(err) = files.write_text(&manifest, &content, None).await {
                    log_warn!(
                        json!({ "manifest": manifest, "target": target, "err": err_json(&err) }),
                        "[Startup] Could not write Antigravity CLI skills manifest"
                    );
                    return Ok(CodingAgentHome {
                        config_dir,
                        skills_linked: false,
                    });
                }
                Ok(CodingAgentHome {
                    config_dir,
                    skills_linked: true,
                })
            }
            Err(err) => {
                log_warn!(
                    json!({ "manifest": manifest, "err": err_json(&err) }),
                    "[Startup] Could not inspect Antigravity CLI skills manifest"
                );
                Ok(CodingAgentHome {
                    config_dir,
                    skills_linked: false,
                })
            }
        }
    }

    /// Available when `agy` can serve models in the execution environment:
    /// via `GEMINI_API_KEY` (`--settings '{"modelProvider":"gemini"}'`), or via
    /// a local signed-in account whose `~/.gemini/antigravity-cli/jetski_state.pbtxt`
    /// exists.
    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool> {
        let target = self.target();
        let auth = agy_auth_method(env);
        if auth == AgyAuthMethod::Account && !has_agy_home(&*target, env).await {
            return Ok(false);
        }
        let args = match auth {
            AgyAuthMethod::GeminiApiKey => vec![
                "--settings".to_string(),
                GEMINI_API_KEY_SETTINGS.to_string(),
                "models".to_string(),
            ],
            AgyAuthMethod::Account => vec!["models".to_string()],
        };
        Ok(probe_cli(&*target, COMMAND, &args, env.clone(), None)
            .await
            .is_ok_and(|run| {
                run.exit_code == Some(0) && models_output_signed_in(&run.stdout, &run.stderr)
            }))
    }

    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        let auth = agy_auth_method(&task.env);
        let started_at = crate::support::now_ms();
        let mut props = IndexMap::new();
        props.insert("task.id".to_string(), task.task_id.clone());
        props.insert("auth.method".to_string(), auth.as_str().to_string());
        let owner = CONFIG.owner_user_id();
        track_event("agy task started", Some(&owner), Some(props.clone()));

        let run_in = self
            .environment
            .clone()
            .unwrap_or_else(|| get_execution_environment_for(task.workdir.as_deref()));
        let models = CONFIG.coding_agent_models.agy.clone();
        let requested_model = model_for(&task, &models);
        let subscription = auth == AgyAuthMethod::Account;
        let (parse_line, flush) = create_parser(
            requested_model.unwrap_or_else(|| UNNAMED_MODEL.to_string()),
            subscription,
        );
        let run = run_cli(
            CliRunSpec {
                task_id: task.task_id.clone(),
                display_name: DISPLAY_NAME.to_string(),
                command: COMMAND.to_string(),
                args: build_args(&task, auth, &models),
                cwd: task.workdir.clone(),
                env: task.env.clone(),
                parse_line,
                flush: Some(flush),
            },
            Some(run_in),
        );

        track_run(run, "agy task finished", owner, props, started_at)
    }
}

/// The home directory where `agy` keeps `.gemini` inside `environment`.
fn home_dir_in(environment: &dyn ExecutionEnvironment, env: &ProcessEnv) -> Option<String> {
    if let Some(home) = env.get("HOME").filter(|value| !value.is_empty()) {
        return Some(home.trim_end_matches(['/', '\\']).to_string());
    }
    if environment.id() == ExecutionEnvironmentName::Docker {
        return Some(CONTAINER_PATHS.home_dir.to_string());
    }
    if let Some((_, home)) = env
        .iter()
        .find(|(key, value)| key.eq_ignore_ascii_case("USERPROFILE") && !value.is_empty())
    {
        return Some(home.trim_end_matches(['/', '\\']).to_string());
    }
    None
}

/// Fast check before spawning `agy`: the CLI creates `jetski_state.pbtxt` under
/// `~/.gemini/antigravity-cli` once onboarded, so its absence skips the probe.
async fn has_agy_home(environment: &dyn ExecutionEnvironment, env: &ProcessEnv) -> bool {
    let Some(home) = home_dir_in(environment, env) else {
        return false;
    };
    environment
        .files()
        .stat(&format!(
            "{home}/.gemini/antigravity-cli/jetski_state.pbtxt"
        ))
        .await
        .is_ok()
}

/// `agy models` prints model lines when signed in, and `Error: Please sign in
/// to view available models.` (still exiting 0) when nobody is signed in.
pub(crate) fn models_output_signed_in(stdout: &str, stderr: &str) -> bool {
    let combined = format!("{stdout}\n{stderr}");
    if combined.contains("Please sign in") || combined.contains("Authentication required") {
        return false;
    }
    stdout.lines().any(|raw| {
        let line = raw.rsplit('\r').next().unwrap_or(raw).trim();
        !line.is_empty()
            && !line.starts_with("Fetching available models")
            && !line.starts_with("Error:")
    })
}

/// Whether an existing `skills.json` discovery manifest lists `skills_dir` in `entries`.
async fn manifest_references_skills(
    environment: &dyn ExecutionEnvironment,
    config_dir: &str,
    manifest: &str,
    skills_dir: &str,
) -> bool {
    let files = environment.files();
    let Ok(raw) = files
        .read_text(manifest, Some(MAX_SKILLS_MANIFEST_BYTES))
        .await
    else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let Some(entries) = parsed.get("entries").and_then(Value::as_array) else {
        return false;
    };
    let canonical_skills = files.realpath(skills_dir).await.ok();
    for entry in entries {
        let Some(path) = non_empty_text(entry, "path") else {
            continue;
        };
        let resolved = if std::path::Path::new(path).is_absolute() {
            path.to_string()
        } else {
            format!("{config_dir}/{path}")
        };
        if resolved == skills_dir
            || canonical_skills
                .as_deref()
                .is_some_and(|canonical| resolved == canonical)
            || points_at(environment, &resolved, skills_dir).await
        {
            return true;
        }
    }
    false
}

/// `-p <prompt> --output-format stream-json`, `--mode plan` for plan tasks or
/// `--dangerously-skip-permissions` for edit tasks, plus optional `--settings`,
/// `--model`, `--effort` and `--resume`.
///
/// Headless `agy` denies shell commands under `accept-edits` when stdin is
/// closed, so edit tasks pass `--dangerously-skip-permissions`. Plan tasks pass
/// `--mode plan` and prepend `PLAN_ONLY_INSTRUCTION`.
fn build_args(
    task: &CodingAgentTask,
    auth: AgyAuthMethod,
    models: &TierSet<String>,
) -> Vec<String> {
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

    if auth == AgyAuthMethod::GeminiApiKey {
        args.push("--settings".to_string());
        args.push(GEMINI_API_KEY_SETTINGS.to_string());
    }

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

/// Parses `agy --output-format stream-json` NDJSON lines into neutral events,
/// plus an EOF flusher that emits any buffered in-progress `text_delta` if the
/// process exits or is stopped before reaching `state: "DONE"` or `result`.
fn create_parser(initial_model: String, subscription: bool) -> (ParseLine, FlushEvents) {
    let mut model = strip_effort_suffix(&initial_model).to_string();
    let pending_text = Arc::new(parking_lot::Mutex::new(String::new()));
    let flush_pending = pending_text.clone();
    let mut current_step_index: Option<i64> = None;
    let mut answers: Vec<String> = Vec::new();
    let parse_line: ParseLine = Box::new(move |line| {
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
                    model = strip_effort_suffix(init_model).to_string();
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
                if text(step, "step_type") == Some("agent_response") {
                    let mut events = Vec::new();
                    let step_index = step.get("step_index").and_then(Value::as_i64);
                    if step_index.is_some()
                        && current_step_index.is_some()
                        && step_index != current_step_index
                    {
                        let flushed = std::mem::take(&mut *pending_text.lock());
                        if !flushed.is_empty() {
                            answers.push(flushed.clone());
                            events.push(CodingAgentEvent::Text { text: flushed });
                        }
                    }
                    if step_index.is_some() {
                        current_step_index = step_index;
                    }
                    if let Some(delta) = non_empty_text(step, "text_delta") {
                        pending_text.lock().push_str(delta);
                    }
                    if text(step, "state") == Some("DONE") {
                        let flushed = std::mem::take(&mut *pending_text.lock());
                        current_step_index = None;
                        if !flushed.is_empty() {
                            answers.push(flushed.clone());
                            events.push(CodingAgentEvent::Text { text: flushed });
                        }
                    }
                    return Ok(events);
                }
                Ok(vec![])
            }
            Some("result") => {
                let payload = event.get("result").unwrap_or(&event);
                let mut events = Vec::new();
                let flushed = std::mem::take(&mut *pending_text.lock());
                current_step_index = None;
                if !flushed.is_empty() {
                    answers.push(flushed.clone());
                    events.push(CodingAgentEvent::Text { text: flushed });
                }
                if let Some(usage) = payload.get("usage") {
                    // `agy` reports uncached `input_tokens` separately from `cache_read_tokens`
                    // (`total_tokens = input_tokens + output_tokens`), so do not subtract cache reads.
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
                                // Account-based `agy` sessions run under a Google plan ($0
                                // subscription usage); `GEMINI_API_KEY` bills per token.
                                subscription,
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
                        .unwrap_or_else(|| answers.join("\n\n")),
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
    });
    let flush: FlushEvents = Box::new(move || {
        let flushed = std::mem::take(&mut *flush_pending.lock());
        if flushed.is_empty() {
            Vec::new()
        } else {
            vec![CodingAgentEvent::Text { text: flushed }]
        }
    });
    (parse_line, flush)
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

#[cfg(test)]
#[path = "agy_agent_tests.rs"]
mod tests;
