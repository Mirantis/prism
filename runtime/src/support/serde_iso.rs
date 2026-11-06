//! Serde for `DateTime<Utc>` as `toISOString()` text, the form `res.json()` gives
//! a `Date`. Use `#[serde(with = "crate::support::serde_iso")]`, or
//! `crate::support::serde_iso::option` for an `Option<DateTime<Utc>>`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer>(dt: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&super::iso(dt))
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
    let text = String::deserialize(d)?;
    super::parse_iso(&text).ok_or_else(|| serde::de::Error::custom(format!("invalid date: {text}")))
}

pub mod option {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(dt: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
        match dt {
            Some(dt) => s.serialize_str(&crate::support::iso(dt)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        let text = Option::<String>::deserialize(d)?;
        match text {
            None => Ok(None),
            Some(text) => crate::support::parse_iso(&text)
                .map(Some)
                .ok_or_else(|| serde::de::Error::custom(format!("invalid date: {text}"))),
        }
    }
}
