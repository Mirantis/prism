//! The environment a command inherits inside the container.
//!
//! A deny-list, like the local one, but a longer one: the local environment
//! strips only what would mislead a child of this process, while a Linux
//! container has its own `PATH`, `HOME` and userland, and inheriting the host's
//! would break every command — on macOS it would point at paths that do not
//! exist inside the container at all.
//!
//! It stays a deny-list rather than an allow-list so a credential for the
//! agent's own work still reaches its tools. What is dropped is what describes
//! *this process* or *this host*, and the runtime's own credentials.

use crate::lib::execution_environments::execution_environment::ProcessEnv;
use crate::lib::execution_environments::local::local_env::process_env;
use crate::services::channel_adapter_interface::CHAT_PLATFORMS;

/// Set by the image, and true of the container rather than the host.
pub const HOST_PROCESS_VARS: &[&str] = &[
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "OLDPWD",
    "TMPDIR",
    "TERM",
    "SHLVL",
    "_",
    // Both name a directory on this machine, and the container keeps each
    // coding agent's home in a volume of its own.
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    // A path or socket on this machine, which a tool in the container would
    // follow to nothing.
    "KUBECONFIG",
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "SSH_AUTH_SOCK",
    "DOCKER_HOST",
];

/// The runtime's own wiring: about the server, meaningless to a command.
pub const RUNTIME_SERVER_VARS: &[&str] = &[
    "NODE_ENV",
    "HUSKY",
    "PORT",
    "PRISM_HOST",
    "PRISM_ALLOWED_ORIGINS",
    "DATABASE_URL",
    "EXECUTION_ENVIRONMENT",
    // The host's display and bus, which the meeting and computer stacks own.
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "AT_SPI_BUS_ADDRESS",
];

/// The runtime's own credentials, by family. The agent's shell has no use for
/// them, and with one it could post as a chat platform's bot, sign in to the
/// meeting account, open the runtime's voice sessions, or write to the runtime's
/// traces and telemetry. A prefix, so a new variable in one of these families
/// stays out without a change here. A chat platform's variables start with its
/// name, so a new platform's credentials stay out as well.
///
/// `<PLATFORM>_` for each of `CHAT_PLATFORMS` uppercased, then `GOOGLE_BOT_`,
/// `LANGFUSE_`, `OTEL_`, `NEXUS_`, `OPENAI_REALTIME_`.
pub fn runtime_secret_prefixes() -> Vec<String> {
    CHAT_PLATFORMS
        .iter()
        .map(|platform| format!("{}_", platform.as_str().to_uppercase()))
        .chain(
            [
                "GOOGLE_BOT_",
                "LANGFUSE_",
                "OTEL_",
                "NEXUS_",
                "OPENAI_REALTIME_",
            ]
            .map(str::to_string),
        )
        .collect()
}

/// `base` (this process's environment when `None`) without the host's, the
/// server's and the runtime's secret variables.
pub fn docker_base_env(base: Option<&ProcessEnv>) -> ProcessEnv {
    let mut env = match base {
        Some(base) => base.clone(),
        None => process_env(),
    };
    for key in HOST_PROCESS_VARS.iter().chain(RUNTIME_SERVER_VARS) {
        env.shift_remove(*key);
    }
    let prefixes = runtime_secret_prefixes();
    env.retain(|key, _| {
        !prefixes
            .iter()
            .any(|prefix| key.starts_with(prefix.as_str()))
    });
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> ProcessEnv {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn keeps_the_runtimes_own_credentials_out_of_the_container() {
        let result = docker_base_env(Some(&env(&[
            ("SLACK_BOT_TOKEN", "xoxb-test"),
            ("SLACK_APP_TOKEN", "xapp-test"),
            ("TEAMS_APP_ID", "test-app-id"),
            ("TEAMS_APP_PASSWORD", "test-client-secret"),
            ("TEAMS_APP_TENANT_ID", "test-tenant-id"),
            ("GOOGLE_BOT_EMAIL", "bot@example.test"),
            ("GOOGLE_BOT_PASSWORD", "test-password"),
            ("LANGFUSE_SECRET_KEY", "test-secret"),
            ("OTEL_EXPORTER_OTLP_API_KEY", "test-otel-key"),
            ("NEXUS_API_URL", "https://nexus.example.test"),
            ("OPENAI_REALTIME_API_KEY", "test-realtime-key"),
        ])));
        // With any of these the agent's shell could post as the Slack or Teams bot
        // or sign in to the meeting account.
        assert!(result.is_empty(), "{result:?}");
    }

    #[test]
    fn keeps_the_credentials_the_agent_works_with() {
        let result = docker_base_env(Some(&env(&[
            ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
            ("ANTHROPIC_API_KEY", "test-key"),
            ("OPENAI_API_KEY", "test-key"),
            ("GH_TOKEN", "test-token"),
        ])));
        let mut keys: Vec<_> = result.keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "ANTHROPIC_API_KEY",
                "AWS_BEARER_TOKEN_BEDROCK",
                "GH_TOKEN",
                "OPENAI_API_KEY"
            ]
        );
    }

    #[test]
    fn drops_the_runtimes_own_server_wiring() {
        let result = docker_base_env(Some(&env(&[
            ("PORT", "3003"),
            ("PRISM_HOST", "0.0.0.0"),
            ("PRISM_ALLOWED_ORIGINS", "https://app.example.com"),
        ])));
        assert!(result.is_empty());
    }

    #[test]
    fn drops_a_variable_that_names_a_path_or_socket_on_this_machine() {
        let result = docker_base_env(Some(&env(&[
            ("KUBECONFIG", "/Users/me/.kube/config"),
            ("AWS_PROFILE", "work"),
            ("AWS_CONFIG_FILE", "/Users/me/.aws/config"),
            ("AWS_SHARED_CREDENTIALS_FILE", "/Users/me/.aws/credentials"),
            ("SSH_AUTH_SOCK", "/private/tmp/ssh-agent.sock"),
            ("DOCKER_HOST", "unix:///Users/me/.docker/run/docker.sock"),
            ("CLAUDE_CONFIG_DIR", "/Users/me/.claude"),
        ])));
        assert!(result.is_empty());
    }
}
