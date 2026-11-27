//! Reads agent-creation model defaults from the shared `~/.prism/settings.json`
//! file, the same file the `prism` CLI reads for its display preferences.
//!
//! Used to seed a freshly-bootstrapped agent's `model` / `heartbeatModel` /
//! `cronModel` columns (see `agentWorkspaceService.createAgent`). Every field is
//! optional; a missing file, malformed JSON, a non-string value, or an
//! ill-formatted model id all fall back to "no default" (`None`): the
//! corresponding column then stays `null` and the agent resolves to
//! `BEDROCK_MODEL_ID` at invoke time.
//!
//! Recognised keys (all optional strings):
//!   - `modelId`          → the agent's main model override
//!   - `heartbeatModelId` → the heartbeat model override
//!   - `cronModelId`      → the scheduled-task model override
//!
//! `PRISM_SETTINGS_PATH` overrides the file location (used by tests).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_model: Option<String>,
}

// Letters, digits and a few separators cover Bedrock inference-profile ids,
// region-prefixed ids and bare vendor SKUs. Any id in this format is accepted,
// including a model the runtime has no entry for.
static MODEL_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:\-/]+$").expect("valid regex"));
pub const MODEL_ID_MAX_LEN: usize = 200;

/// The format rule for a model id, which the per-agent model override and the
/// settings file share.
pub fn is_valid_model_id(id: &str) -> bool {
    crate::support::js::len16(id) <= MODEL_ID_MAX_LEN && MODEL_ID_PATTERN.is_match(id)
}

/// `PRISM_SETTINGS_PATH`, else `~/.prism/settings.json`.
pub fn prism_settings_path() -> PathBuf {
    settings_path_for(std::env::var("PRISM_SETTINGS_PATH").ok().as_deref())
}

/// The settings path for a `PRISM_SETTINGS_PATH` value, read from any environment.
pub fn settings_path_for(override_path: Option<&str>) -> PathBuf {
    match override_path {
        Some(path) => PathBuf::from(path),
        None => home_dir().join(".prism").join("settings.json"),
    }
}

/// `os.homedir()`: `$HOME`, else the account's home directory.
fn home_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) {
        return PathBuf::from(home);
    }
    #[allow(deprecated)]
    std::env::home_dir().unwrap_or_default()
}

fn stderr_line(text: &str) {
    let _ = std::io::stderr().write_all(text.as_bytes());
}

/// The model id under `key`, if it is a valid one. A typo in the settings file
/// degrades to "no default" rather than persisting a bad id on the agent row.
fn pick_model_id(obj: &Map<String, Value>, key: &str) -> Option<String> {
    let value = obj.get(key)?;
    if value.is_null() {
        return None;
    }
    let Some(text) = value.as_str() else {
        stderr_line(&format!(
            "[prism-settings] '{key}' must be a string; ignoring\n"
        ));
        return None;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !is_valid_model_id(trimmed) {
        stderr_line(&format!(
            "[prism-settings] '{key}' is not a valid model id; ignoring\n"
        ));
        return None;
    }
    Some(trimmed.to_string())
}

/// Reads the defaults from `file_path`; callers pass `prism_settings_path()` for
/// the shared file.
pub fn read_agent_model_defaults(file_path: &Path) -> AgentModelDefaults {
    let raw = match std::fs::read_to_string(file_path) {
        Ok(raw) => raw,
        Err(err) => {
            // Missing file is the common case: fall back to no defaults silently.
            if err.kind() != std::io::ErrorKind::NotFound {
                stderr_line(&format!(
                    "[prism-settings] failed to read {}: {err}\n",
                    file_path.display()
                ));
            }
            return AgentModelDefaults::default();
        }
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            stderr_line(&format!(
                "[prism-settings] failed to parse {}: {err}\n",
                file_path.display()
            ));
            return AgentModelDefaults::default();
        }
    };

    let Value::Object(obj) = parsed else {
        stderr_line(&format!(
            "[prism-settings] {} must contain a JSON object; ignoring\n",
            file_path.display()
        ));
        return AgentModelDefaults::default();
    };

    AgentModelDefaults {
        model: pick_model_id(&obj, "modelId"),
        heartbeat_model: pick_model_id(&obj, "heartbeatModelId"),
        cron_model: pick_model_id(&obj, "cronModelId"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                dir: tempfile::Builder::new()
                    .prefix("prism-settings-")
                    .tempdir()
                    .unwrap(),
            }
        }

        fn file(&self) -> PathBuf {
            self.dir.path().join("settings.json")
        }

        fn write(&self, text: &str) {
            std::fs::write(self.file(), text).unwrap();
        }
    }

    #[test]
    fn reads_model_id_heartbeat_model_id_and_cron_model_id() {
        let fx = Fixture::new();
        fx.write(
            r#"{"modelId":"us.anthropic.claude-opus-4-8","heartbeatModelId":"us.anthropic.claude-haiku-4-5","cronModelId":"us.anthropic.claude-sonnet-4-6"}"#,
        );
        assert_eq!(
            read_agent_model_defaults(&fx.file()),
            AgentModelDefaults {
                model: Some("us.anthropic.claude-opus-4-8".into()),
                heartbeat_model: Some("us.anthropic.claude-haiku-4-5".into()),
                cron_model: Some("us.anthropic.claude-sonnet-4-6".into()),
            }
        );
    }

    #[test]
    fn returns_no_defaults_when_the_file_is_missing() {
        let fx = Fixture::new();
        assert_eq!(
            read_agent_model_defaults(&fx.dir.path().join("nope.json")),
            AgentModelDefaults::default()
        );
    }

    #[test]
    fn returns_no_defaults_on_malformed_json() {
        let fx = Fixture::new();
        fx.write("{ not json");
        assert_eq!(
            read_agent_model_defaults(&fx.file()),
            AgentModelDefaults::default()
        );
    }

    #[test]
    fn returns_no_defaults_when_the_json_is_not_an_object() {
        let fx = Fixture::new();
        fx.write(r#"["a", "b"]"#);
        assert_eq!(
            read_agent_model_defaults(&fx.file()),
            AgentModelDefaults::default()
        );
    }

    #[test]
    fn leaves_unset_overrides_absent() {
        let fx = Fixture::new();
        fx.write(r#"{"modelId":"us.anthropic.claude-opus-4-8"}"#);
        let result = read_agent_model_defaults(&fx.file());
        assert_eq!(
            result,
            AgentModelDefaults {
                model: Some("us.anthropic.claude-opus-4-8".into()),
                ..Default::default()
            }
        );
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"model":"us.anthropic.claude-opus-4-8"}"#
        );
    }

    #[test]
    fn ignores_blank_non_string_and_malformed_model_ids() {
        let fx = Fixture::new();
        fx.write(r#"{"modelId":"   ","heartbeatModelId":42,"cronModelId":"has spaces"}"#);
        assert_eq!(
            read_agent_model_defaults(&fx.file()),
            AgentModelDefaults::default()
        );
    }

    #[test]
    fn trims_surrounding_whitespace_from_a_valid_id() {
        let fx = Fixture::new();
        fx.write(r#"{"modelId":"  us.anthropic.claude-opus-4-8  "}"#);
        assert_eq!(
            read_agent_model_defaults(&fx.file()),
            AgentModelDefaults {
                model: Some("us.anthropic.claude-opus-4-8".into()),
                ..Default::default()
            }
        );
    }
}
