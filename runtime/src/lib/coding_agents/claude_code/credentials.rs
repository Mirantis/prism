//! Whether Claude Code has a credential to run with.

use super::authenticated_home::{SavedLogin, read_saved_login};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;

pub use super::environment::claude_code_environment;

/// A key, a token, or a provider switch in the resolved environment; else, as the
/// last resort since it costs a run of the CLI itself, a login saved in the
/// execution environment's Claude home (an unreadable one counts as none).
pub async fn has_claude_code_credentials(env: &ProcessEnv) -> bool {
    credentials_in(&*get_execution_environment(), env).await
}

async fn credentials_in(environment: &dyn ExecutionEnvironment, env: &ProcessEnv) -> bool {
    let resolved = claude_code_environment(env);
    let set = |key: &str| resolved.get(key).is_some_and(|v| !v.is_empty());
    let on = |key: &str| resolved.get(key).map(String::as_str) == Some("1");
    if set("ANTHROPIC_API_KEY")
        || set("ANTHROPIC_AUTH_TOKEN")
        || set("CLAUDE_CODE_OAUTH_TOKEN")
        || on("CLAUDE_CODE_USE_BEDROCK")
        || on("CLAUDE_CODE_USE_VERTEX")
        || on("CLAUDE_CODE_USE_FOUNDRY")
    {
        return true;
    }
    // The saved login is the last resort: it costs a run of the CLI itself.
    let login = read_saved_login(environment, env, &environment.paths().claude_home, None)
        .await
        .unwrap_or(SavedLogin::None);
    login != SavedLogin::None
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::lib::coding_agents::testing::{
        DIR_STAT, FakeChild, FakeEnvironment, FakeFiles, env_of,
    };

    /// An environment whose Claude home holds no login.
    fn no_home() -> FakeEnvironment {
        FakeEnvironment {
            files: FakeFiles {
                stat: Some(Arc::new(|_| anyhow::bail!("ENOENT"))),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// An environment whose `claude auth status` prints `stdout`, or never answers.
    fn home_printing(stdout: Option<&'static str>) -> FakeEnvironment {
        FakeEnvironment {
            files: FakeFiles {
                stat: Some(Arc::new(|_| Ok(DIR_STAT))),
                ..Default::default()
            },
            ..FakeEnvironment::with_run_program(move |_, _, _| {
                let child = FakeChild::new();
                match stdout {
                    Some(stdout) => {
                        child.emit_line(stdout);
                        child.finish(Some(0));
                    }
                    None => child.fail("spawn claude ENOENT"),
                }
                child.process()
            })
        }
    }

    async fn has(env: &ProcessEnv) -> bool {
        credentials_in(&no_home(), env).await
    }

    #[tokio::test]
    async fn enables_bedrock_for_aws_credentials() {
        for env in [
            env_of(&[
                ("AWS_BEARER_TOKEN_BEDROCK", "test-key"),
                ("HOME", "/nonexistent"),
            ]),
            env_of(&[
                ("AWS_ACCESS_KEY_ID", "test-id"),
                ("AWS_SECRET_ACCESS_KEY", "test-secret"),
                ("HOME", "/nonexistent"),
            ]),
            env_of(&[("AWS_PROFILE", "test-profile"), ("HOME", "/nonexistent")]),
        ] {
            assert!(has(&env).await);
            let mut expected = env.clone();
            expected.insert("CLAUDE_CODE_USE_BEDROCK".into(), "1".into());
            expected.insert("AWS_REGION".into(), "us-east-1".into());
            assert_eq!(claude_code_environment(&env), expected);
            assert!(!env.contains_key("CLAUDE_CODE_USE_BEDROCK"));
        }
    }

    #[test]
    fn preserves_explicit_authentication() {
        for (key, value) in [
            ("ANTHROPIC_API_KEY", "test-key"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "test-token"),
            ("CLAUDE_CODE_USE_VERTEX", "1"),
            ("CLAUDE_CODE_USE_BEDROCK", "0"),
        ] {
            let env = env_of(&[("AWS_PROFILE", "test-profile"), (key, value)]);
            assert_eq!(claude_code_environment(&env), env);
        }
    }

    #[test]
    fn sets_the_bedrock_region_for_explicit_backend_selection() {
        for (pairs, region) in [
            (vec![("AWS_DEFAULT_REGION", "us-west-2")], "us-west-2"),
            (
                vec![
                    ("AWS_REGION", "eu-west-1"),
                    ("AWS_DEFAULT_REGION", "us-west-2"),
                ],
                "eu-west-1",
            ),
            (vec![("HOME", "/nonexistent")], "us-east-1"),
        ] {
            let mut env = env_of(&pairs);
            env.insert("CLAUDE_CODE_USE_BEDROCK".into(), "1".into());
            assert_eq!(claude_code_environment(&env)["AWS_REGION"], region);
        }
    }

    #[tokio::test]
    async fn detects_a_saved_login_without_environment_credentials() {
        for status in [
            r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}"#,
            r#"{"loggedIn":true,"authMethod":"api_key"}"#,
        ] {
            assert!(credentials_in(&home_printing(Some(status)), &ProcessEnv::new()).await);
        }
    }

    #[tokio::test]
    async fn reads_no_login_from_a_cli_that_cannot_report_one() {
        assert!(!credentials_in(&home_printing(None), &ProcessEnv::new()).await);
    }

    #[tokio::test]
    async fn requires_a_foundry_resource_or_endpoint() {
        for key in [
            "ANTHROPIC_FOUNDRY_API_KEY",
            "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
            "AZURE_API_KEY",
        ] {
            let env = env_of(&[(key, "test-key")]);
            assert!(!has(&env).await);
            assert_eq!(claude_code_environment(&env), env);
            let mut with_resource = env.clone();
            with_resource.insert("ANTHROPIC_FOUNDRY_RESOURCE".into(), "test-resource".into());
            assert!(has(&with_resource).await);
            let mut with_url = env.clone();
            with_url.insert(
                "ANTHROPIC_FOUNDRY_BASE_URL".into(),
                "https://test.example/anthropic".into(),
            );
            assert!(has(&with_url).await);
        }
    }

    #[test]
    fn maps_runtime_foundry_credentials_to_cli_settings() {
        let env = claude_code_environment(&env_of(&[
            ("AZURE_API_KEY", "test-key"),
            ("AZURE_RESOURCE_NAME", "test-resource"),
        ]));
        assert_eq!(env["CLAUDE_CODE_USE_FOUNDRY"], "1");
        assert_eq!(env["ANTHROPIC_FOUNDRY_API_KEY"], "test-key");
        assert_eq!(env["ANTHROPIC_FOUNDRY_RESOURCE"], "test-resource");
    }

    /// The detection cases of each credential, as the boot probe reads them.
    #[tokio::test]
    async fn detects_claude_code_from_each_credential() {
        let cases: &[&[(&str, &str)]] = &[
            &[("ANTHROPIC_API_KEY", "test-credential")],
            &[("ANTHROPIC_AUTH_TOKEN", "test-credential")],
            &[("CLAUDE_CODE_OAUTH_TOKEN", "test-credential")],
            &[("AWS_BEARER_TOKEN_BEDROCK", "test-credential")],
            &[("AWS_PROFILE", "test-credential"), ("HOME", "/nonexistent")],
            &[
                ("AWS_WEB_IDENTITY_TOKEN_FILE", "test-credential"),
                ("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/test"),
                ("HOME", "/nonexistent"),
            ],
            &[
                ("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "test-credential"),
                ("HOME", "/nonexistent"),
            ],
            &[
                ("AWS_CONTAINER_CREDENTIALS_FULL_URI", "test-credential"),
                ("HOME", "/nonexistent"),
            ],
            &[
                ("AZURE_API_KEY", "test-credential"),
                ("AZURE_RESOURCE_NAME", "test-resource"),
            ],
            &[
                ("ANTHROPIC_FOUNDRY_API_KEY", "test-credential"),
                ("AZURE_RESOURCE_NAME", "test-resource"),
            ],
            &[
                ("ANTHROPIC_FOUNDRY_AUTH_TOKEN", "test-credential"),
                ("AZURE_RESOURCE_NAME", "test-resource"),
            ],
            &[("CLAUDE_CODE_USE_BEDROCK", "1"), ("HOME", "/nonexistent")],
            &[("CLAUDE_CODE_USE_VERTEX", "1")],
            &[("CLAUDE_CODE_USE_FOUNDRY", "1")],
        ];
        for pairs in cases {
            assert!(has(&env_of(pairs)).await, "{pairs:?}");
        }
    }

    #[tokio::test]
    async fn ignores_incomplete_or_empty_credentials_and_disabled_switches() {
        for pairs in [
            vec![("AWS_WEB_IDENTITY_TOKEN_FILE", "test-credential")],
            vec![("AWS_ROLE_ARN", "test-credential")],
            vec![("AZURE_API_KEY", "test-credential")],
            vec![
                ("ANTHROPIC_API_KEY", ""),
                ("CLAUDE_CODE_USE_BEDROCK", "0"),
                ("AWS_PROFILE", ""),
            ],
            vec![("OPENAI_API_KEY", "test-openai-key")],
        ] {
            assert!(!has(&env_of(&pairs)).await, "{pairs:?}");
        }
    }
}
