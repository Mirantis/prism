//! Claude Code as a coding agent.
//!
//! Runs the `claude` CLI with `--output-format stream-json` and reads its NDJSON
//! stream back as the neutral events of `CodingAgent`. With the subscription on
//! (`subscription_switch`), every task runs on the Claude subscription signed in
//! to the CLI's home. Otherwise auth inherits from the runtime's environment:
//! the CLI picks up the same Bedrock or Anthropic credentials the agent itself
//! uses.
//!
//! Its home is the execution environment's `claude_home`, pointed at through
//! `CLAUDE_CONFIG_DIR`, so the CLI's own state (sessions, `.claude.json`) stays
//! out of the data-dir root and the user's real `~/.claude` is never touched.
//! The CLI discovers skills under `$CLAUDE_CONFIG_DIR/skills`, a symlink to the
//! environment's skills dir: both read the same bytes. It gets the runtime's MCP
//! servers in a config file written for each task (`mcp_config`), added to the
//! servers the CLI loads itself.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use super::authenticated_home::{SUBSCRIPTION_SETTINGS, SavedLogin, read_saved_login};
use super::credentials::has_claude_code_credentials;
use super::environment::claude_code_launch_environment;
use super::mcp_config::start_with_mcp_config;
use crate::config::{CONFIG, ClaudeCodeTierModel, CodingAgentName, TierSet};
use crate::lib::coding_agents::cli_run::{CliRunSpec, run_cli};
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentEvent, CodingAgentHome, CodingAgentMode, CodingAgentRefusal,
    CodingAgentRun, CodingAgentStopReason, CodingAgentTask, CodingAgentUsage,
    PLAN_ONLY_INSTRUCTION,
};
use crate::lib::coding_agents::deferred_run::{aborted, deferred_run};
use crate::lib::coding_agents::shared_skills_home::prepare_shared_skills_home;
use crate::lib::coding_agents::subscription::not_signed_in_message;
use crate::lib::coding_agents::subscription_switch::uses_subscription;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::get_execution_environment::{
    get_execution_environment, get_execution_environment_for,
};
use crate::log_warn;
use crate::support::js::{is_js_whitespace, len16, slice16, trim};

pub const DISPLAY_NAME: &str = "Claude Code";
pub const COMMAND: &str = "claude";

/// The input fields that name what a refused tool call was aimed at, most specific first.
pub const TARGET_FIELDS: &[&str] = &[
    "file_path",
    "notebook_path",
    "command",
    "url",
    "path",
    "pattern",
];

/// A refused call's target is cut here: a shell command can be a whole script.
pub const MAX_TARGET_CHARS: usize = 200;

/// The permission mode a task asks the CLI for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Plan,
    Auto,
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Plan => "plan",
            PermissionMode::Auto => "auto",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }
}

/// The deployment settings an invocation of the CLI reads.
#[derive(Debug, Clone)]
struct Settings {
    skip_permissions: bool,
    models: TierSet<ClaudeCodeTierModel>,
}

impl Settings {
    fn of_deployment() -> Settings {
        Settings {
            skip_permissions: CONFIG.claude_code_skip_permissions,
            models: CONFIG.coding_agent_models.claude_code.clone(),
        }
    }
}

pub struct ClaudeCodeAgent {
    /// A test hook; production runs the real binary in the selected environment.
    environment: Option<Arc<dyn ExecutionEnvironment>>,
}

