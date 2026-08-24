/**
 * Titan embeddings on bedrock-runtime — the `bedrock` embedding provider.
 * Serves both `bedrock` and `bedrock-mantle` chat deployments, since mantle
 * has no embedding models of its own.
 *
 * `baseURL` selects routing exactly as in `createBedrockProvider`: unset →
 * direct to AWS with resolved credentials; set → the Nexus gateway
 * (`…/llm/bedrock/{region}`), which does its own signing.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { config } from '../../config';
import { createSharedBedrockOptions } from '../llm-providers/bedrock-shared';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embedding-provider';

export function createBedrockEmbeddingProvider(baseURL?: string): EmbeddingProvider {
  const bedrock = createAmazonBedrock(
    baseURL ? { region: config.awsRegion, baseURL } : createSharedBedrockOptions(),
  );
  return {
    model: (modelId: string) => bedrock.embedding(modelId),
    // Titan v2 takes the truncation target under the `bedrock` key.
    providerOptions: { bedrock: { dimensions: EMBEDDING_DIMENSIONS } },
  };
}
