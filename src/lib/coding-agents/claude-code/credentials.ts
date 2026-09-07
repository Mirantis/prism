import { hasBedrockCredentials } from '../bedrock-credentials';

export function claudeCodeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const foundry = {
    ANTHROPIC_FOUNDRY_API_KEY: env.ANTHROPIC_FOUNDRY_API_KEY || env.AZURE_API_KEY,
    ANTHROPIC_FOUNDRY_RESOURCE: env.ANTHROPIC_FOUNDRY_RESOURCE || env.AZURE_RESOURCE_NAME,
  };
  if (env.CLAUDE_CODE_USE_FOUNDRY === '1') return { ...env, ...foundry };
  if (env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1' ||
      env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) return env;
  if (hasBedrockCredentials(env) && env.CLAUDE_CODE_USE_BEDROCK !== '0') {
    return { ...env, CLAUDE_CODE_USE_BEDROCK: '1' };
  }
  if ((foundry.ANTHROPIC_FOUNDRY_API_KEY || env.ANTHROPIC_FOUNDRY_AUTH_TOKEN) &&
      env.CLAUDE_CODE_USE_FOUNDRY !== '0') {
    return { ...env, ...foundry, CLAUDE_CODE_USE_FOUNDRY: '1' };
  }
  return env;
}

export function hasClaudeCodeCredentials(env: NodeJS.ProcessEnv): boolean {
  const resolved = claudeCodeEnvironment(env);
  return Boolean(resolved.ANTHROPIC_API_KEY || resolved.ANTHROPIC_AUTH_TOKEN ||
    resolved.CLAUDE_CODE_OAUTH_TOKEN || resolved.CLAUDE_CODE_USE_BEDROCK === '1' ||
    resolved.CLAUDE_CODE_USE_VERTEX === '1' || resolved.CLAUDE_CODE_USE_FOUNDRY === '1');
}
