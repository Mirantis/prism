//! `prism update`: the non-interactive update, with no TUI.
//!
//! The update runs server-side (the runtime owns the install and the restart).
//! This command triggers it over the management API and waits for the restarted
//! runtime to report the new version. Exit 0 on success or a benign no-op, 1
//! when the server is unreachable or the update fails.

use std::time::{Duration, Instant};

use crate::api::ApiClient;
use crate::commands::reason_text;
use crate::config::load_config;

// Above the server's own worst-case budget, so a slow but succeeding update is
// never reported as a timeout.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const POLL: Duration = Duration::from_millis(1_000);

pub async fn run_update_command() -> i32 {
    let http_url = load_config().http_url;
    let api = ApiClient::new(&http_url);
    let Ok(status) = api.update_status().await else {
        eprintln!("prism-server is not reachable at {http_url} — start it and retry.");
        return 1;
    };
    if !status.enabled {
        println!("{}", reason_text(status.reason.as_deref()));
        return 0;
    }
    if status.applying {
        println!("An update is already in progress.");
        return 0;
    }
    println!("Checking for updates (current {})…", status.current_version);
    // A FAILURE row for the target version that predates this run is not this run's outcome.
    let prior_started_at = status.last_attempt.as_ref().map(|a| a.started_at.clone());
    let version = match api.apply_update().await {
        Ok(v) => v,
        Err(e) if e.status.is_some() => {
            // 409 "already up to date" is a benign no-op; everything else failed.
            println!("{}", e.message);
            return if e.status == Some(409) { 0 } else { 1 };
        }
        Err(e) => {
            eprintln!("Update failed: {}", e.message);
            return 1;
        }
    };
    println!("Updating to {version} — downloading, then the backend restarts…");
    let deadline = Instant::now() + UPDATE_TIMEOUT;
    while Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
        // Down while restarting: keep polling.
        let Ok(fresh) = api.update_status().await else {
            continue;
        };
        if fresh.current_version == version {
            println!("Updated to {version}.");
            return 0;
        }
        if let Some(attempt) = &fresh.last_attempt
            && attempt.version_to == version
            && attempt.outcome == "FAILURE"
            && Some(&attempt.started_at) != prior_started_at.as_ref()
        {
            eprintln!(
                "Update to {version} failed ({}).",
                attempt
                    .error_code
                    .clone()
                    .unwrap_or_else(|| "unknown error".into())
            );
            return 1;
        }
    }
    eprintln!(
        "The backend did not come back on {version} within {} minutes — check the service (launchctl/systemctl/Task Scheduler) and its server.log.",
        UPDATE_TIMEOUT.as_secs() / 60
    );
    1
}
