/**
 * The environment a command inherits inside the container.
 *
 * A deny-list, like the local one, but a longer one: the local environment
 * strips only what would mislead a child of this process, while a Linux
 * container has its own `PATH`, `HOME` and userland, and inheriting the host's
 * would break every command — on macOS it would point at paths that do not
 * exist inside the container at all.
 *
 * It stays a deny-list rather than an allow-list so a credential nobody
 * anticipated still reaches the agent's tools. What is dropped is what
 * describes *this process* or *this host*, not what describes the work.
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
] as const;

/** The runtime's own wiring: about the server, meaningless to a command. */
const RUNTIME_SERVER_VARS = [
  'NODE_ENV',
  'HUSKY',
  'PORT',
  'PRISM_HOST',
  'DATABASE_URL',
  'EXECUTION_ENVIRONMENT',
  // The host's display and bus, which the meeting and computer stacks own.
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
] as const;

export function dockerBaseEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of [...HOST_PROCESS_VARS, ...RUNTIME_SERVER_VARS]) {
    delete env[key];
  }
  return env;
}
