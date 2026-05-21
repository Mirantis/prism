/**
 * Langfuse LLM Observability
 *
 * Sets up OpenTelemetry with LangfuseSpanProcessor to capture all
 * generateText() calls (chat, heartbeat, cron, classification gate).
 *
 * Disabled when LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are not set.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { config } from '../config';
import { logger } from '../logger';

let sdk: NodeSDK | null = null;

export function initLangfuse(): void {
  if (!config.langfuseSecretKey || !config.langfusePublicKey) {
    logger.info('[Langfuse] Not configured (no keys), skipping');
    return;
  }

  const spanProcessor = new LangfuseSpanProcessor({
    secretKey: config.langfuseSecretKey,
    publicKey: config.langfusePublicKey,
    baseUrl: config.langfuseBaseUrl,
  });

  sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  logger.info(`[Langfuse] Initialized → ${config.langfuseBaseUrl}`);
}

export function isLangfuseEnabled(): boolean {
  return sdk !== null;
}

export async function shutdownLangfuse(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    logger.info('[Langfuse] Shutdown complete');
  }
}
