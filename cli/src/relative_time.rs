//! A timestamp as a coarse "time ago" string for the resume picker, such as
//! "just now", "1 minute ago", "2 hours ago" or "3 days ago".

use chrono::{DateTime, Utc};

pub fn format_relative_time(timestamp: &str) -> String {
    format_relative_time_at(timestamp, Utc::now())
}

fn format_relative_time_at(timestamp: &str, now: DateTime<Utc>) -> String {
    let Ok(then) = DateTime::parse_from_rfc3339(timestamp) else {
        return "unknown".into();
    };
    let diff_ms = (now - then.with_timezone(&Utc)).num_milliseconds();
    let minutes = diff_ms.div_euclid(60_000);
    if minutes < 1 {
        return "just now".into();
    }
    if minutes < 60 {
        return format!("{minutes} {} ago", plural(minutes, "minute"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours} {} ago", plural(hours, "hour"));
    }
    let days = hours / 24;
    format!("{days} {} ago", plural(days, "day"))
}

fn plural(n: i64, unit: &str) -> String {
    if n == 1 {
        unit.to_string()
    } else {
        format!("{unit}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_the_distance() {
        let now = DateTime::parse_from_rfc3339("2026-01-02T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            format_relative_time_at("2026-01-02T11:59:30Z", now),
            "just now"
        );
        assert_eq!(
            format_relative_time_at("2026-01-02T11:59:00Z", now),
            "1 minute ago"
        );
        assert_eq!(
            format_relative_time_at("2026-01-02T10:00:00Z", now),
            "2 hours ago"
        );
        assert_eq!(
            format_relative_time_at("2025-12-30T12:00:00Z", now),
            "3 days ago"
        );
        assert_eq!(format_relative_time_at("nonsense", now), "unknown");
    }
}
