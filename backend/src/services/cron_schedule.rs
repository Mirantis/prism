//! Scheduled-task schedule parsing.
//!
//! Pure, in its own module so the scheduler, the agent tools and the task routes
//! read a schedule the same way without importing each other.
//!
//! A recurring schedule is a cron expression read as the `node-cron` package reads
//! it: five fields, or six with a leading seconds field; month and weekday names;
//! `L`, `W`, `L-n`, `nL` and `n#k` tokens; and a day-of-month and a day-of-week
//! that must both match. [`validate_cron`] and [`CronMatcher`] are that reading.

use std::sync::LazyLock;

use anyhow::anyhow;
use chrono::{DateTime, Datelike, NaiveDate, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use regex::Regex;

use crate::lib::timezone::resolve_timezone;
use crate::support::js;

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
    let normalized = js::trim(&normalized);

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
        let zone_name = options.timezone.as_deref().unwrap_or("UTC");
        let timezone = resolve_timezone(zone_name)
            .ok_or_else(|| anyhow!("Invalid time zone specified: {zone_name}"))?;
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
        let value = js::number_text(value);
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

// ============================================================================
// Cron expressions, as node-cron reads them
// ============================================================================

/// One value of a converted field: a number, or a token such as `L`, `15W`, `5#2`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CronValue {
    Num(i64),
    Text(String),
}

impl CronValue {
    /// `String(value)`.
    fn text(&self) -> String {
        match self {
            CronValue::Num(n) => n.to_string(),
            CronValue::Text(text) => text.clone(),
        }
    }

    fn num(&self) -> Option<i64> {
        match self {
            CronValue::Num(n) => Some(*n),
            CronValue::Text(_) => None,
        }
    }
}

/// The six fields of an expression: second, minute, hour, day of month, month, day of week.
type CronFields = Vec<Vec<CronValue>>;

const NICKNAMES: [(&str, &str); 7] = [
    ("@yearly", "0 0 1 1 *"),
    ("@annually", "0 0 1 1 *"),
    ("@monthly", "0 0 1 * *"),
    ("@weekly", "0 0 * * 0"),
    ("@daily", "0 0 * * *"),
    ("@midnight", "0 0 * * *"),
    ("@hourly", "0 * * * *"),
];

/// The expression a nickname such as `@daily` stands for, or the expression itself.
fn resolve_nickname(expression: &str) -> String {
    let key = js::trim(expression).to_lowercase();
    NICKNAMES
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, expanded)| expanded.to_string())
        .unwrap_or_else(|| expression.to_string())
}

/// `str.replace(/\s{2,}/g, ' ').trim()`: a run of two or more white space
/// characters becomes one space; a single one stays as it is.
fn remove_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    for ch in text.chars() {
        if js::is_js_whitespace(ch) {
            run.push(ch);
            continue;
        }
        if run.chars().count() >= 2 {
            out.push(' ');
        } else {
            out.push_str(&run);
        }
        run.clear();
        out.push(ch);
    }
    if run.chars().count() >= 2 {
        out.push(' ');
    } else {
        out.push_str(&run);
    }
    js::trim(&out).to_string()
}

/// Case-insensitive patterns for each name, in replacement order, with the number
/// each becomes.
fn name_patterns(full: &[&str], short: &[&str], first: i64) -> Vec<(Regex, String)> {
    full.iter()
        .enumerate()
        .chain(short.iter().enumerate())
        .map(|(index, name)| {
            (
                Regex::new(&format!("(?i){name}")).expect("valid pattern"),
                (index as i64 + first).to_string(),
            )
        })
        .collect()
}

static MONTH_NAMES: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    name_patterns(
        &[
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ],
        &[
            "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        ],
        1,
    )
});

static WEEKDAY_NAMES: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    name_patterns(
        &[
            "sunday",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
        ],
        &["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        0,
    )
});

fn replace_names(field: &str, names: &[(Regex, String)]) -> String {
    names
        .iter()
        .fold(field.to_string(), |text, (pattern, number)| {
            pattern.replace_all(&text, number.as_str()).into_owned()
        })
}

