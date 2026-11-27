//! The column encodings the Prisma driver adapter writes, so this runtime and the
//! Prisma client read and write one database file the same way:
//!
//! - `DateTime` ([`PrismaDateTime`]): INTEGER epoch milliseconds. A row written by a
//!   migration's `DEFAULT CURRENT_TIMESTAMP` holds TEXT `YYYY-MM-DD HH:MM:SS` in UTC,
//!   and a value written in the adapter's `iso8601` format holds ISO text; both read.
//! - `Json` ([`PrismaJson`]): TEXT, the value as `JSON.stringify` writes it.
//! - `Boolean`: INTEGER 0/1 (Diesel's `Bool`). `Bytes`: BLOB (`Binary`). `Int`:
//!   INTEGER (`BigInt`, an `i64`). An enum: its member's TEXT.
//!
//! A model reads a date as `DateTime<Utc>` and JSON as `serde_json::Value`. To bind
//! one to a NOT NULL column, wrap it: [`DbDateTime`] and [`DbJson`]
//! (`created_at.lt(DbDateTime(now))`), which is also what an insert struct holds. A
//! nullable column binds the `Option` itself: `next_run_at.le(Some(now))`.

use std::sync::LazyLock;

use chrono::{DateTime, TimeZone, Utc};
use diesel::deserialize::{self, FromSql, Queryable};
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::SqlType;
use diesel::sqlite::{Sqlite, SqliteType, SqliteValue};
use diesel::{AsExpression, FromSqlRow};
use regex::Regex;
use serde_json::Value;

/// A Prisma `DateTime` column: epoch milliseconds on write; milliseconds, seconds
/// text or ISO text on read.
#[derive(Debug, Clone, Copy, Default, SqlType, diesel::query_builder::QueryId)]
#[diesel(sqlite_type(name = "Long"))]
pub struct PrismaDateTime;

/// A Prisma `Json` column: the value's JSON text.
#[derive(Debug, Clone, Copy, Default, SqlType, diesel::query_builder::QueryId)]
#[diesel(sqlite_type(name = "Text"))]
pub struct PrismaJson;

/// The stored JSON text unchanged, so a query can match it with `LIKE`:
/// `tool_calls.cast::<Nullable<Text>>().like(pattern)`.
impl diesel::expression::FallibleCastsTo<diesel::sql_types::Text> for PrismaJson {}
impl diesel::expression::CastsTo<diesel::sql_types::Text> for PrismaJson {}

// ---------------------------------------------------------------- DateTime

impl ToSql<PrismaDateTime, Sqlite> for DateTime<Utc> {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(self.timestamp_millis());
        Ok(IsNull::No)
    }
}

impl FromSql<PrismaDateTime, Sqlite> for DateTime<Utc> {
    fn from_sql(mut value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        match value.value_type() {
            Some(SqliteType::Text) => {
                let text = value.read_text();
                parse_db_datetime(text)
                    .ok_or_else(|| format!("invalid DateTime value: {text}").into())
            }
            Some(SqliteType::Double) => from_epoch_ms(value.read_double().trunc() as i64),
            _ => from_epoch_ms(value.read_long()),
        }
    }
}

impl Queryable<PrismaDateTime, Sqlite> for DateTime<Utc> {
    type Row = Self;

    fn build(row: Self) -> deserialize::Result<Self> {
        Ok(row)
    }
}

/// A date bound to a NOT NULL `DateTime` column, written as epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, AsExpression, FromSqlRow)]
#[diesel(sql_type = PrismaDateTime)]
pub struct DbDateTime(pub DateTime<Utc>);

impl DbDateTime {
    /// The current time.
    pub fn now() -> DbDateTime {
        DbDateTime(Utc::now())
    }
}

impl From<DateTime<Utc>> for DbDateTime {
    fn from(value: DateTime<Utc>) -> Self {
        DbDateTime(value)
    }
}

impl From<DbDateTime> for DateTime<Utc> {
    fn from(value: DbDateTime) -> Self {
        value.0
    }
}

impl std::ops::Deref for DbDateTime {
    type Target = DateTime<Utc>;

    fn deref(&self) -> &DateTime<Utc> {
        &self.0
    }
}

impl ToSql<PrismaDateTime, Sqlite> for DbDateTime {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        <DateTime<Utc> as ToSql<PrismaDateTime, Sqlite>>::to_sql(&self.0, out)
    }
}

impl FromSql<PrismaDateTime, Sqlite> for DbDateTime {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        <DateTime<Utc> as FromSql<PrismaDateTime, Sqlite>>::from_sql(value).map(DbDateTime)
    }
}

fn from_epoch_ms(ms: i64) -> deserialize::Result<DateTime<Utc>> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .ok_or_else(|| format!("DateTime value out of range: {ms}").into())
}

