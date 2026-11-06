//! Scheduled-task schedule parsing.
//!
//! Pure, in its own module so the scheduler, the agent tools and the task routes
//! read a schedule the same way without importing each other.

use std::sync::LazyLock;

use anyhow::anyhow;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use regex::Regex;

/// The wall-clock fields of an instant in a zone.
struct WallClock {
    year: i32,
    month: u32,
    day: u32,
    /// The wall-clock date and time read as UTC, in epoch milliseconds.
    utc_ms: i64,
}

/// The wall-clock fields of `instant` (epoch milliseconds) in `timezone`.
fn wall_clock(instant: i64, timezone: Tz) -> WallClock {
    let local = Utc
        .timestamp_millis_opt(instant)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&timezone);
    let (year, month, day) = (local.year(), local.month(), local.day());
    let utc_ms = date_utc(
        year,
        month as i64 - 1,
        day as i64,
        local.hour() as i64,
        local.minute() as i64,
        local.second() as i64,
    );
    WallClock {
        year,
        month,
        day,
        utc_ms,
    }
}

/// `Date.UTC(year, month0, day, hour, minute, second)`: fields past their range
/// carry into the next larger one.
fn date_utc(year: i32, month0: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let year = year as i64 + month0.div_euclid(12);
    let month = month0.rem_euclid(12) as u32 + 1;
    let first = NaiveDate::from_ymd_opt(year as i32, month, 1).unwrap_or_default();
    let midnight = first
        .and_hms_opt(0, 0, 0)
        .unwrap_or_default()
        .and_utc()
        .timestamp_millis();
    midnight + (day - 1) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000
}

/// The instant at which `timezone` shows the given date and time. The zone's offset is read
/// at a first guess and again at the result, so a time on a daylight-saving change day gets
/// the offset in force at that time.
fn zoned_instant(year: i32, month: u32, day: i64, hour: i64, minute: i64, timezone: Tz) -> i64 {
    let as_utc = date_utc(year, month as i64 - 1, day, hour, minute, 0);
    let offset_at =
        |instant: i64| wall_clock(instant, timezone).utc_ms - instant.div_euclid(1000) * 1000;
    let guess = as_utc - offset_at(as_utc);
    as_utc - offset_at(guess)
}

/// A schedule read as a cron expression or a one-shot time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSchedule {
    pub cron_expression: String,
    pub is_one_shot: bool,
    pub next_run_at: Option<DateTime<Utc>>,
}

/// How `parse_schedule` reads a time of day.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScheduleOptions {
    /// The IANA zone a time of day is read in. Default `UTC`.
    pub timezone: Option<String>,
    /// The time "now" is. Default the current time.
    pub now: Option<DateTime<Utc>>,
}

static IN_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^in\s+([0-9]+)\s+(second|seconds|sec|secs|minute|minutes|hour|hours|min|mins|hr|hrs)$",
    )
    .expect("valid pattern")
});
static AT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?$").expect("valid pattern")
});
static EVERY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^every\s+(?:([0-9]+)\s+)?(second|seconds|sec|secs|minute|minutes|hour|hours|min|mins|hr|hrs)$")
        .expect("valid pattern")
});
static DAILY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^every\s+day\s+at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?$")
        .expect("valid pattern")
});