/// The optional environment is a test hook; production runs the real binary.
pub fn create_claude_code_agent(
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgent> {
    Arc::new(ClaudeCodeAgent { environment })
}

#[async_trait]
impl CodingAgent for ClaudeCodeAgent {
    fn id(&self) -> CodingAgentName {
        CodingAgentName::ClaudeCode
    }

    fn display_name(&self) -> &str {
        DISPLAY_NAME
    }

    /// The environment's `claude_home`, unless `CLAUDE_CONFIG_DIR` names it.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        let env = self
            .environment
            .clone()
            .unwrap_or_else(get_execution_environment);
        let operator_home = std::env::var("CLAUDE_CONFIG_DIR").ok();
        prepare_shared_skills_home(&*env, &env.paths().claude_home, operator_home.as_deref()).await
    }

    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool> {
        Ok(has_claude_code_credentials(env).await)
    }

    /// A deferred run: with the subscription on, the home's login is asked first
    /// and anything but a subscription login fails the task with
    /// `not_signed_in_message` (naming the host home for a folder outside the
    /// deployment's environment); then the CLI starts, through
    /// `start_with_mcp_config` when the task has MCP servers.
    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        // The environment the CLI runs in, which is also where its home and its
        // MCP config have to be.
        let target = self
            .environment
            .clone()
            .unwrap_or_else(|| get_execution_environment_for(task.workdir.as_deref()));
        let home = target.paths().claude_home;
        let task_id = task.task_id.clone();
        deferred_run(
            &task_id,
            DISPLAY_NAME,
            Box::new(move |signal| {
                Box::pin(async move {
                    let subscription = uses_subscription(CodingAgentName::ClaudeCode);
                    // Asked on every run, so a sign-in or a sign-out applies to the next
                    // task. Anything but a subscription login fails the task, which then
                    // bills nothing.
                    if subscription
                        && read_saved_login(&*target, &task.env, &home, Some(signal.clone()))
                            .await?
                            != SavedLogin::Subscription
                    {
                        // A folder outside the deployment's environment runs here, on a
                        // home Coding agents doesn't sign in.
                        let host_home = task
                            .workdir
                            .as_deref()
                            .filter(|workdir| {
                                !workdir.is_empty()
                                    && !get_execution_environment().serves_path(workdir)
                            })
                            .map(|_| home.clone());
                        anyhow::bail!(not_signed_in_message(
                            CodingAgentName::ClaudeCode,
                            host_home.as_deref()
                        ));
                    }
                    if signal.is_cancelled() {
                        return Err(aborted());
                    }
                    let env = claude_code_launch_environment(&task.env, subscription);
                    let on_bedrock =
                        env.get("CLAUDE_CODE_USE_BEDROCK").map(String::as_str) == Some("1");
                    let settings = Settings::of_deployment();
                    let launch_task = task.clone();
                    let launch_target = target.clone();
                    let launch = move |mcp_config_path: Option<String>| {
                        let mut env = env;
                        // Stated on the task's env rather than inherited from this
                        // process: the CLI runs in the execution environment.
                        env.insert("CLAUDE_CONFIG_DIR".to_string(), home);
                        let parse_task = launch_task.clone();
                        let parse_settings = settings.clone();
                        run_cli(
                            CliRunSpec {
                                task_id: launch_task.task_id.clone(),
                                display_name: DISPLAY_NAME.to_string(),
                                command: COMMAND.to_string(),
                                args: build_args(
                                    &launch_task,
                                    on_bedrock,
                                    subscription,
                                    mcp_config_path.as_deref(),
                                    &settings,
                                ),
                                cwd: launch_task.workdir.clone(),
                                env,
                                parse_line: Box::new(move |line| {
                                    parse_line(line, &parse_task, &parse_settings, subscription)
                                }),
                            },
                            Some(launch_target),
                        )
                    };
                    if task.mcp_servers.is_empty() {
                        Ok(launch(None))
                    } else {
                        start_with_mcp_config(
                            &task,
                            target.clone(),
                            signal,
                            Box::new(move |path| launch(Some(path))),
                        )
                        .await
                    }
                })
            }),
        )
    }
}

/// The permission mode a task asks the CLI for. The bypass is for edit tasks the
/// operator runs where nothing else needs to check them; a plan task stays read-only.
fn permission_mode_for(task: &CodingAgentTask, settings: &Settings) -> PermissionMode {
    if task.mode == CodingAgentMode::Plan {
        return PermissionMode::Plan;
    }
    if settings.skip_permissions {
        PermissionMode::BypassPermissions
    } else {
        PermissionMode::Auto
    }
}