/// Each token's first `*` becomes the field's whole range.
fn convert_asterisk(field: &str, replacement: &str) -> String {
    field
        .split(',')
        .map(|token| {
            if token.contains('*') {
                token.replacen('*', replacement, 1)
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The bounds of each field, in field order.
const FIELD_BOUNDS: [(i64, i64); 6] = [(0, 59), (0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];

static RANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)-([0-9]+)(?:/([0-9]+))?$").expect("valid pattern"));

/// A digit string as a number; past the range of a number, the largest one.
fn int_of(text: &str) -> i64 {
    text.parse::<i64>().unwrap_or(i64::MAX)
}

/// A range with its step as the comma-separated numbers it names. A range that runs
/// past the field's end wraps to its start. A step below 1 leaves the range as written.
fn expand_range(init: &str, end: &str, step_text: &str, (min, max): (i64, i64)) -> String {
    let step = int_of(step_text);
    if step < 1 {
        return format!("{init}-{end}/{step_text}");
    }
    let first = int_of(init);
    let last = int_of(end);
    let mut numbers: Vec<String> = Vec::new();
    if first <= last {
        let mut i = first;
        while i <= last {
            numbers.push(i.to_string());
            match i.checked_add(step) {
                Some(next) => i = next,
                None => break,
            }
        }
        return numbers.join(",");
    }
    let size = max - min + 1;
    let span = ((last - first) % size + size) % size;
    let mut offset = 0;
    while offset <= span {
        let mut value = first.saturating_add(offset);
        if value > max {
            value -= size;
        }
        numbers.push(value.to_string());
        offset += step;
    }
    numbers.join(",")
}

fn convert_range(field: &str, bounds: (i64, i64)) -> String {
    field
        .split(',')
        .map(|token| match RANGE.captures(js::trim(token)) {
            Some(caps) => expand_range(
                &caps[1],
                &caps[2],
                caps.get(3).map(|m| m.as_str()).unwrap_or("1"),
                bounds,
            ),
            None => token.to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

static LAST_OFFSET_INPUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^l-[0-9]{1,2}$").expect("valid pattern"));
static LAST_WEEKDAY_INPUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-7]l$").expect("valid pattern"));
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+$").expect("valid pattern"));

/// Each token of a field as a number or an upper-cased token.
fn normalize_integers(field: &str) -> Vec<CronValue> {
    field
        .split(',')
        .map(|token| {
            let token = js::trim(token);
            if token.eq_ignore_ascii_case("l") {
                CronValue::Text("L".into())
            } else if LAST_OFFSET_INPUT.is_match(token)
                || LAST_WEEKDAY_INPUT.is_match(token)
                || token.contains(['w', 'W'])
            {
                CronValue::Text(token.to_uppercase())
            } else if token.contains('#') {
                CronValue::Text(token.to_string())
            } else if DIGITS.is_match(token) {
                CronValue::Num(int_of(token))
            } else {
                CronValue::Text(token.to_string())
            }
        })
        .collect()
}

/// The expression as six fields of values. Fails unless it has five or six fields.
fn convert_expression(expression: &str) -> anyhow::Result<CronFields> {
    let resolved = resolve_nickname(expression);
    let mut fields: Vec<String> = remove_spaces(&resolved)
        .split(' ')
        .map(str::to_string)
        .collect();
    if fields.len() == 5 {
        fields.insert(0, "0".to_string());
    }
    if fields.len() != 6 {
        return Err(anyhow!("expected 5 or 6 fields but got {}", fields.len()));
    }
    if fields[3] == "?" {
        fields[3] = "*".to_string();
    }
    if fields[5] == "?" {
        fields[5] = "*".to_string();
    }
    fields[4] = replace_names(&fields[4], &MONTH_NAMES);
    fields[5] = replace_names(&fields[5], &WEEKDAY_NAMES);
    for (index, range) in ["0-59", "0-59", "0-23", "1-31", "1-12", "0-6"]
        .iter()
        .enumerate()
    {
        fields[index] = convert_asterisk(&fields[index], range);
    }
    for (index, bounds) in FIELD_BOUNDS.iter().enumerate() {
        fields[index] = convert_range(&fields[index], *bounds);
    }
    let mut values: CronFields = fields
        .iter()
        .map(|field| normalize_integers(field))
        .collect();

    let mut weekdays: Vec<CronValue> = Vec::new();
    for value in values[5].drain(..) {
        let value = match value {
            CronValue::Num(7) => CronValue::Num(0),
            CronValue::Text(text) if text.starts_with('7') => {
                CronValue::Text(format!("0{}", &text[1..]))
            }
            other => other,
        };
        if !weekdays.contains(&value) {
            weekdays.push(value);
        }
    }
    values[5] = weekdays;
    Ok(values)
}

static ALLOWED_CHARS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9\-*/,#? ]+$").expect("valid pattern"));
static VALID_OPTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[0-9]+|\*|\*/[0-9]+)$").expect("valid pattern"));
static DAY_OF_MONTH_W_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9]{1,2}|L)W$").expect("valid pattern"));
static DAY_OF_MONTH_OFFSET_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^L-([0-9]{1,2})$").expect("valid pattern"));
static NTH_WEEKDAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-7])#([1-5])$").expect("valid pattern"));
static LAST_WEEKDAY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-7]L$").expect("valid pattern"));

