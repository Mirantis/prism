/**
 * Langfuse LLM Observability
 *
 * Sets up OpenTelemetry with LangfuseSpanProcessor to capture all
 * generateText() calls (chat, heartbeat, cron, classification gate).
 *
 * Disabled when LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are not set.
 *
 * The AI SDK emits no span on its own. It calls whatever telemetry integration
 * is registered, and `@ai-sdk/otel` supplies two: `LegacyOpenTelemetry` writes
 * `ai.generateText` / `ai.generateText.doGenerate` under instrumentation scope
 * `ai`, and `OpenTelemetry` writes GenAI-convention spans under scope `gen_ai`.
 * The legacy one is the match here, because `LangfuseSpanProcessor` reads media
 * out of `ai.prompt` and `ai.prompt.messages` on scope `ai` and does not know
 * the GenAI names — so the other integration would send spans Langfuse renders
 * without their prompts.
 *
 * Registering only when the keys are set keeps the cost where it belongs: with
 * no integration registered, a call carrying telemetry options produces no span
 * at all, so an unconfigured deployment builds nothing.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { registerTelemetry } from 'ai';
import { LegacyOpenTelemetry } from '@ai-sdk/otel';
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
  // Ordering is not load-bearing, despite reading that way: the integration
  // takes its tracer in its constructor, but `@opentelemetry/api` hands out a
  // proxy that resolves its delegate on first use, so one built ahead of the
  // SDK would still find this provider.
  registerTelemetry(new LegacyOpenTelemetry());
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
