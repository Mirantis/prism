//! `/compact` and `/update`: work the runtime does in the background, whose
//! progress arrives on the chat socket.

use super::CommandContext;

pub async fn compact(c: &CommandContext) -> String {
    let Some(thread_id) = &c.thread_id else {
        return "No active conversation to compact.".into();
    };
    // 202: the spinner label and the completion line come from the `compaction` events.
    match c.ctx.api.compact_thread(thread_id).await {
        Ok(()) => String::new(),
        Err(e) => e.message,
    }
}

/// Why the updater is off, as a person reads it.
pub fn reason_text(reason: Option<&str>) -> &'static str {
    match reason {
        Some("disabled_by_env") => "Updates are disabled (DISABLE_UPDATER is set).",
        Some("not_sea_install") => {
            "This install updates by other means (pull a new image, or restart the dev server)."
        }
        Some("dev_build") => "This is a development build — it has no release to update to.",
        _ => "Updates are not available in this install.",
    }
}

pub async fn update(c: &CommandContext) -> String {
    let api = &c.ctx.api;
    let status = match api.update_status().await {
        Ok(s) => s,
        Err(e) => return e.message,
    };
    if !status.enabled {
        return reason_text(status.reason.as_deref()).into();
    }
    if status.applying {
        return "An update is already in progress.".into();
    }
    // 202: the `update` events show the progress, and the reconnect brings the session back.
    match api.apply_update().await {
        Ok(version) => format!("Updating to {version} — downloading, then the backend restarts…"),
        Err(e) => e.message,
    }
}
