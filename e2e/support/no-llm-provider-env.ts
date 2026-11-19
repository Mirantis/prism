/**
 * Runtime env for a start with no LLM credential: the default provider, no
 * gateway, no key, and an AWS default chain with nothing to read. The values are
 * empty rather than absent, so the runtime's dotenv load of the repo-root `.env`
 * cannot bring a key back. `dir` holds no AWS config or credentials file.
 */

import path from 'node:path';

export function noLlmProviderEnv(dir: string): Record<string, string> {
  return {
    LLM_PROVIDER: '',
    NEXUS_API_URL: '',
    AWS_BEARER_TOKEN_BEDROCK: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    AWS_SESSION_TOKEN: '',
    AWS_PROFILE: '',
    AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'credentials'),
    AWS_CONFIG_FILE: path.join(dir, 'config'),
    AWS_WEB_IDENTITY_TOKEN_FILE: '',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: '',
    // A CI runner's own metadata endpoint is not AWS's.
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}
