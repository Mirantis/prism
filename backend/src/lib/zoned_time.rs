//! Wall-clock arithmetic in an IANA time zone, with the zone's offset read at the
//! instant in question, so a daylight-saving change is handled.

use chrono::{Datelike, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

/// The wall-clock fields of an instant in a zone.
pub struct WallClock {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    /// The wall-clock date and time read as UTC, in epoch milliseconds.
    pub utc_ms: i64,
}

/// The wall-clock fields of `instant` (epoch milliseconds) in `timezone`.
pub fn wall_clock(instant: i64, timezone: Tz) -> WallClock {
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
pub fn date_utc(year: i32, month0: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
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
pub fn zoned_instant(year: i32, month: u32, day: i64, hour: i64, minute: i64, timezone: Tz) -> i64 {
    let as_utc = date_utc(year, month as i64 - 1, day, hour, minute, 0);
    let offset_at =
        |instant: i64| wall_clock(instant, timezone).utc_ms - instant.div_euclid(1000) * 1000;
    let guess = as_utc - offset_at(as_utc);
    as_utc - offset_at(guess)
}
