import { readSavedLogin, type SavedLogin } from './authenticated-home';
import { claudeCodeEnvironment } from './environment';
import { getExecutionEnvironment } from '../../execution-environments/get-execution-environment';

export { claudeCodeEnvironment } from './environment';

export async function hasClaudeCodeCredentials(env: NodeJS.ProcessEnv): Promise<boolean> {
  const resolved = claudeCodeEnvironment(env);
  if (resolved.ANTHROPIC_API_KEY || resolved.ANTHROPIC_AUTH_TOKEN ||
      resolved.CLAUDE_CODE_OAUTH_TOKEN || resolved.CLAUDE_CODE_USE_BEDROCK === '1' ||
      resolved.CLAUDE_CODE_USE_VERTEX === '1' || resolved.CLAUDE_CODE_USE_FOUNDRY === '1') {
    return true;
  }
  // The saved login is the last resort: it costs a run of the CLI itself.
  const environment = getExecutionEnvironment();
  const login = await readSavedLogin(environment, env, environment.paths().claudeHome)
    .catch((): SavedLogin => 'none');
  return login !== 'none';
}