/// `parseInt` of a digit string.
fn digits(text: &str) -> f64 {
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// An hour of "3pm" or "12am" on the 24-hour clock.
fn hour_of(hour: i64, ampm: Option<&str>) -> i64 {
    match ampm {
        Some("pm") if hour != 12 => hour + 12,
        Some("am") if hour == 12 => 0,
        _ => hour,
    }
}

/// Parse human-readable schedule into a cron expression.
/// Supports: "in X minutes", "at 3pm", "every 2 hours", "every hour", "every day",
/// "every day at 9am", raw cron. "at 3pm" is read in `timezone`, an IANA name: the next
/// time that zone's clock shows 3pm. Fails on a zone name that is not one, and on a
/// one-shot time past the range of a date.
pub fn parse_schedule(schedule: &str, options: ScheduleOptions) -> anyhow::Result<ParsedSchedule> {
    let now = options.now.unwrap_or_else(Utc::now);
    let normalized = schedule.to_lowercase();
    let normalized = normalized.trim();

    if let Some(caps) = IN_PATTERN.captures(normalized) {
        let value = digits(&caps[1]);
        let unit = &caps[2];
        let ms = if unit.starts_with("hour") || unit.starts_with("hr") {
            value * 60.0 * 60.0 * 1000.0
        } else if unit.starts_with("sec") {
            value * 1000.0
        } else {
            value * 60.0 * 1000.0
        };
        let at = now.timestamp_millis() as f64 + ms;
        let next_run_at = (at.abs() <= 8.64e15)
            .then(|| Utc.timestamp_millis_opt(at as i64).single())
            .flatten()
            .ok_or_else(|| anyhow!("Invalid time value"))?;
        return Ok(ParsedSchedule {
            cron_expression: schedule.to_string(),
            is_one_shot: true,
            next_run_at: Some(next_run_at),
        });
    }

    if let Some(caps) = AT_PATTERN.captures(normalized) {
        let timezone: Tz = options
            .timezone
            .as_deref()
            .unwrap_or("UTC")
            .parse()
            .map_err(|_| {
                anyhow!(
                    "Invalid time zone specified: {}",
                    options.timezone.as_deref().unwrap_or("UTC")
                )
            })?;
        let hour = hour_of(
            caps[1].parse().unwrap_or(0),
            caps.get(3).map(|m| m.as_str()),
        );
        let minute: i64 = caps
            .get(2)
            .map(|m| m.as_str().parse().unwrap_or(0))
            .unwrap_or(0);

        let today = wall_clock(now.timestamp_millis(), timezone);
        let mut target = zoned_instant(
            today.year,
            today.month,
            today.day as i64,
            hour,
            minute,
            timezone,
        );
        if target <= now.timestamp_millis() {
            target = zoned_instant(
                today.year,
                today.month,
                today.day as i64 + 1,
                hour,
                minute,
                timezone,
            );
        }
        let next_run_at = Utc
            .timestamp_millis_opt(target)
            .single()
            .ok_or_else(|| anyhow!("Invalid time value"))?;
        return Ok(ParsedSchedule {
            cron_expression: schedule.to_string(),
            is_one_shot: true,
            next_run_at: Some(next_run_at),
        });
    }

    if let Some(caps) = EVERY_PATTERN.captures(normalized) {
        let value = caps.get(1).map(|m| digits(m.as_str())).unwrap_or(1.0);
        let value = crate::support::js::number_text(value);
        let unit = &caps[2];

        if unit.starts_with("sec") {
            // A leading seconds field (6-field expression) names the second.
            return Ok(ParsedSchedule {
                cron_expression: format!("*/{value} * * * * *"),
                is_one_shot: false,
                next_run_at: None,
            });
        }
        if unit.starts_with("hour") || unit.starts_with("hr") {
            return Ok(ParsedSchedule {
                cron_expression: format!("0 */{value} * * *"),
                is_one_shot: false,
                next_run_at: None,
            });
        }
        return Ok(ParsedSchedule {
            cron_expression: format!("*/{value} * * * *"),
            is_one_shot: false,
            next_run_at: None,
        });
    }

    if normalized == "every day" {
        return Ok(ParsedSchedule {
            cron_expression: "0 0 * * *".to_string(),
            is_one_shot: false,
            next_run_at: None,
        });
    }

    if let Some(caps) = DAILY_PATTERN.captures(normalized) {
        let hour = hour_of(
            caps[1].parse().unwrap_or(0),
            caps.get(3).map(|m| m.as_str()),
        );
        let minute: i64 = caps
            .get(2)
            .map(|m| m.as_str().parse().unwrap_or(0))
            .unwrap_or(0);
        return Ok(ParsedSchedule {
            cron_expression: format!("{minute} {hour} * * *"),
            is_one_shot: false,
            next_run_at: None,
        });
    }

    Ok(ParsedSchedule {
        cron_expression: schedule.to_string(),
        is_one_shot: false,
        next_run_at: None,
    })
}
