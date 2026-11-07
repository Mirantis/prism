//! The login saved in the Claude Code CLI's home, and the settings that keep a
//! task on it.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::lib::coding_agents::cli_probe::probe_cli;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

/// The variables that outrank a saved login in the CLI's credential order, or
/// send its requests somewhere other than the account's own API.
static OUTRANKS_SAVED_LOGIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)").unwrap()
});

/// The provider switches and credentials among those variables that Claude Code
/// 2.1.304 reads. `subscription_environment` takes them out of the task's env,
/// but the `env` block of a repository's `.claude/settings.json` or
/// `settings.local.json` sets them again, and `forceLoginMethod` does not refuse
/// a provider or key chosen there. Flag settings outrank both files, so a task's
/// `--settings` restates each one empty. A provider's own base URL needs no
/// entry: nothing reads it while its switch is off.
pub const SAVED_LOGIN_OVERRIDES: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_UNIX_SOCKET",
];

/// The `--settings` of a task on the subscription: the claude.ai login and no
/// other, whatever the repository's own settings say. An empty `apiKeyHelper`
/// replaces one that a repository sets. The base URL is the account's own API
/// rather than empty, because one of the CLI's reads takes an empty value as
/// set (`??`).
pub static SUBSCRIPTION_SETTINGS: LazyLock<String> = LazyLock::new(|| {
    let mut env = Map::new();
    for name in SAVED_LOGIN_OVERRIDES {
        env.insert((*name).to_string(), Value::String(String::new()));
    }
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        Value::String("https://api.anthropic.com".to_string()),
    );
    let settings = json!({
        "forceLoginMethod": "claudeai",
        "apiKeyHelper": "",
        "env": Value::Object(env),
    });
    serde_json::to_string(&settings).unwrap()
});

/// The login saved in the CLI's home: a Claude subscription signed in through
/// claude.ai, another saved login, or none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedLogin {
    Subscription,
    Other,
    None,
}

impl SavedLogin {
    pub fn as_str(self) -> &'static str {
        match self {
            SavedLogin::Subscription => "subscription",
            SavedLogin::Other => "other",
            SavedLogin::None => "none",
        }
    }
}

/// The fields of `claude auth status --json` that are read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    /// `null` in the CLI's output is kept as `Some(None)`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "::serde_with::rust::double_option"
    )]
    pub subscription_type: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// A saved login and the status it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatusReading {
    pub login: SavedLogin,
    pub status: AuthStatus,
}

