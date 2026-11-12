//! AWS credentials and region as a coding agent's CLI will find them.

use std::sync::LazyLock;

use regex::Regex;

use crate::lib::execution_environments::execution_environment::ProcessEnv;
use crate::support::js::{is_js_whitespace, trim};

/// A variable that is set and not empty, as JavaScript's truthiness reads it.
fn set(env: &ProcessEnv, key: &str) -> bool {
    env.get(key).is_some_and(|v| !v.is_empty())
}

/// The variable when it is set and not empty.
fn value<'a>(env: &'a ProcessEnv, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

/// Explicit AWS credentials or a configured AWS credential chain.
pub fn has_bedrock_credentials(env: &ProcessEnv) -> bool {
    set(env, "AWS_BEARER_TOKEN_BEDROCK")
        || (set(env, "AWS_ACCESS_KEY_ID") && set(env, "AWS_SECRET_ACCESS_KEY"))
        || set(env, "AWS_PROFILE")
        || (set(env, "AWS_WEB_IDENTITY_TOKEN_FILE") && set(env, "AWS_ROLE_ARN"))
        || set(env, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        || set(env, "AWS_CONTAINER_CREDENTIALS_FULL_URI")
}

/// `AWS_REGION`, else `AWS_DEFAULT_REGION`, else the region of the selected
/// profile (`AWS_PROFILE`, default `default`) in the config file, then in the
/// shared credentials file, else `us-east-1`.
pub fn bedrock_region(env: &ProcessEnv) -> String {
    if let Some(region) = value(env, "AWS_REGION").or_else(|| value(env, "AWS_DEFAULT_REGION")) {
        return region.to_string();
    }
    let profile = value(env, "AWS_PROFILE").unwrap_or("default");
    let home = value(env, "HOME")
        .map(str::to_string)
        .unwrap_or_else(home_dir);
    let config_file = value(env, "AWS_CONFIG_FILE")
        .map(str::to_string)
        .unwrap_or_else(|| join(&home, &[".aws", "config"]));
    let credentials_file = value(env, "AWS_SHARED_CREDENTIALS_FILE")
        .map(str::to_string)
        .unwrap_or_else(|| join(&home, &[".aws", "credentials"]));
    let config_section = if profile == "default" {
        "default".to_string()
    } else {
        format!("profile {profile}")
    };
    profile_region(&config_file, &config_section)
        .or_else(|| profile_region(&credentials_file, profile))
        .unwrap_or_else(|| "us-east-1".to_string())
}

/// `os.homedir()`.
#[allow(deprecated)]
fn home_dir() -> String {
    std::env::home_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `path.join(base, ...parts)` for the parts this module joins.
fn join(base: &str, parts: &[&str]) -> String {
    let mut path = std::path::PathBuf::from(base);
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().into_owned()
}

/// `[profile "x"]` and `[profile 'x']` read as `profile x`.
static QUOTED_PROFILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(profile)\s+["'](.+)["']$"#).expect("valid regex"));

/// The line before its comment: a `;` or `#` at the start or after whitespace.
fn strip_comment(raw: &str) -> &str {
    let mut previous: Option<char> = None;
    for (index, ch) in raw.char_indices() {
        if (ch == ';' || ch == '#') && previous.is_none_or(is_js_whitespace) {
            return &raw[..index];
        }
        previous = Some(ch);
    }
    raw
}

/// Read a profile's top-level region without loading its credentials. Lines
/// lose a `;` or `#` comment; `[profile "x"]` reads as `profile x`; a key with
/// an empty value opens a subsection, whose `region` is not the profile's.
fn profile_region(file: &str, section: &str) -> Option<String> {
    let contents = std::fs::read_to_string(file).ok()?;
    let mut selected = false;
    let mut subsection = false;
    let mut region: Option<String> = None;
    for raw_line in contents.split('\n') {
        let raw_line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let line = trim(strip_comment(raw_line));
        if line.starts_with('[') && line.ends_with(']') {
            let name = &line[1..line.len() - 1];
            selected = QUOTED_PROFILE.replace(name, "$1 $2") == section;
            subsection = false;
            continue;
        }
        if !selected || !line.contains('=') {
            continue;
        }
        if crate::support::js::trim_start(raw_line) == raw_line {
            subsection = false;
        }
        let equals = line.find('=').unwrap_or(0);
        let key = trim(&line[..equals]);
        let value = trim(&line[equals + 1..]);
        if value.is_empty() {
            subsection = true;
        }
        if key == "region" && !value.is_empty() && !subsection {
            region = Some(value.to_string());
        }
    }
    region
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::coding_agents::testing::env_of;

    struct Profiles {
        _root: tempfile::TempDir,
        config: String,
        credentials: String,
    }

    fn profiles() -> (Profiles, ProcessEnv) {
        let root = tempfile::Builder::new()
            .prefix("prism-profile-")
            .tempdir()
            .unwrap();
        let config = root.path().join("config").to_string_lossy().into_owned();
        let credentials = root
            .path()
            .join("credentials")
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            &config,
            "[default]\nregion=eu-west-1\n[profile review-profile]\nregion = us-west-2\n",
        )
        .unwrap();
        let env = env_of(&[
            ("AWS_PROFILE", "review-profile"),
            ("AWS_CONFIG_FILE", &config),
            ("AWS_SHARED_CREDENTIALS_FILE", &credentials),
        ]);
        (
            Profiles {
                _root: root,
                config,
                credentials,
            },
            env,
        )
    }

    #[test]
    fn preserves_the_selected_profile_region() {
        let (_files, env) = profiles();
        assert_eq!(bedrock_region(&env), "us-west-2");
    }

    #[test]
    fn uses_the_default_profile_when_no_profile_is_selected() {
        let (_files, mut env) = profiles();
        env.shift_remove("AWS_PROFILE");
        assert_eq!(bedrock_region(&env), "eu-west-1");
    }

    #[test]
    fn prefers_environment_regions_over_profile_settings() {
        let (_files, env) = profiles();
        let mut with_default = env.clone();
        with_default.insert("AWS_DEFAULT_REGION".into(), "eu-north-1".into());
        assert_eq!(bedrock_region(&with_default), "eu-north-1");
        let mut with_both = with_default.clone();
        with_both.insert("AWS_REGION".into(), "eu-central-1".into());
        assert_eq!(bedrock_region(&with_both), "eu-central-1");
    }

    #[test]
    fn uses_a_credentials_file_region_when_the_config_has_none() {
        let (files, env) = profiles();
        std::fs::write(&files.config, "[profile review-profile]\noutput=json\n").unwrap();
        std::fs::write(&files.credentials, "[review-profile]\nregion=ap-south-1\n").unwrap();
        assert_eq!(bedrock_region(&env), "ap-south-1");
    }

    #[test]
    fn uses_the_runtime_default_when_neither_file_supplies_a_region() {
        let (files, env) = profiles();
        std::fs::remove_file(&files.config).unwrap();
        assert_eq!(bedrock_region(&env), "us-east-1");
    }

    #[test]
    fn handles_comments_and_ignores_nested_service_settings() {
        let (files, env) = profiles();
        std::fs::write(
            &files.config,
            "[profile \"review-profile\"]\r\nregion=us-west-2 # regional endpoint\r\ns3=\r\n  region=eu-west-1\r\n",
        )
        .unwrap();
        assert_eq!(bedrock_region(&env), "us-west-2");
    }
}
