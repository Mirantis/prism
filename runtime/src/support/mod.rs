//! What the runtime needs from its platform that the standard library spells
//! differently: JavaScript's date and number text, string lengths in UTF-16 code
//! units, and serde helpers for the wire formats clients already read.

pub mod after_accept;
pub mod http;
pub mod js;
pub mod serde_iso;

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};

/// Milliseconds since the epoch, as `Date.now()`.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// `Date.prototype.toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso(dt: &DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The current time as `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso(&Utc::now())
}

/// A `DateTime` from epoch milliseconds, as `new Date(ms)`.
pub fn from_ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_else(Utc::now)
}

/// `Date.parse` for the ISO forms the runtime reads back: RFC 3339, with or
/// without a zone (a missing zone is UTC, as for the date-time forms clients send).
pub fn parse_iso(text: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, fmt) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?));
    }
    None
}
