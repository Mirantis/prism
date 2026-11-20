//! How a Codex task authenticates, and the login saved in Codex's home.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::lib::coding_agents::bedrock_credentials::has_bedrock_credentials;
use crate::lib::coding_agents::cli_probe::probe_cli;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::workspace::path_resolve;

/// Kept out of a run on the subscription: the variables Codex 0.163 takes a
/// credential from, each of which outranks a saved login, and the deployment's
/// OpenAI-compatible gateway, which must not receive the login's token.
pub const LEAVES_THE_SUBSCRIPTION: &[&str] = &[
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
];

/// How a Codex task authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexAuthMethod {
    Api,
    Saved,
    Bedrock,
    Subscription,
}

impl CodexAuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexAuthMethod::Api => "api",
            CodexAuthMethod::Saved => "saved",
            CodexAuthMethod::Bedrock => "bedrock",
            CodexAuthMethod::Subscription => "subscription",
        }
    }
}

/// The login saved in the CLI's home: a ChatGPT sign-in, another saved login, or none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedCodexLogin {
    Chatgpt,
    Other,
    None,
}

impl SavedCodexLogin {
    pub fn as_str(self) -> &'static str {
        match self {
            SavedCodexLogin::Chatgpt => "chatgpt",
            SavedCodexLogin::Other => "other",
            SavedCodexLogin::None => "none",
        }
    }
}

/// `CODEX_HOME`, else `<data dir>/.codex`, resolved. `data_dir` defaults to
/// `resolve_data_dir()`.
pub fn resolve_codex_home(env: &ProcessEnv, data_dir: Option<&str>) -> String {
    match data_dir {
        Some(dir) => resolve_codex_home_in(env, dir),
        None => resolve_codex_home_in(env, &crate::lib::data_dir::resolve_data_dir()),
    }
}

/// `resolve_codex_home` with the data dir given.
pub fn resolve_codex_home_in(env: &ProcessEnv, data_dir: &str) -> String {
    match env.get("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(home) => path_resolve(home),
        None => path_resolve(&format!("{data_dir}/.codex")),
    }
}

/// Whether the CLI has a saved login in its home (`<codex home>/auth.json`).
///
/// Asked of the execution environment, because that is where the home is.
/// Never fails: no answer means no saved login.
pub async fn has_saved_codex_login(environment: &dyn ExecutionEnvironment) -> bool {
    environment
        .files()
        .stat(&format!("{}/auth.json", environment.paths().codex_home))
        .await
        .is_ok()
}

/// `CODEX_API_KEY`, else `OPENAI_API_KEY`.
pub fn codex_api_key(env: &ProcessEnv) -> Option<String> {
    env.get("CODEX_API_KEY")
        .filter(|v| !v.is_empty())
        .or_else(|| env.get("OPENAI_API_KEY"))
        .cloned()
}

/// `saved_login` is the boot-time answer from `has_saved_codex_login`: reading the
/// home costs a round trip to the execution environment, and this is asked
/// while building a task's argv, where there is nothing to await on. Never
/// `Subscription`.
pub fn codex_auth_method(env: &ProcessEnv, saved_login: bool) -> Option<CodexAuthMethod> {
    if codex_api_key(env).is_some_and(|key| !key.is_empty()) {
        return Some(CodexAuthMethod::Api);
    }
    // Codex validates the saved credentials and refreshes its own login tokens.
    if saved_login {
        return Some(CodexAuthMethod::Saved);
    }
    if has_bedrock_credentials(env) {
        return Some(CodexAuthMethod::Bedrock);
    }
    None
}

