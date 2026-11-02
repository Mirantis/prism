/**
 * The environment a Claude Code process runs in, for a task and for `claude`
 * in the desktop's terminal alike. Imports nothing that reads the
 * configuration, so the terminal's `coding-agent-exec` loads it without
 * starting the runtime.
 */

import { bedrockRegion, hasBedrockCredentials } from '../bedrock-credentials';
import { subscriptionEnvironment } from './authenticated-home';

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

/**
 * On the subscription, `env` without what outranks the saved login; otherwise
 * the deployment's provider, as `claudeCodeEnvironment` resolves it.
 */
export function claudeCodeLaunchEnvironment(env: NodeJS.ProcessEnv, subscription: boolean): NodeJS.ProcessEnv {
  return subscription ? subscriptionEnvironment(env) : claudeCodeEnvironment(env);
}