/// `-p <prompt> --output-format stream-json --verbose --max-turns <n>`, the
/// permission flags, `--settings` on the subscription, `--append-system-prompt`
/// with the plan instruction and the caller's text joined by a blank line,
/// `--model` and `--effort` only when the task names them, `--resume`,
/// `--disallowed-tools AskUserQuestion`, `--mcp-config` and `--debug`, in that
/// order.
fn build_args(
    task: &CodingAgentTask,
    on_bedrock: bool,
    subscription: bool,
    mcp_config_path: Option<&str>,
    settings: &Settings,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".to_string(),
        task.prompt.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        // required with --output-format stream-json + -p
        "--verbose".to_string(),
        "--max-turns".to_string(),
        task.max_turns.to_string(),
    ];

    // The CLI's own checks decide each action: its classifier in auto mode, the
    // read-only rule in plan mode. With no terminal a refused action is skipped,
    // the run goes on, and the result line lists it.
    let permission_mode = permission_mode_for(task, settings);
    if permission_mode == PermissionMode::BypassPermissions {
        args.push("--dangerously-skip-permissions".to_string());
    } else {
        args.push("--permission-mode".to_string());
        args.push(permission_mode.as_str().to_string());
    }
    // On the subscription the CLI takes the claude.ai login and no other, also
    // when the repository's own settings name another provider or key.
    if subscription {
        args.push("--settings".to_string());
        args.push(SUBSCRIPTION_SETTINGS.clone());
    }

    // The CLI enforces plan mode too; stating it keeps the model planning instead of
    // spending turns on actions the CLI refuses.
    // Always append, never replace: --system-prompt would substitute Claude Code's
    // default harness (tool selection, todo discipline, search conventions), which is
    // what a plan-mode delegation most needs. Both the plan constraint and a caller's
    // own framing ride one flag, so neither can drop the other.
    let appended = [
        (task.mode == CodingAgentMode::Plan).then_some(PLAN_ONLY_INSTRUCTION),
        task.append_system_prompt.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    if !appended.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(appended);
    }
    // An omitted tier or effort must emit no selection flag: the deployment's
    // configured model and effort stay in force. Keep both optional, including
    // on resume; a default tier would silently override that configuration.
    if let Some(tier) = task.model_tier {
        let models = settings
            .models
            .get(tier.as_str())
            .expect("every tier has a model");
        args.push("--model".to_string());
        args.push(if on_bedrock {
            models.bedrock.clone()
        } else {
            models.default.clone()
        });
    }
    if let Some(effort) = task.effort {
        args.push("--effort".to_string());
        args.push(effort.as_str().to_string());
    }
    if let Some(session_id) = task.session_id.as_deref().filter(|id| !id.is_empty()) {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    }
    args.push("--disallowed-tools".to_string());
    args.push("AskUserQuestion".to_string());
    // The CLI also loads its own servers. On a name clash, it uses the server in this file.
    if let Some(path) = mcp_config_path {
        args.push("--mcp-config".to_string());
        args.push(path.to_string());
    }
    if task.debug == Some(true) {
        args.push("--debug".to_string());
    }

    args
}

/// A field's text, when the field is a string.
fn text<'a>(line: &'a Value, key: &str) -> Option<&'a str> {
    line.get(key).and_then(Value::as_str)
}

/// A field's value unless it is `null` or absent, as `??` reads it.
fn present<'a>(line: &'a Value, key: &str) -> Option<&'a Value> {
    line.get(key).filter(|value| !value.is_null())
}

/// `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// One stream line to events. Warns when the opening `init` line reports a
/// permission mode other than the task's.
fn parse_line(
    line: &str,
    task: &CodingAgentTask,
    settings: &Settings,
    subscription: bool,
) -> anyhow::Result<Vec<CodingAgentEvent>> {
    let parsed: Value = serde_json::from_str(line)?;
    if parsed.is_null() {
        anyhow::bail!("Cannot read properties of null (reading 'subtype')");
    }
    let mut events = Vec::new();

    // Where the mode the task asked for is unavailable (auto mode for the model,
    // the bypass when settings disable it), the CLI starts in Manual mode and
    // refuses every action that needs approval; the refusals alone read like a
    // policy decision.
    let expected_mode = permission_mode_for(task, settings).as_str();
    if let Some(fields) = unexpected_mode(&parsed, &task.task_id, expected_mode) {
        log_warn!(
            fields,
            "[AgentTask] Claude Code did not start in {} mode, so it refuses every action that needs approval; check that its model supports the mode and that no settings disable it",
            expected_mode
        );
    }

    // The CLI announces the session on its opening line (`system`/`init`), long
    // before the `result` line, and repeats it on every line after. Reporting it
    // as it appears is what lets a *stopped* task be resumed.
    if let Some(session_id) = text(&parsed, "session_id") {
        events.push(CodingAgentEvent::Session {
            session_id: session_id.to_string(),
        });
    }

    let line_type = text(&parsed, "type");
    let content = parsed
        .get("message")
        .and_then(|message| message.get("content"))
        .filter(|content| crate::support::js::truthy(content));
    if line_type == Some("assistant") && content.is_some() {
        for block in content.and_then(Value::as_array).into_iter().flatten() {
            if text(block, "type") == Some("text")
                && let Some(text) = text(block, "text")
            {
                events.push(CodingAgentEvent::Text {
                    text: text.to_string(),
                });
            }
        }
    } else if line_type == Some("result") {
        // On the `result` line: every model the run used, its own side calls
        // included. A run stopped before this line reports no usage.
        let model_usage = present(&parsed, "modelUsage").and_then(Value::as_object);
        for (model, usage) in model_usage.into_iter().flatten() {
            let count = |key: &str| {
                present(usage, key)
                    .and_then(Value::as_f64)
                    .map_or(0, |count| count as i64)
            };
            events.push(CodingAgentEvent::Usage {
                usage: CodingAgentUsage {
                    model: model.clone(),
                    input_tokens: count("inputTokens"),
                    cache_read_tokens: count("cacheReadInputTokens"),
                    cache_write_tokens: count("cacheCreationInputTokens"),
                    long_cache_write_tokens: count("cacheCreationEphemeral1hInputTokens"),
                    output_tokens: count("outputTokens"),
                    cost_usd: usage.get("costUSD").and_then(Value::as_f64),
                    subscription,
                },
            });
        }
        let refusals = match present(&parsed, "permission_denials") {
            Some(denials) => denials
                .as_array()
                .into_iter()
                .flatten()
                .map(refusal_of)
                .collect::<anyhow::Result<Vec<_>>>()?,
            None => Vec::new(),
        };
        let message = present(&parsed, "result")
            .map(js_string)
            .or_else(|| present(&parsed, "subtype").map(js_string))
            .unwrap_or_else(|| "error".to_string());
        events.push(CodingAgentEvent::Result {
            stop_reason: stop_reason_of(&parsed),
            turns: present(&parsed, "num_turns")
                .and_then(Value::as_f64)
                .map_or(0, |turns| turns as i64),
            message,
            refusals: (!refusals.is_empty()).then_some(refusals),
        });
    }

    Ok(events)
}