/// `parseInt(text, 10)` as a number past the range of an `i64` too: the largest one.
fn parse_int_prefix(text: &str) -> Option<i64> {
    let trimmed = js::trim_start(text);
    let (sign, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1, &trimmed[1..]),
        Some(b'+') => (1, &trimmed[1..]),
        _ => (1, trimmed),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    Some(int_of(&digits).saturating_mul(sign))
}

fn is_valid_expression(values: &[CronValue], min: i64, max: i64) -> bool {
    values.iter().all(|value| {
        let text = value.text();
        let out_of_range = parse_int_prefix(&text).is_some_and(|n| n < min || n > max);
        !out_of_range && VALID_OPTION.is_match(&text)
    })
}

fn is_invalid_day_of_month(values: &[CronValue]) -> bool {
    let days: Vec<CronValue> = values
        .iter()
        .filter(|value| {
            if **value == CronValue::Text("L".into()) {
                return false;
            }
            let text = value.text();
            if let Some(caps) = DAY_OF_MONTH_W_TOKEN.captures(&text) {
                if &caps[1] == "L" {
                    return false;
                }
                let target = int_of(&caps[1]);
                return !(1..=31).contains(&target);
            }
            if let Some(caps) = DAY_OF_MONTH_OFFSET_TOKEN.captures(&text) {
                let n = int_of(&caps[1]);
                return !(1..=30).contains(&n);
            }
            true
        })
        .cloned()
        .collect();
    !is_valid_expression(&days, 1, 31)
}

/// A `W` in a day-of-month token other than `nW` or `LW`.
fn has_invalid_w_modifier(raw_day_of_month: &str) -> bool {
    if !raw_day_of_month.contains(['w', 'W']) {
        return false;
    }
    raw_day_of_month.split(',').any(|token| {
        let value = js::trim(token);
        value.contains(['w', 'W']) && !DAY_OF_MONTH_W_TOKEN.is_match(value)
    })
}

fn is_nth_weekday_token(value: &CronValue) -> bool {
    matches!(value, CronValue::Text(text) if NTH_WEEKDAY.is_match(text))
}

fn is_invalid_week_day(values: &[CronValue]) -> bool {
    let days: Vec<CronValue> = values
        .iter()
        .filter(|value| !is_nth_weekday_token(value) && !LAST_WEEKDAY_TOKEN.is_match(&value.text()))
        .cloned()
        .collect();
    !is_valid_expression(&days, 0, 7)
}

const MAX_DAYS_IN_MONTH: [i64; 13] = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// Whether no month of the expression has any of its days.
fn is_impossible_day_of_month(days: &[CronValue], months: &[CronValue]) -> bool {
    if days.iter().any(|day| day.num().is_none()) {
        return false;
    }
    !months.iter().any(|month| {
        let Some(month) = month.num().filter(|m| (1..=12).contains(m)) else {
            return false;
        };
        let max = MAX_DAYS_IN_MONTH[month as usize];
        days.iter().any(|day| day.num().is_some_and(|d| d <= max))
    })
}

