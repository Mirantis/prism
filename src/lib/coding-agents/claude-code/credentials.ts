import { readSavedLogin, type SavedLogin } from './authenticated-home';
import { bedrockRegion, hasBedrockCredentials } from '../bedrock-credentials';
import { getExecutionEnvironment } from '../../execution-environments/get-execution-environment';

export function claudeCodeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const foundry = {
    ANTHROPIC_FOUNDRY_API_KEY: env.ANTHROPIC_FOUNDRY_API_KEY || env.AZURE_API_KEY,
    ANTHROPIC_FOUNDRY_RESOURCE: env.ANTHROPIC_FOUNDRY_RESOURCE || env.AZURE_RESOURCE_NAME,
  };
  if (env.CLAUDE_CODE_USE_FOUNDRY === '1') return { ...env, ...foundry };
  const usesOtherCredentials = env.CLAUDE_CODE_USE_VERTEX === '1' ||
    env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN;
  if (env.CLAUDE_CODE_USE_BEDROCK === '1' ||
      (!usesOtherCredentials && hasBedrockCredentials(env) && env.CLAUDE_CODE_USE_BEDROCK !== '0')) {
    return { ...env, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: bedrockRegion(env) };
  }
  if (usesOtherCredentials) return env;
  if ((foundry.ANTHROPIC_FOUNDRY_API_KEY || env.ANTHROPIC_FOUNDRY_AUTH_TOKEN) &&
      (foundry.ANTHROPIC_FOUNDRY_RESOURCE || env.ANTHROPIC_FOUNDRY_BASE_URL) &&
      env.CLAUDE_CODE_USE_FOUNDRY !== '0') {
    return { ...env, ...foundry, CLAUDE_CODE_USE_FOUNDRY: '1' };
  }
  return env;
}

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
