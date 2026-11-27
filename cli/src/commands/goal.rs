//! `/goal`: set a background goal, or manage the conversation's goal.

use super::CommandContext;
use crate::api::Goal;
use crate::util::js_number;

/// Single-word subcommands; anything else is an objective.
const GOAL_SUBCOMMANDS: [&str; 8] = [
    "status", "list", "stop", "clear", "cancel", "off", "pause", "resume",
];

fn format_goal(g: &Goal) -> String {
    let budget = match g.token_budget {
        Some(b) => format!("{}/{} tokens", js_number(g.tokens_used), js_number(b)),
        None => format!("{} tokens", js_number(g.tokens_used)),
    };
    let mut lines = vec![
        format!("Goal: {}", g.objective),
        format!("Status: {}", g.status),
        format!(
            "Turns: {}/{}",
            js_number(g.turn_count),
            js_number(g.max_turns)
        ),
        format!("Tokens: {budget}"),
    ];
    if let Some(reason) = g.last_reason.as_ref().filter(|r| !r.is_empty()) {
        lines.push(format!("Last: {reason}"));
    }
    lines.join("\n")
}

pub async fn goal(c: &CommandContext) -> String {
    let api = &c.ctx.api;
    let single = if c.args.len() == 1 {
        Some(c.args[0].to_lowercase())
    } else {
        None
    };
    let is_management = c.args.is_empty()
        || single
            .as_deref()
            .is_some_and(|s| GOAL_SUBCOMMANDS.contains(&s));

    if single.as_deref() == Some("list") {
        return match api.list_goals().await {
            Ok(goals) if goals.is_empty() => "No goals yet.".into(),
            Ok(goals) => goals
                .iter()
                .map(|g| {
                    let mark = if g.status == "active" { "▶" } else { "•" };
                    format!(
                        "{mark} [{}] {} ({}/{} turns)",
                        g.status,
                        g.objective,
                        js_number(g.turn_count),
                        js_number(g.max_turns)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
            Err(e) => e.message,
        };
    }

    if is_management {
        let Some(thread_id) = &c.thread_id else {
            return "No active conversation yet.".into();
        };
        let current = match api.get_thread_goal(thread_id).await {
            Ok(g) => g,
            Err(e) => return e.message,
        };
        if single.is_none() || single.as_deref() == Some("status") {
            return current
                .map(|g| format_goal(&g))
                .unwrap_or_else(|| "No active goal in this conversation.".into());
        }
        let Some(current) = current else {
            return "No active goal in this conversation.".into();
        };
        let result = match single.as_deref() {
            Some("pause") => api
                .pause_goal(&current.id)
                .await
                .map(|g| format!("Goal paused: \"{}\".", g.objective)),
            Some("resume") => api
                .resume_goal(&current.id)
                .await
                .map(|g| format!("Goal resumed: \"{}\".", g.objective)),
            _ => api
                .stop_goal(&current.id)
                .await
                .map(|g| format!("Goal stopped: \"{}\".", g.objective)),
        };
        return result.unwrap_or_else(|e| e.message);
    }

    let Some(thread_id) = &c.thread_id else {
        return "Start a conversation before setting a goal.".into();
    };
    match api.create_goal(thread_id, &c.raw_args).await {
        Ok(g) => format!(
            "Goal set: \"{}\". I'll keep working on it across up to {} turns until it's done.",
            g.objective,
            js_number(g.max_turns)
        ),
        Err(e) => e.message,
    }
}
