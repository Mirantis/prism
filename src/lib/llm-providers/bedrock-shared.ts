/**
 * Shared bedrock-runtime plumbing for the two AWS vendors.
 *
 * `bedrock` and `bedrock-mantle` are separate providers — they speak different
 * protocols to different hosts — but they overlap on two things that are
 * properties of AWS Bedrock itself rather than of either provider:
 *
 *  - **Credential resolution.** Explicit keys, or the AWS default chain (ECS
 *    task role → container metadata). A bearer token in
 *    `AWS_BEARER_TOKEN_BEDROCK` short-circuits both; the SDK reads it from the
 *    environment itself.
 *  - **What an Anthropic model id looks like** on Bedrock.
 *
 * It lives here, beside the shared contract and the selector, rather than in
 * either vendor's folder: a peer importing a sibling vendor would make one of
 * them incidentally load the other's SDKs and read as the more fundamental of
 * the two, which neither is.
 */

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * Credential/region options for any bedrock-runtime SDK client: explicit keys
 * when set, otherwise the AWS default provider chain.
 */
export function createSharedBedrockOptions() {
  if (config.awsAccessKeyId && config.awsSecretAccessKey) {
    logger.info('Using explicit AWS credentials for Bedrock authentication');
    return {
      region: config.awsRegion,
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
      sessionToken: config.awsSessionToken || undefined,
    };
  }

  logger.info('Using default AWS credential provider chain for Bedrock authentication (no explicit keys set)');

  // In ECS, use the default credential provider chain (task role -> container metadata)
  const provider = defaultProvider();

  return {
    region: config.awsRegion,
    credentialProvider: async () => {
      logger.info('Using default AWS credential provider chain for Bedrock authentication');
      const creds = await provider();

      logger.info(`Credentials expire at ${creds.expiration} with scope ${creds.credentialScope}`);

      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      };
    },
  };
}
