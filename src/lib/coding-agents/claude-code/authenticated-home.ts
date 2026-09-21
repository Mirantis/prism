import { captureProgram } from '../../execution-environments/capture';
import { getExecutionEnvironment } from '../../execution-environments/get-execution-environment';
import { resolveClaudeConfigDir } from './home';

/** How long the CLI gets to answer before the probe gives up on it. */
const PROBE_TIMEOUT_MS = 5_000;

/** Enough for `{"loggedIn":true}` and whatever else the CLI prints around it. */
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/**
 * Whether the CLI has a saved login in its home.
 *
 * Asked of the execution environment, because that is where the binary and its
 * home are. Never throws: no answer means no saved login.
 */
export async function hasAuthenticatedClaudeHome(env: NodeJS.ProcessEnv): Promise<boolean> {
  const environment = getExecutionEnvironment();
  const configDir = resolveClaudeConfigDir(env);
  try {
    await environment.files.stat(configDir);
  } catch {
    return false;
  }
  const run = await captureProgram(environment, 'claude', ['auth', 'status', '--json'], {
    cwd: environment.workspaceRoot(),
    env: { ...env, CLAUDE_CONFIG_DIR: configDir },
    timeoutMs: PROBE_TIMEOUT_MS,
    limitBytes: PROBE_OUTPUT_LIMIT,
  });
  if (run.error || run.timedOut) return false;
  try {
    return (JSON.parse(run.stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}
