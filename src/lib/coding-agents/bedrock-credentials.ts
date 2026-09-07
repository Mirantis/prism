/** Explicit AWS credentials or a configured AWS credential chain. */
export function hasBedrockCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AWS_BEARER_TOKEN_BEDROCK ||
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
    env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    env.CLAUDE_CODE_USE_BEDROCK === '1'
  );
}
