//! The process logger, in pino's line format.
//!
//! Production (`NODE_ENV=production`) writes one JSON object per line:
//! `{"level":30,"time":<ms>,"pid":<pid>,"hostname":"…",<fields…>,"msg":"…"}`. Any
//! other environment writes pino-pretty's colorized form. `LOG_LEVEL` sets the
//! threshold, and `NODE_ENV=test` defaults it to silent.
//!
//! An `err` field always goes through `lib::log_redaction::serialize_error`, so no
//! request or response body reaches a log line.

use std::io::Write;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU8, Ordering};

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Level {
    Trace = 10,
    Debug = 20,
    Info = 30,
    Warn = 40,
    Error = 50,
    Fatal = 60,
    Silent = 255,
}

impl Level {
    fn parse(name: &str) -> Option<Level> {
        match name.trim().to_ascii_lowercase().as_str() {
            "trace" => Some(Level::Trace),
            "debug" => Some(Level::Debug),
            "info" => Some(Level::Info),
            "warn" => Some(Level::Warn),
            "error" => Some(Level::Error),
            "fatal" => Some(Level::Fatal),
            "silent" => Some(Level::Silent),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
            Level::Fatal => "FATAL",
            Level::Silent => "SILENT",
        }
    }

    fn color(self) -> &'static str {
        match self {
            Level::Trace => "\x1b[90m",
            Level::Debug => "\x1b[34m",
            Level::Info => "\x1b[32m",
            Level::Warn => "\x1b[33m",
            Level::Error => "\x1b[31m",
            Level::Fatal => "\x1b[41m",
            Level::Silent => "",
        }
    }
}

struct Settings {
    pretty: bool,
    pid: u32,
    hostname: String,
}

static THRESHOLD: AtomicU8 = AtomicU8::new(0);

static SETTINGS: LazyLock<Settings> = LazyLock::new(|| {
    let node_env = std::env::var("NODE_ENV").unwrap_or_default();
    let default = if node_env == "test" { Level::Silent } else { Level::Info };
    let level = std::env::var("LOG_LEVEL")
        .ok()
        .filter(|v| !v.is_empty())
        .and_then(|v| Level::parse(&v))
        .unwrap_or(default);
    THRESHOLD.store(level as u8, Ordering::Relaxed);
    Settings {
        pretty: node_env != "production",
        pid: std::process::id(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
});

/// Whether a line at `level` is written.
pub fn enabled(level: Level) -> bool {
    LazyLock::force(&SETTINGS);
    (level as u8) >= THRESHOLD.load(Ordering::Relaxed) && level != Level::Silent
}

/// Sets the threshold at runtime (tests and the `LOG_LEVEL` reload path).
pub fn set_level(level: Level) {
    LazyLock::force(&SETTINGS);
    THRESHOLD.store(level as u8, Ordering::Relaxed);
}

/// Writes one line. `fields` is an object merged into the line, or anything else
/// logged under `value`; `err` is reduced by the redacting serializer.
pub fn write(level: Level, fields: Option<Value>, msg: &str) {
    if !enabled(level) {
        return;
    }
    let settings = &*SETTINGS;
    let mut merged = Map::new();
    if let Some(fields) = fields {
        match fields {
            Value::Object(map) => {
                for (key, value) in map {
                    if key == "err" {
                        merged.insert(key, crate::lib::log_redaction::serialize_error_value(&value));
                    } else {
                        merged.insert(key, value);
                    }
                }
            }
            Value::Null => {}
            other => {
                merged.insert("value".into(), other);
            }
        }
    }
    let time = chrono::Utc::now();
    let line = if settings.pretty {
        pretty_line(level, time, settings.pid, &merged, msg)
    } else {
        let mut out = Map::new();
        out.insert("level".into(), Value::from(level as u8));
        out.insert("time".into(), Value::from(time.timestamp_millis()));
        out.insert("pid".into(), Value::from(settings.pid));
        out.insert("hostname".into(), Value::from(settings.hostname.clone()));
        for (key, value) in merged {
            out.insert(key, value);
        }
        out.insert("msg".into(), Value::from(msg));
        let mut text = Value::Object(out).to_string();
        text.push('\n');
        text
    };
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = lock.write_all(line.as_bytes());
    let _ = lock.flush();
}

fn pretty_line(
    level: Level,
    time: chrono::DateTime<chrono::Utc>,
    pid: u32,
    fields: &Map<String, Value>,
    msg: &str,
) -> String {
    let local = time.with_timezone(&chrono::Local);
    let mut text = format!(
        "\x1b[90m[{}]\x1b[0m {}{}\x1b[0m ({}): \x1b[36m{}\x1b[0m\n",
        local.format("%H:%M:%S%.3f"),
        level.color(),
        level.label(),
        pid,
        msg
    );
    for (key, value) in fields {
        let rendered = serde_json::to_string_pretty(value).unwrap_or_default();
        let indented = rendered.replace('\n', "\n    ");
        text.push_str(&format!("    \x1b[35m{key}\x1b[0m: {indented}\n"));
    }
    text
}

/// `log!(Level::Info, "text {}", x)` or `log!(Level::Info, json!({..}), "text {}", x)`.
#[macro_export]
macro_rules! log {
    ($level:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {
        if $crate::logger::enabled($level) {
            $crate::logger::write($level, None, &format!($fmt $(, $arg)*));
        }
    };
    ($level:expr, $fields:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {
        if $crate::logger::enabled($level) {
            $crate::logger::write($level, Some($fields), &format!($fmt $(, $arg)*));
        }
    };
}

#[macro_export]
macro_rules! log_trace { ($($t:tt)*) => { $crate::log!($crate::logger::Level::Trace, $($t)*) }; }
#[macro_export]
macro_rules! log_debug { ($($t:tt)*) => { $crate::log!($crate::logger::Level::Debug, $($t)*) }; }
#[macro_export]
macro_rules! log_info { ($($t:tt)*) => { $crate::log!($crate::logger::Level::Info, $($t)*) }; }
#[macro_export]
macro_rules! log_warn { ($($t:tt)*) => { $crate::log!($crate::logger::Level::Warn, $($t)*) }; }
#[macro_export]
macro_rules! log_error { ($($t:tt)*) => { $crate::log!($crate::logger::Level::Error, $($t)*) }; }
#[macro_export]
macro_rules! log_fatal { ($($t:tt)*) => { $crate::log!($crate::logger::Level::Fatal, $($t)*) }; }