/// `env` without the variables that outrank the home's saved login.
pub fn subscription_environment(env: &ProcessEnv) -> ProcessEnv {
    env.iter()
        .filter(|(key, _)| !OUTRANKS_SAVED_LOGIN.is_match(key))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Ask `claude auth status` about the home's saved login, in the environment
/// where the binary and its home are. It runs with `subscription_environment`,
/// so the answer is about the home alone.
///
/// Fails when the CLI gives no answer.
pub async fn read_saved_login(
    environment: &dyn ExecutionEnvironment,
    env: &ProcessEnv,
    config_dir: &str,
    signal: Option<tokio_util::sync::CancellationToken>,
) -> anyhow::Result<SavedLogin> {
    Ok(read_auth_status(environment, env, config_dir, signal)
        .await?
        .login)
}

/// `read_saved_login` with the status it was read from. The status names the
/// account, so only the person's own screen shows it: never a message, a log or
/// telemetry. A home that does not exist is `none` without running the CLI.
pub async fn read_auth_status(
    environment: &dyn ExecutionEnvironment,
    env: &ProcessEnv,
    config_dir: &str,
    signal: Option<CancellationToken>,
) -> anyhow::Result<AuthStatusReading> {
    if environment.files().stat(config_dir).await.is_err() {
        return Ok(AuthStatusReading {
            login: SavedLogin::None,
            status: AuthStatus::default(),
        });
    }
    let mut env = subscription_environment(env);
    env.insert("CLAUDE_CONFIG_DIR".to_string(), config_dir.to_string());
    let args: Vec<String> = AUTH_STATUS_ARGS.iter().map(|a| a.to_string()).collect();
    let run = probe_cli(environment, "claude", &args, env, signal).await?;
    parse_auth_status(&run.stdout, run.exit_code)
}

pub const AUTH_STATUS_ARGS: &[&str] = &["auth", "status", "--json"];

/// The saved login `claude auth status --json` printed. Fails when it printed no status.
pub fn saved_login_from_status(stdout: &str, exit_code: Option<i32>) -> anyhow::Result<SavedLogin> {
    Ok(parse_auth_status(stdout, exit_code)?.login)
}

/// `saved_login_from_status` with the status it was read from. The CLI exits 1
/// with the same JSON when nobody is signed in.
pub fn parse_auth_status(
    stdout: &str,
    exit_code: Option<i32>,
) -> anyhow::Result<AuthStatusReading> {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout) else {
        let code = exit_code.map_or_else(|| "null".to_string(), |code| code.to_string());
        anyhow::bail!("claude auth status exited with {code} and no status");
    };
    let status = AuthStatus {
        logged_in: parsed.get("loggedIn").and_then(Value::as_bool),
        auth_method: parsed
            .get("authMethod")
            .and_then(Value::as_str)
            .map(str::to_string),
        subscription_type: parsed
            .get("subscriptionType")
            .map(|value| value.as_str().map(str::to_string)),
        email: parsed
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    if status.logged_in != Some(true) {
        return Ok(AuthStatusReading {
            login: SavedLogin::None,
            status,
        });
    }
    let subscription = status.auth_method.as_deref() == Some("claude.ai")
        && status
            .subscription_type
            .as_ref()
            .is_some_and(|plan| plan.as_deref().is_some_and(|plan| !plan.is_empty()));
    Ok(AuthStatusReading {
        login: if subscription {
            SavedLogin::Subscription
        } else {
            SavedLogin::Other
        },
        status,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::lib::coding_agents::testing::{
        DIR_STAT, FakeChild, FakeEnvironment, FakeFiles, env_of,
    };
    use crate::lib::execution_environments::execution_environment::RunOptions;

    /// `claude auth status --json` output from Claude Code 2.1.304, with the
    /// account fields replaced. Signed out, it prints the same JSON and exits 1.
    const SIGNED_OUT: (&str, i32) = (
        r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#,
        1,
    );
    const SUBSCRIPTION: (&str, i32) = (
        r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"user@example.com","orgId":"org-1","orgName":"Example","subscriptionType":"max"}"#,
        0,
    );
    const API_KEY: (&str, i32) = (
        r#"{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}"#,
        0,
    );

    type Runs = Arc<parking_lot::Mutex<Vec<(String, Vec<String>, RunOptions)>>>;

    enum Answer {
        Prints(&'static str, i32),
        NoHome,
        LaunchFails,
    }

    /// An environment whose `claude` prints what `answer` says.
    fn stand_in(answer: Answer) -> (FakeEnvironment, Runs) {
        let runs: Runs = Arc::default();
        let sink = runs.clone();
        let no_home = matches!(answer, Answer::NoHome);
        let answer = Arc::new(answer);
        let environment = FakeEnvironment {
            files: FakeFiles {
                stat: Some(Arc::new(move |_| {
                    if no_home {
                        anyhow::bail!("ENOENT")
                    }
                    Ok(DIR_STAT)
                })),
                ..Default::default()
            },
            ..FakeEnvironment::with_run_program(move |command, args, options| {
                sink.lock()
                    .push((command.to_string(), args.to_vec(), options));
                let child = FakeChild::new();
                match &*answer {
                    Answer::LaunchFails => child.fail("claude: not found"),
                    Answer::Prints(stdout, code) => {
                        child.emit_line(stdout);
                        child.finish(Some(*code));
                    }
                    Answer::NoHome => child.finish(Some(0)),
                }
                child.process()
            })
        };
        (environment, runs)
    }

    async fn read(answer: Answer, env: &ProcessEnv) -> anyhow::Result<SavedLogin> {
        let (environment, _) = stand_in(answer);
        read_saved_login(&environment, env, "/home/.claude", None).await
    }

    #[tokio::test]
    async fn asks_the_cli_in_the_environment_about_the_home_with_the_env_that_runs_a_subscription()
    {
        let env = env_of(&[
            ("PATH", "/bin"),
            ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
            ("ANTHROPIC_API_KEY", "test-key"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("CLAUDE_CONFIG_DIR", "/theirs"),
        ]);
        let (environment, runs) = stand_in(Answer::Prints(SUBSCRIPTION.0, SUBSCRIPTION.1));
        assert_eq!(
            read_saved_login(&environment, &env, "/home/.claude", None)
                .await
                .unwrap(),
            SavedLogin::Subscription
        );
        let runs = runs.lock();
        assert_eq!(runs[0].0, "claude");
        assert_eq!(runs[0].1, ["auth", "status", "--json"]);
        assert_eq!(
            runs[0].2.env,
            env_of(&[
                ("PATH", "/bin"),
                ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                ("CLAUDE_CONFIG_DIR", "/home/.claude"),
            ])
        );
    }

    #[tokio::test]
    async fn reads_each_login_from_its_status() {
        let empty = ProcessEnv::new();
        let cases = [
            (SIGNED_OUT, SavedLogin::None),
            (API_KEY, SavedLogin::Other),
            (
                (
                    r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":null}"#,
                    0,
                ),
                SavedLogin::Other,
            ),
        ];
        for ((stdout, code), login) in cases {
            assert_eq!(
                read(Answer::Prints(stdout, code), &empty).await.unwrap(),
                login
            );
        }
    }

    #[tokio::test]
    async fn skips_the_cli_when_the_home_does_not_exist() {
        let (environment, runs) = stand_in(Answer::NoHome);
        assert_eq!(
            read_saved_login(&environment, &ProcessEnv::new(), "/home/.claude", None)
                .await
                .unwrap(),
            SavedLogin::None
        );
        assert!(runs.lock().is_empty());
    }

    #[tokio::test]
    async fn names_a_cli_that_does_not_start() {
        let err = read(Answer::LaunchFails, &ProcessEnv::new())
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("claude auth status failed: claude: not found")
        );
    }

    #[tokio::test]
    async fn names_output_that_is_not_the_status_json_without_quoting_it() {
        let err = read(
            Answer::Prints("Signed in as user@example.com", 0),
            &ProcessEnv::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "claude auth status exited with 0 and no status"
        );
    }

    #[test]
    fn drops_every_variable_that_outranks_the_saved_login_and_keeps_the_rest() {
        assert_eq!(
            subscription_environment(&env_of(&[
                ("PATH", "/bin"),
                ("ANTHROPIC_API_KEY", "test-key"),
                ("ANTHROPIC_AUTH_TOKEN", "test-token"),
                ("ANTHROPIC_BASE_URL", "https://proxy.example.test"),
                ("ANTHROPIC_FOUNDRY_API_KEY", "test-key"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "test-token"),
                ("CLAUDE_CODE_USE_BEDROCK", "1"),
                ("CLAUDE_CODE_USE_VERTEX", "1"),
                ("CLAUDE_CODE_USE_FOUNDRY", "1"),
                ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                ("AZURE_API_KEY", "test-key"),
                ("GOOGLE_APPLICATION_CREDENTIALS", "/creds.json"),
            ])),
            env_of(&[
                ("PATH", "/bin"),
                ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                ("AZURE_API_KEY", "test-key"),
                ("GOOGLE_APPLICATION_CREDENTIALS", "/creds.json"),
            ])
        );
    }

    #[test]
    fn the_subscription_settings_restate_every_variable_the_task_env_drops() {
        let settings: Value = serde_json::from_str(&SUBSCRIPTION_SETTINGS).unwrap();
        assert_eq!(settings["forceLoginMethod"], "claudeai");
        assert_eq!(settings["apiKeyHelper"], "");
        let mut expected = Map::new();
        for name in SAVED_LOGIN_OVERRIDES {
            expected.insert(name.to_string(), Value::String(String::new()));
        }
        expected.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            Value::String("https://api.anthropic.com".to_string()),
        );
        assert_eq!(settings["env"], Value::Object(expected));
        let mut env: ProcessEnv = settings["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect();
        env.insert("PATH".to_string(), "/bin".to_string());
        assert_eq!(subscription_environment(&env), env_of(&[("PATH", "/bin")]));
    }
}
