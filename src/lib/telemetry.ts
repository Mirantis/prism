/**
 * Product Telemetry via OpenTelemetry Logs
 *
 * Emits discrete analytics events (e.g. "message feedback") as OTEL Log Records.
 * Events are sent via OTLP/HTTP to an OTEL Collector. In production this is a
 * shared third-party endpoint (authenticated with `x-api-key`); locally and in
 * e2e it is a docker-compose otelcol container.
 *
 * Disabled (no-op) when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 */

import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } from '@opentelemetry/semantic-conventions';
import { SeverityNumber, Logger } from '@opentelemetry/api-logs';
import { v7 as uuidv7 } from 'uuid';
import { config } from '../config';
import { logger } from '../logger';

// `deployment.environment.name` lives in the incubating semconv export, which our
// tsconfig (`moduleResolution: node10`) can't follow via subpath. The attribute
// name is stable per the OTel spec, so we inline the literal.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

let provider: LoggerProvider | null = null;
let otelLogger: Logger | null = null;

export function isTelemetryEnabled(): boolean {
  return !!config.otelEndpoint;
}

export function initTelemetry(): void {
  if (!config.otelEndpoint) {
    logger.info('[Telemetry] Not configured (no OTEL_EXPORTER_OTLP_ENDPOINT), skipping');
    return;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'prism-agent-runtime',
    [ATTR_SERVICE_NAMESPACE]: 'prism-agent',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.deploymentEnvironment,
  });

  const headers: Record<string, string> = {};
  if (config.otelApiKey) headers['x-api-key'] = config.otelApiKey;

  const exporter = new OTLPLogExporter({
    url: `${config.otelEndpoint}/v1/logs`,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });

  provider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(exporter)],
  });

  otelLogger = provider.getLogger('product-telemetry');

  logger.info(
    `[Telemetry] Initialized → ${config.otelEndpoint} (env: ${config.deploymentEnvironment})`,
  );
}

/**
 * Emit a product analytics event as an OTEL Log Record.
 *
 * No-op when telemetry is not configured.
 */
export function trackEvent(
  event: string,
  userId: string | null | undefined,
  properties?: Record<string, string>,
): void {
  if (!otelLogger) return;

  logger.info(`[Telemetry] Tracking event: ${event} (user: ${userId || 'unknown'})`);

  const attributes: Record<string, string> = {
    ...properties,
    'event.id': uuidv7(),
  };
  if (userId) {
    attributes['user.id'] = userId;
  }

  otelLogger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: event,
    eventName: event,
    attributes,
  });
}

export async function shutdownTelemetry(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    logger.info('[Telemetry] Shutdown complete');
  }
}
