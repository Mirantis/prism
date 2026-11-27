//! Prism CLI configuration, read from `~/.prism/settings.json`.
//!
//! Every field is optional; a missing or malformed file falls back to the
//! defaults. `PRISM_HTTP_URL` overrides `httpUrl`, so a harness can point the CLI
//! at an ephemeral port without writing settings to disk.

use std::path::PathBuf;

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct PrismConfig {
    pub agent_name: String,
    pub model_id: String,
    pub hide_cursor: bool,
    pub hide_status_bar: bool,
    /// Base URL of the agent-runtime. The WebSocket URL is derived from it.
    pub http_url: String,
}

impl Default for PrismConfig {
    fn default() -> Self {
        PrismConfig {
            agent_name: "Prism".into(),
            model_id: "global.anthropic.claude-opus-5".into(),
            hide_cursor: false,
            hide_status_bar: false,
            http_url: "http://localhost:3003".into(),
        }
    }
}

pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_file_path() -> PathBuf {
    home_dir().join(".prism").join("settings.json")
}

pub fn load_config() -> PrismConfig {
    let mut cfg = read_from_file();
    if let Ok(url) = std::env::var("PRISM_HTTP_URL") {
        cfg.http_url = url;
    }
    cfg
}

fn read_from_file() -> PrismConfig {
    let path = config_file_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return PrismConfig::default(),
        Err(err) => {
            eprintln!("prism-cli: failed to read {}: {err}", path.display());
            return PrismConfig::default();
        }
    };
    parse_config(&raw, &path.display().to_string())
}

fn parse_config(raw: &str, path: &str) -> PrismConfig {
    let defaults = PrismConfig::default();
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("prism-cli: failed to parse {path}: {err}");
            return defaults;
        }
    };
    let Some(obj) = parsed.as_object() else {
        eprintln!("prism-cli: {path} must contain a JSON object; using defaults");
        return defaults;
    };
    let pick_string = |key: &str, fallback: &str| -> String {
        match obj.get(key) {
            None => fallback.to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                eprintln!("prism-cli: config key '{key}' must be a string; using default");
                fallback.to_string()
            }
        }
    };
    let pick_bool = |key: &str, fallback: bool| -> bool {
        match obj.get(key) {
            None => fallback,
            Some(Value::Bool(b)) => *b,
            Some(_) => {
                eprintln!("prism-cli: config key '{key}' must be a boolean; using default");
                fallback
            }
        }
    };
    PrismConfig {
        agent_name: pick_string("agentName", &defaults.agent_name),
        model_id: pick_string("modelId", &defaults.model_id),
        hide_cursor: pick_bool("hideCursor", defaults.hide_cursor),
        hide_status_bar: pick_bool("hideStatusBar", defaults.hide_status_bar),
        http_url: pick_string("httpUrl", &defaults.http_url),
    }
}

/// The HTTP client for the runtime's REST API. It connects directly, as the chat
/// socket does and as the Node CLI's `fetch` did: an `HTTP_PROXY` meant for the
/// internet would otherwise take the calls to a local runtime.
pub fn runtime_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_default()
}

/// The agent-runtime base URL without a trailing slash.
pub fn base_url(http_url: &str) -> String {
    http_url.strip_suffix('/').unwrap_or(http_url).to_string()
}

/// The WebSocket URL of the agent-runtime at `http_url`.
pub fn ws_url_from_http_url(http_url: &str) -> String {
    let trimmed = base_url(http_url);
    let ws = match trimmed.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => trimmed,
    };
    format!("{ws}/api/ws")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_socket_url() {
        assert_eq!(
            ws_url_from_http_url("http://localhost:3003"),
            "ws://localhost:3003/api/ws"
        );
        assert_eq!(
            ws_url_from_http_url("https://x.example/"),
            "wss://x.example/api/ws"
        );
    }

    #[test]
    fn reads_known_keys_and_falls_back_on_wrong_types() {
        let cfg = parse_config(r#"{"agentName":"Ada","hideCursor":true,"modelId":5}"#, "f");
        assert_eq!(cfg.agent_name, "Ada");
        assert!(cfg.hide_cursor);
        assert_eq!(cfg.model_id, "global.anthropic.claude-opus-5");
    }

    #[test]
    fn a_non_object_uses_the_defaults() {
        let cfg = parse_config("[1,2]", "f");
        assert_eq!(cfg.agent_name, "Prism");
    }
}
