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
    todo!()
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