/// Whether node-cron accepts `expression` as a schedule.
pub fn validate_cron(expression: &str) -> bool {
    let resolved = resolve_nickname(expression);
    if !ALLOWED_CHARS.is_match(&resolved) {
        return false;
    }
    let mut patterns: Vec<String> = remove_spaces(&resolved)
        .split(' ')
        .map(str::to_string)
        .collect();
    if patterns.len() != 5 && patterns.len() != 6 {
        return false;
    }
    if patterns.len() == 5 {
        patterns.insert(0, "0".to_string());
    }
    let Ok(fields) = convert_expression(&resolved) else {
        return false;
    };
    let invalid = !is_valid_expression(&fields[0], 0, 59)
        || !is_valid_expression(&fields[1], 0, 59)
        || !is_valid_expression(&fields[2], 0, 23)
        || is_invalid_day_of_month(&fields[3])
        || has_invalid_w_modifier(&patterns[3])
        || !is_valid_expression(&fields[4], 1, 12)
        || is_invalid_week_day(&fields[5])
        || is_impossible_day_of_month(&fields[3], &fields[4]);
    !invalid
}

/// The wall-clock fields of an instant in a zone, as node-cron reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Parts {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    /// 0 for Sunday.
    weekday: u32,
}

fn parts_at(ms: i64, zone: Tz) -> Parts {
    let local = crate::support::from_ms(ms).with_timezone(&zone);
    Parts {
        year: local.year(),
        month: local.month(),
        day: local.day(),
        hour: local.hour(),
        minute: local.minute(),
        second: local.second(),
        weekday: local.weekday().num_days_from_sunday(),
    }
}

/// The zone's offset from UTC at `ms`, in whole minutes.
fn offset_minutes(ms: i64, zone: Tz) -> i64 {
    let offset = zone
        .offset_from_utc_datetime(&crate::support::from_ms(ms).naive_utc())
        .fix()
        .local_minus_utc() as i64;
    offset / 60
}

/// The instant the zone's clock shows the given fields. Where the clock shows
/// them twice or never, the later instant that reads back to them, else the later
/// candidate.
fn local_time_to_timestamp(
    (year, month, day, hour, minute, second): (i32, u32, u32, u32, u32, u32),
    zone: Tz,
) -> i64 {
    let guess = date_utc(
        year,
        month as i64 - 1,
        day as i64,
        hour as i64,
        minute as i64,
        second as i64,
    );
    let first_offset = offset_minutes(guess, zone);
    let candidate1 = guess - first_offset * 60_000;
    let second_offset = offset_minutes(candidate1, zone);
    if second_offset == first_offset {
        return candidate1;
    }
    let candidate2 = guess - second_offset * 60_000;
    let reads_back = |ts: i64| {
        let p = parts_at(ts, zone);
        (p.year, p.month, p.day, p.hour, p.minute, p.second)
            == (year, month, day, hour, minute, second)
    };
    if reads_back(candidate1) {
        return candidate1;
    }
    if reads_back(candidate2) {
        return candidate2;
    }
    candidate1.max(candidate2)
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|first| first.pred_opt())
        .map(|last| last.day())
        .unwrap_or(31)
}

fn weekday_of(year: i32, month: u32, day: u32) -> u32 {
    NaiveDate::from_ymd_opt(year, month, day)
        .map(|date| date.weekday().num_days_from_sunday())
        .unwrap_or(0)
}

/// The weekday nearest `target` in the month, or `None` past the month's days.
fn nearest_weekday(year: i32, month: u32, target: i64) -> Option<i64> {
    let last = last_day_of_month(year, month) as i64;
    if target < 1 || target > last {
        return None;
    }
    Some(match weekday_of(year, month, target as u32) {
        6 if target == 1 => target + 2,
        6 => target - 1,
        0 if target == last => target - 2,
        0 => target + 1,
        _ => target,
    })
}

static WEEKDAY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{1,2}|L)W$").expect("valid pattern"));
static LAST_DAY_OFFSET_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^L-([0-9]{1,2})$").expect("valid pattern"));
static LAST_WEEKDAY_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-7])L$").expect("valid pattern"));

