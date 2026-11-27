//! `/skills` and `/plugins`: what the agent has installed.

use super::CommandContext;

pub async fn skills(c: &CommandContext) -> String {
    let api = &c.ctx.api;
    // The active thread scopes the listing to this repo's workspace skills.
    let thread_id = c.thread_id.as_deref();
    match c.args.first().map(String::as_str) {
        None | Some("list") => match api.list_skills(thread_id).await {
            Ok(skills) if skills.is_empty() => {
                "No skills available. Drop SKILL.md bundles into the agent’s skills directory or this repo’s .claude/skills/.".into()
            }
            Ok(skills) => {
                let mut lines = vec!["Available skills:".to_string()];
                for s in skills {
                    let label = match s.source.as_str() {
                        "workspace" => " (workspace)".to_string(),
                        "plugin" => s.plugin_id.map(|p| format!(" (plugin: {p})")).unwrap_or_else(|| " (plugin)".into()),
                        _ => String::new(),
                    };
                    lines.push(format!("  {} — {}{label}", s.name, s.description));
                }
                lines.join("\n")
            }
            Err(e) => e.message,
        },
        Some("run") => {
            let Some(name) = c.args.get(1) else { return "Usage: /skills run <name>.".into() };
            match api.run_skill(name, thread_id).await {
                Ok(skill) => format!("▶ Running skill \"{skill}\"…"),
                Err(e) => e.message,
            }
        }
        Some(_) => "Usage: /skills [list] | /skills run <name>.".into(),
    }
}

pub async fn plugins(c: &CommandContext) -> String {
    match c.ctx.api.list_plugins().await {
        Ok(plugins) if plugins.is_empty() => {
            "No plugins installed. Drop an Agent Plugins directory into the agent’s plugins directory.".into()
        }
        Ok(plugins) => {
            let mut lines = vec!["Installed plugins:".to_string()];
            for p in plugins {
                let version = p.version.map(|v| format!(" v{v}")).unwrap_or_default();
                let description = p.description.filter(|d| !d.is_empty()).map(|d| format!(" — {d}")).unwrap_or_default();
                lines.push(format!("  {}{version}{description}", p.id));
                if !p.skills.is_empty() {
                    lines.push(format!("    skills: {}", p.skills.join(", ")));
                }
                if !p.mcp_servers.is_empty() {
                    lines.push(format!("    mcp servers: {}", p.mcp_servers.join(", ")));
                }
                // A half-broken plugin shows here rather than only in the container logs.
                for d in p.diagnostics {
                    lines.push(format!("    ! {d}"));
                }
            }
            lines.join("\n")
        }
        Err(e) => e.message,
    }
}