/// The time part of a stored date text, with its zone, as the Prisma client finds it.
static TIME_OF_DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$").expect("valid regex")
});

/// A date stored as text, read as the Prisma client reads it: a missing zone is
/// UTC, a missing time is midnight, a space before the time stands for `T`, and the
/// value keeps millisecond precision, as a JavaScript `Date` does.
pub fn parse_db_datetime(text: &str) -> Option<DateTime<Utc>> {
    let normalized = normalize_db_datetime(text);
    let parsed = DateTime::parse_from_rfc3339(&normalized)
        .or_else(|_| DateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S%.f%#z"))
        .ok()?;
    let ms = parsed.timestamp_millis();
    Utc.timestamp_millis_opt(ms).single()
}

fn normalize_db_datetime(text: &str) -> String {
    let Some(captures) = TIME_OF_DAY.captures(text) else {
        return format!("{text}T00:00:00Z");
    };
    let whole = captures.get(0).expect("group 0 always matches");
    let zone = captures.get(1).map(|m| m.as_str());
    let zone_minutes = captures.get(2);
    let mut result = match zone {
        Some(zone) if zone != "Z" && zone_minutes.is_none() => format!("{text}:00"),
        None => format!("{text}Z"),
        _ => text.to_string(),
    };
    if whole.as_str().len() == text.len() {
        return format!("1970-01-01T{result}");
    }
    let separator = whole.start() - 1;
    if result.as_bytes()[separator] == b' ' {
        result.replace_range(separator..separator + 1, "T");
    }
    result
}

// ---------------------------------------------------------------- Json

impl ToSql<PrismaJson, Sqlite> for Value {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(crate::support::js::stringify(self));
        Ok(IsNull::No)
    }
}

impl FromSql<PrismaJson, Sqlite> for Value {
    fn from_sql(mut value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let parsed = match value.value_type() {
            Some(SqliteType::Binary) => serde_json::from_slice(value.read_blob()),
            _ => serde_json::from_str(value.read_text()),
        };
        parsed.map_err(|e| format!("invalid Json value: {e}").into())
    }
}

impl Queryable<PrismaJson, Sqlite> for Value {
    type Row = Self;

    fn build(row: Self) -> deserialize::Result<Self> {
        Ok(row)
    }
}

/// A JSON value bound to a NOT NULL `Json` column.
#[derive(Debug, Clone, PartialEq, AsExpression, FromSqlRow)]
#[diesel(sql_type = PrismaJson)]
pub struct DbJson(pub Value);

impl From<Value> for DbJson {
    fn from(value: Value) -> Self {
        DbJson(value)
    }
}

impl From<DbJson> for Value {
    fn from(value: DbJson) -> Self {
        value.0
    }
}

impl std::ops::Deref for DbJson {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.0
    }
}

impl ToSql<PrismaJson, Sqlite> for DbJson {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        <Value as ToSql<PrismaJson, Sqlite>>::to_sql(&self.0, out)
    }
}

impl FromSql<PrismaJson, Sqlite> for DbJson {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        <Value as FromSql<PrismaJson, Sqlite>>::from_sql(value).map(DbJson)
    }
}

// ---------------------------------------------------------------- Bytes on the wire

/// Serde for a `Bytes` field as `JSON.stringify` writes the `Uint8Array` the Prisma
/// client returns: an object keyed by index, `{"0":1,"1":2}`. Reads that form or an
/// array of numbers.
pub mod uint8_array {
    use serde::de::{self, MapAccess, SeqAccess, Visitor};
    use serde::ser::SerializeMap;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(bytes.len()))?;
        for (index, byte) in bytes.iter().enumerate() {
            map.serialize_entry(&index.to_string(), byte)?;
        }
        map.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        d.deserialize_any(BytesVisitor)
    }

    struct BytesVisitor;

    impl<'de> Visitor<'de> for BytesVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a byte array")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
            let mut bytes = Vec::new();
            while let Some(byte) = seq.next_element::<u8>()? {
                bytes.push(byte);
            }
            Ok(bytes)
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Vec<u8>, A::Error> {
            let mut entries = Vec::new();
            while let Some((key, byte)) = map.next_entry::<String, u8>()? {
                let index: usize = key
                    .parse()
                    .map_err(|_| de::Error::custom(format!("invalid byte index: {key}")))?;
                entries.push((index, byte));
            }
            entries.sort_by_key(|(index, _)| *index);
            Ok(entries.into_iter().map(|(_, byte)| byte).collect())
        }
    }

    pub mod option {
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
            match bytes {
                Some(bytes) => super::serialize(bytes, s),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
            #[derive(Deserialize)]
            struct Wrapped(#[serde(with = "super")] Vec<u8>);
            Ok(Option::<Wrapped>::deserialize(d)?.map(|Wrapped(bytes)| bytes))
        }
    }
}