fn matches_day_of_month(field: &[CronValue], year: i32, month: u32, day: u32) -> bool {
    let last = last_day_of_month(year, month);
    field.iter().any(|value| match value {
        CronValue::Num(n) => *n == day as i64,
        CronValue::Text(text) => {
            if text == "L" && day == last {
                return true;
            }
            if let Some(caps) = WEEKDAY_TOKEN.captures(text) {
                let target = if &caps[1] == "L" {
                    last as i64
                } else {
                    int_of(&caps[1])
                };
                if nearest_weekday(year, month, target) == Some(day as i64) {
                    return true;
                }
            }
            if let Some(caps) = LAST_DAY_OFFSET_TOKEN.captures(text) {
                let target = last as i64 - int_of(&caps[1]);
                if target >= 1 && target == day as i64 {
                    return true;
                }
            }
            false
        }
    })
}

fn is_last_weekday_of_month(year: i32, month: u32, day: u32) -> bool {
    NaiveDate::from_ymd_opt(year, month, day)
        .and_then(|date| date.checked_add_days(chrono::Days::new(7)))
        .is_none_or(|later| later.month() != month)
}

fn matches_day_of_week(field: &[CronValue], year: i32, month: u32, day: u32, weekday: u32) -> bool {
    field.iter().any(|value| {
        if *value == CronValue::Num(weekday as i64) {
            return true;
        }
        let CronValue::Text(text) = value else {
            return false;
        };
        if let Some(caps) = NTH_WEEKDAY.captures(text) {
            let wanted = int_of(&caps[1]) % 7;
            let nth = int_of(&caps[2]);
            let occurrence = (day as i64 - 1) / 7 + 1;
            return weekday_of(year, month, day) as i64 == wanted && occurrence == nth;
        }
        if let Some(caps) = LAST_WEEKDAY_REGEX.captures(text) {
            let last = int_of(&caps[1]);
            let last = if last == 7 { 0 } else { last };
            return last == weekday as i64 && is_last_weekday_of_month(year, month, day);
        }
        false
    })
}

/// How many days ahead the next match is looked for.
const MAX_DAYS: usize = 366 * 100;

/// A validated cron expression read in a zone: whether an instant matches it, and
/// the next instant that does.
#[derive(Debug, Clone)]
pub struct CronMatcher {
    fields: CronFields,
    zone: Tz,
    seconds: Vec<u32>,
    minutes: Vec<u32>,
    hours: Vec<u32>,
}

/// The numbers of a field, ascending.
fn sorted_numbers(values: &[CronValue]) -> Vec<u32> {
    let mut numbers: Vec<u32> = values
        .iter()
        .filter_map(CronValue::num)
        .filter_map(|n| u32::try_from(n).ok())
        .collect();
    numbers.sort_unstable();
    numbers
}

impl CronMatcher {
    /// The matcher of `expression` in `zone`. Fails on an expression
    /// [`validate_cron`] refuses.
    pub fn new(expression: &str, zone: Tz) -> anyhow::Result<CronMatcher> {
        if !validate_cron(expression) {
            return Err(anyhow!("{expression} is a invalid cron expression"));
        }
        let fields = convert_expression(expression)?;
        Ok(CronMatcher {
            seconds: sorted_numbers(&fields[0]),
            minutes: sorted_numbers(&fields[1]),
            hours: sorted_numbers(&fields[2]),
            fields,
            zone,
        })
    }

    fn has(field: &[CronValue], value: u32) -> bool {
        field.contains(&CronValue::Num(value as i64))
    }

    /// Whether the expression matches the second `date` falls in.
    pub fn matches(&self, date: DateTime<Utc>) -> bool {
        let p = parts_at(date.timestamp_millis(), self.zone);
        Self::has(&self.fields[0], p.second)
            && Self::has(&self.fields[1], p.minute)
            && Self::has(&self.fields[2], p.hour)
            && matches_day_of_month(&self.fields[3], p.year, p.month, p.day)
            && Self::has(&self.fields[4], p.month)
            && matches_day_of_week(&self.fields[5], p.year, p.month, p.day, p.weekday)
    }