/// `env` without the variables that outrank the home's saved login or move its endpoint.
pub fn subscription_environment(env: &ProcessEnv) -> ProcessEnv {
    env.iter()
        .filter(|(key, _)| !LEAVES_THE_SUBSCRIPTION.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Ask `codex login status` about the home's saved login, in the environment
/// where the binary and its home are, from the same credential store a task
/// reads.
///
/// Fails when the CLI gives no answer. Only the status line's form is read:
/// for an API key the line shows part of the key, so none of it reaches a
/// message.
pub async fn read_codex_login(
    environment: &dyn ExecutionEnvironment,
    env: &ProcessEnv,
    codex_home: &str,
    signal: Option<CancellationToken>,
) -> anyhow::Result<SavedCodexLogin> {
    let mut env = subscription_environment(env);
    env.insert("CODEX_HOME".to_string(), codex_home.to_string());
    let args: Vec<String> = LOGIN_STATUS_ARGS.iter().map(|a| a.to_string()).collect();
    let run = probe_cli(environment, "codex", &args, env, signal).await?;
    codex_login_from_status(&format!("{}\n{}", run.stdout, run.stderr), run.exit_code)
}

pub const LOGIN_STATUS_ARGS: &[&str] = &[
    "login",
    "status",
    "-c",
    "cli_auth_credentials_store=\"file\"",
];

static CHATGPT_LOGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^Logged in using ChatGPT$").unwrap());
static OTHER_LOGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^Logged in using ").unwrap());
static NOT_LOGGED_IN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^Not logged in$").unwrap());

/// The saved login `codex login status` printed. Fails when it printed no status.
pub fn codex_login_from_status(
    output: &str,
    exit_code: Option<i32>,
) -> anyhow::Result<SavedCodexLogin> {
    // Codex 0.163 writes the status to stderr, and exits 1 when nobody is signed in.
    if CHATGPT_LOGIN.is_match(output) {
        return Ok(SavedCodexLogin::Chatgpt);
    }
    if OTHER_LOGIN.is_match(output) {
        return Ok(SavedCodexLogin::Other);
    }
    if NOT_LOGGED_IN.is_match(output) {
        return Ok(SavedCodexLogin::None);
    }
    let code = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "null".to_string());
    anyhow::bail!("codex login status exited with {code} and no status")
}

/// The config a Codex run on the subscription takes: OpenAI's own provider at
/// ChatGPT's own endpoints, so the home's `config.toml` can't move it to one
/// that bills the deployment or receives the login's token, and the ChatGPT
/// login saved in the home's file store, and no other. Codex takes an empty
/// `openai_base_url` as unset, which for a ChatGPT login is ChatGPT's endpoint.
pub const SUBSCRIPTION_CONFIG_ARGS: &[&str] = &[
    "-c",
    "model_provider=\"openai\"",
    "-c",
    "openai_base_url=\"\"",
    "-c",
    "chatgpt_base_url=\"https://chatgpt.com/backend-api/\"",
    "-c",
    "forced_login_method=\"chatgpt\"",
    "-c",
    "cli_auth_credentials_store=\"file\"",
];

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::lib::coding_agents::testing::{
        FakeChild, FakeEnvironment, FakeFiles, env_of, fake_paths,
    };
    use crate::lib::execution_environments::execution_environment::RunOptions;

    fn environment_with_home(codex_home: &str) -> FakeEnvironment {
        let mut paths = fake_paths("/workspace");
        paths.codex_home = codex_home.to_string();
        FakeEnvironment {
            paths,
            files: FakeFiles::local(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn finds_a_saved_login_in_the_environment_the_cli_will_run_in() {
        let data_dir = tempfile::tempdir().unwrap();
        let home = data_dir.path().join(".codex");
        std::fs::create_dir(&home).unwrap();
        std::fs::write(home.join("auth.json"), "{}").unwrap();
        let home = home.to_string_lossy().into_owned();
        assert_eq!(
            resolve_codex_home(&ProcessEnv::new(), Some(&data_dir.path().to_string_lossy())),
            home
        );

        // Read through the environment, not this process's filesystem: under a
        // container the home is the container's.
        assert!(has_saved_codex_login(&environment_with_home(&home)).await);
        assert_eq!(
            codex_auth_method(&ProcessEnv::new(), true),
            Some(CodexAuthMethod::Saved)
        );
    }

    #[tokio::test]
    async fn reports_no_saved_login_when_the_home_holds_none() {
        let data_dir = tempfile::tempdir().unwrap();
        let other = data_dir.path().join("other").to_string_lossy().into_owned();
        assert!(!has_saved_codex_login(&environment_with_home(&other)).await);
        assert_eq!(codex_auth_method(&ProcessEnv::new(), false), None);
    }

    #[test]
    fn resolves_a_relative_home_before_the_child_changes_working_directory() {
        let resolved = resolve_codex_home(&env_of(&[("CODEX_HOME", "codex-home")]), Some("/data"));
        assert_eq!(
            resolved,
            std::env::current_dir()
                .unwrap()
                .join("codex-home")
                .to_string_lossy()
        );
    }

    #[test]
    fn uses_bedrock_when_a_saved_login_and_api_key_are_unavailable() {
        assert_eq!(
            codex_auth_method(&env_of(&[("AWS_PROFILE", "test-profile")]), false),
            Some(CodexAuthMethod::Bedrock)
        );
        assert_eq!(codex_auth_method(&ProcessEnv::new(), false), None);
    }

    type Runs = Arc<parking_lot::Mutex<Vec<(Vec<String>, RunOptions)>>>;

    /// An environment whose `codex` prints `stderr` and exits with `code`, or
    /// does not start.
    fn status_environment(stderr: Option<&'static str>, code: i32) -> (FakeEnvironment, Runs) {
        let runs: Runs = Arc::default();
        let sink = runs.clone();
        let environment = FakeEnvironment::with_run_program(move |_, args, options| {
            sink.lock().push((args.to_vec(), options));
            let child = FakeChild::new();
            match stderr {
                Some(stderr) => {
                    child.write_stderr(&format!("{stderr}\n"));
                    child.finish(Some(code));
                }
                None => child.fail("codex: not found"),
            }
            child.process()
        });
        (environment, runs)
    }

    async fn read(stderr: Option<&'static str>, code: i32) -> anyhow::Result<SavedCodexLogin> {
        let (environment, _) = status_environment(stderr, code);
        read_codex_login(&environment, &ProcessEnv::new(), "/home/.codex", None).await
    }

    #[tokio::test]
    async fn asks_the_cli_about_the_home_from_the_file_store_without_the_variables_that_outrank_it()
    {
        let env = env_of(&[
            ("PATH", "/bin"),
            ("OPENAI_API_KEY", "test-key"),
            ("CODEX_API_KEY", "test-key"),
            ("CODEX_ACCESS_TOKEN", "test-token"),
            ("AWS_PROFILE", "test-profile"),
            ("CODEX_HOME", "/theirs"),
        ]);
        let (environment, runs) = status_environment(Some("Logged in using ChatGPT"), 0);
        assert_eq!(
            read_codex_login(&environment, &env, "/home/.codex", None)
                .await
                .unwrap(),
            SavedCodexLogin::Chatgpt
        );
        let runs = runs.lock();
        assert_eq!(
            runs[0].0,
            [
                "login",
                "status",
                "-c",
                "cli_auth_credentials_store=\"file\""
            ]
        );
        assert_eq!(
            runs[0].1.env,
            env_of(&[
                ("PATH", "/bin"),
                ("AWS_PROFILE", "test-profile"),
                ("CODEX_HOME", "/home/.codex")
            ])
        );
    }

    /// `codex login status` as Codex 0.163 printed it, on stderr, with the key
    /// replaced. In a container, a warning line comes first.
    #[tokio::test]
    async fn reads_each_login_from_its_status() {
        assert_eq!(
            read(
                Some("WARNING: proceeding, even though we could not create PATH aliases\nLogged in using ChatGPT"),
                0
            )
            .await
            .unwrap(),
            SavedCodexLogin::Chatgpt
        );
        assert_eq!(
            read(Some("Logged in using an API key - sk-test-***-real"), 0)
                .await
                .unwrap(),
            SavedCodexLogin::Other
        );
        assert_eq!(
            read(Some("Not logged in"), 1).await.unwrap(),
            SavedCodexLogin::None
        );
    }

    #[tokio::test]
    async fn names_a_cli_that_does_not_start() {
        let err = read(None, 0).await.unwrap_err();
        assert!(
            err.to_string()
                .contains("codex login status failed: codex: not found")
        );
    }

    #[tokio::test]
    async fn names_output_that_is_not_a_status_without_quoting_it() {
        let err = read(Some("Signed in as user@example.com"), 0)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "codex login status exited with 0 and no status"
        );
    }

    #[test]
    fn keeps_every_variable_but_the_credentials_that_outrank_the_login_and_the_gateway() {
        assert_eq!(
            subscription_environment(&env_of(&[
                ("PATH", "/bin"),
                ("OPENAI_API_KEY", "test-key"),
                ("CODEX_API_KEY", "test-key"),
                ("CODEX_ACCESS_TOKEN", "test-token"),
                ("OPENAI_BASE_URL", "https://gateway.example.test/v1"),
                ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                ("OPENAI_MODEL_ID", "gpt-5.6-sol"),
            ])),
            env_of(&[
                ("PATH", "/bin"),
                ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                ("OPENAI_MODEL_ID", "gpt-5.6-sol"),
            ])
        );
    }
}
