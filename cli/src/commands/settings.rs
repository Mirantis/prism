//! Commands that change the agent's settings: its name, its models and its guide.

use super::CommandContext;
use crate::api::ModelSelection;
use crate::editor::{edit_text, resolve_editor};

pub async fn rename(c: &CommandContext) -> String {
    let name = &c.raw_args;
    if name.is_empty() {
        return "Usage: /rename <new name> (up to 64 characters: letters, digits, spaces and - ' . &).".into();
    }
    match c.ctx.api.set_name(name).await {
        Ok(result) => format!("Renamed to \"{result}\"."),
        Err(e) => e.message,
    }
}

/// The model a model command names: `None` for "reset", or its usage when it names none.
fn model_arg<'a>(c: &'a CommandContext, command: &str) -> Result<Option<&'a str>, String> {
    let arg = c
        .args
        .first()
        .ok_or_else(|| format!("Usage: {command} <model-id|reset>."))?;
    Ok((arg != "reset").then_some(arg.as_str()))
}

pub async fn model(c: &CommandContext) -> String {
    let value = match model_arg(c, "/model") {
        Ok(v) => v,
        Err(usage) => return usage,
    };
    match c.ctx.api.set_model(value).await {
        Ok(Some(model)) => format!("Model set to \"{model}\"."),
        Ok(None) => "Model reset to the server default.".into(),
        Err(e) => e.message,
    }
}

/// One kind of run whose model falls back to the main model.
pub struct RunModel {
    pub command: &'static str,
    pub path: &'static str,
    /// "Heartbeat model", as the reply names the setting.
    pub setting: &'static str,
    /// "heartbeats", as the reply names the runs.
    pub runs: &'static str,
}

pub const HEARTBEAT_MODEL: RunModel = RunModel {
    command: "/heartbeat-model",
    path: "/agents/heartbeat-model",
    setting: "Heartbeat model",
    runs: "heartbeats",
};

pub const CRON_MODEL: RunModel = RunModel {
    command: "/cron-model",
    path: "/agents/cron-model",
    setting: "Scheduled-task model",
    runs: "scheduled tasks",
};

pub async fn run_model(c: &CommandContext, kind: &RunModel) -> String {
    let value = match model_arg(c, kind.command) {
        Ok(v) => v,
        Err(usage) => return usage,
    };
    match c.ctx.api.set_model_setting(kind.path, value).await {
        Ok(r) => match r.model {
            Some(model) => format!("{} set to \"{model}\".", kind.setting),
            None => format!(
                "{} reset — {} use the main model (\"{}\").",
                kind.setting, kind.runs, r.effective
            ),
        },
        Err(e) => e.message,
    }
}

/// The tiers in force, as `small <id>, large <id>`.
fn describe_tiers(selection: &ModelSelection) -> String {
    selection
        .tiers
        .iter()
        .filter_map(|(tier, effective)| effective.as_ref().map(|m| format!("{tier} {m}")))
        .collect::<Vec<_>>()
        .join(", ")
}

pub async fn model_mode(c: &CommandContext) -> String {
    let arg = c.args.first().map(String::as_str);
    if let Some(a) = arg
        && a != "auto"
        && a != "fixed"
    {
        return "Usage: /model-mode [auto|fixed].".into();
    }
    let result = match arg {
        None => c.ctx.api.get_model_selection().await.map(|s| {
            if s.effective_mode == "fixed" {
                "Model mode is fixed.".to_string()
            } else {
                format!("Model mode is auto: {}.", describe_tiers(&s))
            }
        }),
        Some(mode) => c.ctx.api.set_model_mode(mode).await.map(|s| {
            if mode == "fixed" {
                "Model mode set to fixed.".to_string()
            } else {
                format!("Model mode set to auto: {}.", describe_tiers(&s))
            }
        }),
    };
    result.unwrap_or_else(|e| e.message)
}

/// Edit the agent guide, the one identity document the agent cannot write itself.
pub async fn agent_guide(c: &CommandContext) -> String {
    let current = match c.ctx.api.get_details().await {
        Ok(d) => d.doc("agentMd"),
        Err(e) => return e.message,
    };
    // The editor takes the terminal, so the TUI stands down first.
    let result = match c.ctx.suspended(move || edit_text(&current, ".md")).await {
        Ok(r) => r,
        Err(e) => return format!("Could not open {}: {e}", resolve_editor()),
    };
    if !result.changed {
        return "Agent guide unchanged.".into();
    }
    if let Err(e) = c.ctx.api.set_agent_guide(&result.text).await {
        // The edit is still on disk: say where, rather than losing the work.
        return format!(
            "{}\nYour edit is kept at {}",
            e.message,
            result.file.display()
        );
    }
    result.discard();
    "Agent guide saved. It reaches the agent on its next turn.".into()
}