    /// The first instant after the second `date` falls in that matches. Fails when
    /// none falls within a hundred years.
    pub fn next_match(&self, date: DateTime<Utc>) -> anyhow::Result<DateTime<Utc>> {
        let base_ms = date.timestamp_millis().div_euclid(1000) * 1000;
        let base = parts_at(base_ms, self.zone);
        let (mut year, mut month, mut day) = (base.year, base.month, base.day);
        for i in 0..MAX_DAYS {
            if Self::has(&self.fields[4], month)
                && matches_day_of_month(&self.fields[3], year, month, day)
                && matches_day_of_week(
                    &self.fields[5],
                    year,
                    month,
                    day,
                    weekday_of(year, month, day),
                )
            {
                let lower_bound = (i == 0).then_some(base);
                if let Some(found) = self.first_time_on_day(year, month, day, lower_bound, base_ms)
                {
                    return Ok(crate::support::from_ms(found));
                }
            }
            let next = NaiveDate::from_ymd_opt(year, month, day)
                .and_then(|date| date.succ_opt())
                .ok_or_else(|| {
                    anyhow!("Could not find next matching date within reasonable time range")
                })?;
            (year, month, day) = (next.year(), next.month(), next.day());
        }
        Err(anyhow!(
            "Could not find next matching date within reasonable time range"
        ))
    }

