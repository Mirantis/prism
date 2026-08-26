/**
 * Shared bedrock-runtime plumbing for the two AWS vendors.
 *
 * `bedrock` and `bedrock-mantle` are separate providers — they speak different
 * protocols to different hosts — but they overlap on three things that are
 * properties of AWS Bedrock itself rather than of either provider:
 *
 *  - **Credential resolution.** Explicit keys, or the AWS default chain (ECS
 *    task role → container metadata). A bearer token in
 *    `AWS_BEARER_TOKEN_BEDROCK` short-circuits both; the SDK reads it from the
 *    environment itself.
 *  - **The generic (Converse + embeddings) provider.** Mantle serves no
 *    embedding models, so its embedding leg reaches bedrock-runtime through
 *    exactly the provider `bedrock` uses for Titan.
 *  - **What an Anthropic model id looks like** on Bedrock.
 *
 * It lives here, beside the shared contract and the selector, rather than in
 * either vendor's folder: a peer importing a sibling vendor would make one of
 * them incidentally load the other's SDKs and read as the more fundamental of
 * the two, which neither is.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
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

/**
 * Returns true when `modelId` is an Anthropic Claude model on Bedrock — bare
 * (`anthropic.claude-…`), regional inference profile (`us.anthropic.…`,
 * `eu.anthropic.…`, …), or an ARN containing `/anthropic.…`.
 */
export function isAnthropicModelId(modelId: string): boolean {
  return /^anthropic\.|\.anthropic\./i.test(modelId);
}

/**
 * Returns true when `modelId` is an xAI Grok model on Bedrock — bare
 * (`xai.grok-…`), cross-region inference profile (`us.xai.…`, `global.xai.…`),
 * or an ARN containing `/xai.…`.
 *
 * An application inference profile does not match: its ARN carries a generated
 * id with no vendor token. That is the same blind spot `isAnthropicModelId`
 * has, so such a profile already routes to Converse today.
 */
export function isXaiModelId(modelId: string): boolean {
  return /^xai\.|\.xai\./i.test(modelId);
}

/**
 * The generic (Converse + embeddings) bedrock-runtime provider on its own.
 *
 * `baseURL` selects routing exactly as in `createBedrockProvider`: unset →
 * direct to AWS with resolved credentials; set → the Lens Agents gateway,
 * which does its own signing.
 */
export function createBedrockEmbeddingProvider(baseURL?: string) {
  return createAmazonBedrock(
    baseURL ? { region: config.awsRegion, baseURL } : createSharedBedrockOptions(),
  );
}
