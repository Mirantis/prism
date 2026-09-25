/**
 * The environment a command inherits inside the container.
 *
 * A deny-list, like the local one, but a longer one: the local environment
 * strips only what would mislead a child of this process, while a Linux
 * container has its own `PATH`, `HOME` and userland, and inheriting the host's
 * would break every command — on macOS it would point at paths that do not
 * exist inside the container at all.
 *
 * It stays a deny-list rather than an allow-list so a credential for the
 * agent's own work still reaches its tools. What is dropped is what describes
 * *this process* or *this host*, and the runtime's own credentials.
 */

/** Set by the image, and true of the container rather than the host. */
const HOST_PROCESS_VARS = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TERM',
  'SHLVL',
  '_',
  // Both name a directory on this machine, and the container keeps each
  // coding agent's home in a volume of its own.
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  // A path or socket on this machine, which a tool in the container would
  // follow to nothing.
  'KUBECONFIG',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'SSH_AUTH_SOCK',
  'DOCKER_HOST',
] as const;

/** The runtime's own wiring: about the server, meaningless to a command. */
const RUNTIME_SERVER_VARS = [
  'NODE_ENV',
  'HUSKY',
  'PORT',
  'PRISM_HOST',
  'DATABASE_URL',
  'EXECUTION_ENVIRONMENT',
  // The host's display and bus, which the computer's stack owns.
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
] as const;

/**
 * The runtime's own credentials, by family. The agent's shell has no use for
 * them, and with one it could post as the Slack bot, open the runtime's voice
 * sessions, or write to the runtime's traces and telemetry. `GOOGLE_BOT_` holds a
 * Google account password an install may still set. A prefix, so a new variable in
 * one of these families stays out without a change here.
 */
const RUNTIME_SECRET_PREFIXES = [
  'SLACK_',
  'GOOGLE_BOT_',
  'LANGFUSE_',
  'OTEL_',
  'NEXUS_',
  'OPENAI_REALTIME_',
] as const;

export function dockerBaseEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of [...HOST_PROCESS_VARS, ...RUNTIME_SERVER_VARS]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (RUNTIME_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  return env;
}