    fn first_time_on_day(
        &self,
        year: i32,
        month: u32,
        day: u32,
        lower_bound: Option<Parts>,
        base_ms: i64,
    ) -> Option<i64> {
        for &hour in &self.hours {
            if lower_bound.is_some_and(|bound| hour < bound.hour) {
                continue;
            }
            for &minute in &self.minutes {
                for &second in &self.seconds {
                    if let Some(bound) = lower_bound {
                        let at = hour * 3600 + minute * 60 + second;
                        if at <= bound.hour * 3600 + bound.minute * 60 + bound.second {
                            continue;
                        }
                    }
                    let ts = local_time_to_timestamp(
                        (year, month, day, hour, minute, second),
                        self.zone,
                    );
                    if ts > base_ms && self.matches(crate::support::from_ms(ts)) {
                        return Some(ts);
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(schedule: &str, timezone: &str, now: &str) -> Option<String> {
        parse_schedule(
            schedule,
            ScheduleOptions {
                timezone: Some(timezone.to_string()),
                now: crate::support::parse_iso(now),
            },
        )
        .unwrap()
        .next_run_at
        .map(|date| crate::support::iso(&date))
    }

    fn utc(text: &str) -> DateTime<Utc> {
        crate::support::parse_iso(text).unwrap()
    }

    #[test]
    fn parses_in_n_seconds_as_a_one_shot() {
        let parsed = parse_schedule("in 30 seconds", ScheduleOptions::default()).unwrap();
        assert!(parsed.is_one_shot);
        assert!(parsed.next_run_at.is_some());
    }

    #[test]
    fn parses_every_n_seconds_as_a_recurring_six_field_expression() {
        let parsed = parse_schedule("every 15 seconds", ScheduleOptions::default()).unwrap();
        assert!(!parsed.is_one_shot);
        assert_eq!(parsed.cron_expression, "*/15 * * * * *");
        assert_eq!(parsed.next_run_at, None);
    }

    #[test]
    fn still_parses_minutes_one_shot_and_recurring() {
        assert!(
            parse_schedule("in 5 minutes", ScheduleOptions::default())
                .unwrap()
                .is_one_shot
        );
        assert!(
            !parse_schedule("every 2 hours", ScheduleOptions::default())
                .unwrap()
                .is_one_shot
        );
    }

    // docs/scheduled-tasks.md tells users they can say "every hour".
    #[test]
    fn parses_a_bare_unit_as_an_interval_of_one() {
        for (phrase, expression) in [
            ("every hour", "0 */1 * * *"),
            ("every minute", "*/1 * * * *"),
            ("every second", "*/1 * * * * *"),
            ("every day", "0 0 * * *"),
        ] {
            let parsed = parse_schedule(phrase, ScheduleOptions::default()).unwrap();
            assert!(!parsed.is_one_shot, "{phrase}");
            assert_eq!(parsed.cron_expression, expression, "{phrase}");
            assert!(validate_cron(&parsed.cron_expression), "{phrase}");
        }
    }

    #[test]
    fn runs_at_h_when_the_zone_clock_shows_the_time() {
        // 12:00 in Helsinki (UTC+2), so 3pm is later the same day.
        assert_eq!(
            at("at 3pm", "Europe/Helsinki", "2026-10-30T10:00:00Z").as_deref(),
            Some("2026-10-30T13:00:00.000Z")
        );
        assert_eq!(
            at("at 9:30am", "America/New_York", "2026-10-30T12:00:00Z").as_deref(),
            Some("2026-10-30T13:30:00.000Z")
        );
    }

    #[test]
    fn moves_to_the_next_day_when_the_time_has_passed_in_the_zone() {
        // 16:00 in Helsinki.
        assert_eq!(
            at("at 3pm", "Europe/Helsinki", "2026-10-30T14:00:00Z").as_deref(),
            Some("2026-10-31T13:00:00.000Z")
        );
    }

    #[test]
    fn takes_the_date_from_the_zone_not_from_utc() {
        // 00:30 on Oct 31 in Helsinki, while UTC is still on Oct 30.
        assert_eq!(
            at("at 1am", "Europe/Helsinki", "2026-10-30T22:30:00Z").as_deref(),
            Some("2026-10-30T23:00:00.000Z")
        );
    }

    #[test]
    fn uses_the_offset_in_force_at_the_run_time_on_a_daylight_saving_change_day() {
        // 23:00 on Oct 24 in Helsinki (UTC+3). The clocks go back to UTC+2 at 04:00 on Oct 25.
        assert_eq!(
            at("at 9am", "Europe/Helsinki", "2026-10-24T20:00:00Z").as_deref(),
            Some("2026-10-25T07:00:00.000Z")
        );
    }

    #[test]
    fn validates_five_and_six_field_expressions_as_node_cron_does() {
        for valid in [
            "* * * * *",
            "* * * * * *",
            "0 9 * * *",
            "*/15 * * * * *",
            "0 */2 * * *",
            "0 0 * * 7",
            "0 0 * * sun",
            "0 0 1 jan *",
            "0 0 * * MON-FRI",
            "0 0 L * *",
            "0 0 15W * *",
            "0 0 LW * *",
            "0 0 L-3 * *",
            "0 0 * * 5L",
            "0 0 * * 1#2",
            "0 0 ? * *",
            "@daily",
            "@HOURLY",
            "0 22-2 * * *",
            "0   9 *  * *",
        ] {
            assert!(validate_cron(valid), "{valid}");
        }
        for invalid in [
            "",
            "* * * *",
            "* * * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * 32 * *",
            "* * * 13 *",
            "* * * * 8",
            "5/10 * * * *",
            "*/0 * * * *",
            "0 0 31 2 *",
            "0 0 30 2 *",
            "0 0 15X * *",
            "0 0 W5 * *",
            "@every 5m",
            "in 5 minutes",
            "at 3pm",
            "0\t9 * * *",
        ] {
            assert!(!validate_cron(invalid), "{invalid}");
        }
    }

    #[test]
    fn requires_the_day_of_month_and_the_day_of_week_to_both_match() {
        // The 1st of a month that is a Monday: 2026-06-01.
        let matcher = CronMatcher::new("0 0 1 * 1", Tz::UTC).unwrap();
        assert!(matcher.matches(utc("2026-06-01T00:00:00Z")));
        assert!(!matcher.matches(utc("2026-07-01T00:00:00Z")));
        assert!(!matcher.matches(utc("2026-06-08T00:00:00Z")));
        assert_eq!(
            matcher.next_match(utc("2026-01-01T00:00:00Z")).unwrap(),
            utc("2026-06-01T00:00:00Z")
        );
    }

    #[test]
    fn reads_a_five_field_expression_at_second_zero_and_six_fields_to_the_second() {
        let minutes = CronMatcher::new("*/5 * * * *", Tz::UTC).unwrap();
        assert!(minutes.matches(utc("2026-01-01T10:05:00Z")));
        assert!(!minutes.matches(utc("2026-01-01T10:05:01Z")));
        assert_eq!(
            minutes.next_match(utc("2026-01-01T10:05:00.500Z")).unwrap(),
            utc("2026-01-01T10:10:00Z")
        );
        let seconds = CronMatcher::new("*/15 * * * * *", Tz::UTC).unwrap();
        assert_eq!(
            seconds.next_match(utc("2026-01-01T10:05:01Z")).unwrap(),
            utc("2026-01-01T10:05:15Z")
        );
    }

    #[test]
    fn counts_sunday_as_zero_and_seven() {
        // 2026-01-04 is a Sunday.
        for expression in ["0 0 * * 0", "0 0 * * 7", "0 0 * * sun", "0 0 * * Sunday"] {
            let matcher = CronMatcher::new(expression, Tz::UTC).unwrap();
            assert!(matcher.matches(utc("2026-01-04T00:00:00Z")), "{expression}");
            assert!(
                !matcher.matches(utc("2026-01-05T00:00:00Z")),
                "{expression}"
            );
        }
    }

    #[test]
    fn reads_a_schedule_in_its_zone() {
        let matcher = CronMatcher::new("0 9 * * *", chrono_tz::Europe::Helsinki).unwrap();
        assert_eq!(
            matcher.next_match(utc("2026-01-01T00:00:00Z")).unwrap(),
            utc("2026-01-01T07:00:00Z")
        );
        // Summer time: 09:00 in Helsinki is 06:00 UTC.
        assert_eq!(
            matcher.next_match(utc("2026-07-01T00:00:00Z")).unwrap(),
            utc("2026-07-01T06:00:00Z")
        );
    }

    #[test]
    fn wraps_a_range_that_runs_past_the_field_end() {
        let matcher = CronMatcher::new("0 22-2 * * *", Tz::UTC).unwrap();
        for hour in ["22", "23", "00", "01", "02"] {
            assert!(
                matcher.matches(utc(&format!("2026-01-01T{hour}:00:00Z"))),
                "{hour}"
            );
        }
        assert!(!matcher.matches(utc("2026-01-01T03:00:00Z")));
    }

    #[test]
    fn reads_the_last_day_weekday_and_nth_weekday_tokens() {
        let last = CronMatcher::new("0 0 L * *", Tz::UTC).unwrap();
        assert_eq!(
            last.next_match(utc("2026-02-10T00:00:00Z")).unwrap(),
            utc("2026-02-28T00:00:00Z")
        );
        // 2026-08-15 is a Saturday, so 15W is Friday the 14th.
        let weekday = CronMatcher::new("0 0 15W * *", Tz::UTC).unwrap();
        assert_eq!(
            weekday.next_match(utc("2026-08-01T00:00:00Z")).unwrap(),
            utc("2026-08-14T00:00:00Z")
        );
        // The second Monday of March 2026 is the 9th.
        let nth = CronMatcher::new("0 0 * * 1#2", Tz::UTC).unwrap();
        assert_eq!(
            nth.next_match(utc("2026-03-01T00:00:00Z")).unwrap(),
            utc("2026-03-09T00:00:00Z")
        );
        // The last Friday of January 2026 is the 30th.
        let last_friday = CronMatcher::new("0 0 * * 5L", Tz::UTC).unwrap();
        assert_eq!(
            last_friday.next_match(utc("2026-01-01T00:00:00Z")).unwrap(),
            utc("2026-01-30T00:00:00Z")
        );
    }

    #[test]
    fn steps_over_the_hour_a_daylight_saving_change_skips() {
        // Helsinki moves from 03:00 to 04:00 on 2026-03-29, so 03:30 does not exist.
        let matcher = CronMatcher::new("30 3 * * *", chrono_tz::Europe::Helsinki).unwrap();
        assert_eq!(
            matcher.next_match(utc("2026-03-28T12:00:00Z")).unwrap(),
            utc("2026-03-30T00:30:00Z")
        );
    }

    #[test]
    fn fails_when_no_match_falls_within_a_hundred_years() {
        // The 1st is always the first occurrence of its weekday.
        let matcher = CronMatcher::new("0 0 1 * 1#2", Tz::UTC).unwrap();
        assert!(matcher.next_match(utc("2026-01-01T00:00:00Z")).is_err());
    }
}