/// The fields of the warning an opening `init` line earns when it reports a
/// permission mode other than `expected_mode`.
fn unexpected_mode(parsed: &Value, task_id: &str, expected_mode: &str) -> Option<Value> {
    let permission_mode = parsed.get("permissionMode");
    if text(parsed, "subtype") != Some("init")
        || permission_mode.and_then(Value::as_str) == Some(expected_mode)
    {
        return None;
    }
    let mut fields = Map::new();
    fields.insert("taskId".to_string(), json!(task_id));
    if let Some(model) = parsed.get("model") {
        fields.insert("model".to_string(), model.clone());
    }
    if let Some(mode) = permission_mode {
        fields.insert("permissionMode".to_string(), mode.clone());
    }
    fields.insert("expectedMode".to_string(), json!(expected_mode));
    Some(Value::Object(fields))
}

fn stop_reason_of(line: &Value) -> CodingAgentStopReason {
    if text(line, "subtype") == Some("error_max_turns") {
        return CodingAgentStopReason::MaxTurns;
    }
    // A failed model call ends the run with subtype `success` and `is_error` set.
    let is_error = line.get("is_error").is_some_and(crate::support::js::truthy);
    if text(line, "subtype") == Some("success") && !is_error {
        return CodingAgentStopReason::EndTurn;
    }
    CodingAgentStopReason::Error
}

/// The tool and the first string field of `TARGET_FIELDS` (else the input as
/// JSON), whitespace folded to one line and cut at `MAX_TARGET_CHARS` with `…`.
fn refusal_of(denial: &Value) -> anyhow::Result<CodingAgentRefusal> {
    let tool_input = denial
        .get("tool_input")
        .filter(|input| !input.is_null())
        .ok_or_else(|| {
            anyhow::anyhow!("Cannot read properties of undefined (reading 'file_path')")
        })?;
    let field = TARGET_FIELDS
        .iter()
        .find_map(|name| tool_input.get(*name).and_then(Value::as_str));
    let raw = match field {
        Some(value) => value.to_string(),
        None => crate::support::js::stringify(tool_input),
    };
    // One line per refusal in the result, so a multi-line command is folded.
    let target = trim(&fold_whitespace(&raw)).to_string();
    let target = if len16(&target) > MAX_TARGET_CHARS {
        format!("{}…", slice16(&target, 0, MAX_TARGET_CHARS))
    } else {
        target
    };
    Ok(CodingAgentRefusal {
        action: denial.get("tool_name").map(js_string).unwrap_or_default(),
        target,
    })
}

/// `text.replace(/\s+/g, ' ')`.
fn fold_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for ch in text.chars() {
        if is_js_whitespace(ch) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out
}

#[cfg(test)]
#[path = "claude_code_agent_tests.rs"]
mod tests;
