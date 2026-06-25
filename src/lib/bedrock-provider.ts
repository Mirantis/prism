/**
 * Bedrock Provider for Vercel AI SDK
 *
 * Chat generation dispatches on the model family: Anthropic models go through
 * the Anthropic-native Bedrock provider (Messages API via InvokeModel), and
 * any other model — Kimi, Llama, Mistral, etc. — goes through the generic
 * provider which uses Bedrock's Converse API (which normalizes tool/message
 * shapes across vendors). Embeddings always use the generic provider.
 *
 * Why this matters: the Anthropic-native provider hardcodes Anthropic's tool
 * wire format (`{ name, description, input_schema }`). Pointing it at a Kimi
 * model surfaces a Bedrock deserialization error ("Invalid 'tools': missing
 * field type") because Kimi expects OpenAI-shaped tool definitions.
 *
 * Two authentication paths exist side by side; the SDK picks between them
 * automatically based on which environment is populated:
 *
 * 1. Bearer token: when `AWS_BEARER_TOKEN_BEDROCK` is set,
 *    `@ai-sdk/amazon-bedrock` short-circuits SigV4 and sends
 *    `Authorization: Bearer <token>` directly to Bedrock. The env var
 *    may hold a `__nexus_cred:<uuid>__` sentinel that the MITM proxy
 *    rewrites on the wire to the real Bedrock API key.
 *
 * 2. SigV4: when no bearer token is set, the SDK uses the shared
 *    credential provider options below — ECS task role / container
 *    metadata in production, explicit access keys for local dev.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { config } from '../config';
import { logger } from '../logger';

function createSharedBedrockOptions() {
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
 * Create an Amazon Bedrock provider that dispatches on model family.
 *
 * Returns a callable `(modelId) => LanguageModel` for chat, plus an
 * `.embedding(modelId)` method for text embeddings:
 *  - Anthropic chat model IDs route through the Anthropic-native provider.
 *  - Anything else routes through the generic Converse-API provider.
 *  - Embeddings always route through the generic provider (the Anthropic
 *    provider doesn't expose embedding models).
 *
 * Supports two credential modes:
 * 1. Explicit keys via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (local dev)
 * 2. Default credential chain via credentialProvider — ECS task role, instance profile, etc. (production)
 */
export function createBedrockProvider() {
  logger.info('Creating Bedrock provider with configuration');

  const sharedOptions = createSharedBedrockOptions();
  const anthropic = createBedrockAnthropic(sharedOptions);
  const generic = createAmazonBedrock(sharedOptions);

  const dispatcher = (modelId: string) =>
    isAnthropicModelId(modelId) ? anthropic(modelId) : generic(modelId);
  return Object.assign(dispatcher, {
    embedding: (modelId: string) => generic.embedding(modelId),
  });
}

/**
 * Check if Bedrock is configured.
 *
 * In ECS, credentials come from the task role (no explicit keys needed).
 * Only AWS_REGION and BEDROCK_MODEL_ID are required as env vars.
 */
export function isBedrockConfigured(): boolean {
  return Boolean(config.awsRegion && config.bedrockModelId);
}
