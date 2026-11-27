//! `/heartbeat`: status, start, stop, trigger and the interval.

use std::sync::LazyLock;

use regex::Regex;

use super::CommandContext;
use crate::util::js_number;

const MIN_INTERVAL_MS: f64 = 60_000.0;
const MAX_INTERVAL_MS: f64 = 604_800_000.0;

/// An interval like `5m` or `2h` in milliseconds, between one minute and seven days.
pub fn parse_interval(token: &str) -> Option<f64> {
    static INTERVAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(\d+)(m|h)$").unwrap());
    let caps = INTERVAL.captures(token)?;
    let value: f64 = caps[1].parse().ok()?;
    let ms = if caps[2].eq_ignore_ascii_case("m") {
        value * 60_000.0
    } else {
        value * 3_600_000.0
    };
    (MIN_INTERVAL_MS..=MAX_INTERVAL_MS)
        .contains(&ms)
        .then_some(ms)
}

pub async fn heartbeat(c: &CommandContext) -> String {
    let api = &c.ctx.api;
    let result = match c.args.first().map(String::as_str) {
        Some("status") => api.get_heartbeat_status().await.map(|s| {
            let interval = s
                .interval_ms
                .map(|ms| format!("{}ms", js_number(ms)))
                .unwrap_or_else(|| "unknown".into());
            [
                format!("active: {}", s.is_active),
                format!("running: {}", s.is_running),
                format!("last run: {}", s.last_run.unwrap_or_else(|| "never".into())),
                format!("consecutive errors: {}", js_number(s.consecutive_errors)),
                format!("interval: {interval}"),
            ]
            .join("\n")
        }),
        Some("start") => match api.get_details().await {
            Ok(details) => api.start_heartbeat(&details).await,
            Err(e) => Err(e),
        },
        Some("stop") => api.stop_heartbeat().await,
        Some("trigger") => api.trigger_heartbeat().await.map(|ok| {
            if ok {
                "Heartbeat triggered.".to_string()
            } else {
                "Heartbeat trigger reported failure.".to_string()
            }
        }),
        Some("every") => {
            let Some(ms) = parse_interval(c.args.get(1).map(String::as_str).unwrap_or("")) else {
                return "Use Nm or Nh, e.g. /heartbeat every 5m".into();
            };
            api.set_heartbeat_interval(ms).await.map(|set| {
                format!(
                    "Heartbeat interval set to {}ms.",
                    js_number(set.unwrap_or(ms))
                )
            })
        }
        _ => return "Usage: /heartbeat <status|start|stop|trigger|every Nm|Nh>.".into(),
    };
    result.unwrap_or_else(|e| e.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_intervals() {
        assert_eq!(parse_interval("5m"), Some(300_000.0));
        assert_eq!(parse_interval("2H"), Some(7_200_000.0));
        assert_eq!(parse_interval("0m"), None);
        assert_eq!(parse_interval("169h"), None);
        assert_eq!(parse_interval("5s"), None);
    }
}
