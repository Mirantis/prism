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
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { SeverityNumber, Logger } from '@opentelemetry/api-logs';
import { v7 as uuidv7 } from 'uuid';
import { config } from '../config';
import { logger } from '../logger';
import { isLangfuseEnabled } from './langfuse';

// `deployment.environment.name` lives in the incubating semconv export, which our
// tsconfig (`moduleResolution: node10`) can't follow via subpath. The attribute
// name is stable per the OTel spec, so we inline the literal.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
// Not an OTel semantic convention: the product that launched this agent, set by
// that product's recipe. `service.*` stays the runtime's own name for every product.
const ATTR_PRODUCT_NAME = 'product.name';
// The persisted id of this install, the attribute name Lens Agents uses for its own.
const ATTR_DEPLOYMENT_ID = 'deployment.id';

let provider: LoggerProvider | null = null;
let otelLogger: Logger | null = null;

export function isTelemetryEnabled(): boolean {
  return Boolean(config.otelEndpoint);
}

/**
 * Start the exporter. `deploymentId` is called only when an endpoint is set, so
 * a runtime without telemetry stores no id.
 */
export function initTelemetry(deploymentId: () => Promise<string | undefined>): void {
  if (!config.otelEndpoint) {
    logger.info('[Telemetry] Not configured (no OTEL_EXPORTER_OTLP_ENDPOINT), skipping');
    return;
  }

  // Resource attributes describe the *emitter* of every event on this stream.
  // `service.version` identifies the deployed build so events can be broken
  // down by version and regressions correlated to specific releases.
  // `product.name` separates the agents a product launched from the others.
  // `deployment.id` separates one install from another and stays the same across
  // restarts. It is read from the database, so it is a promise the exporter
  // waits for before the first batch leaves.
  const resource = resourceFromAttributes({
    [ATTR_DEPLOYMENT_ID]: deploymentId(),
    [ATTR_SERVICE_NAME]: 'prism-agent-runtime',
    [ATTR_SERVICE_NAMESPACE]: 'prism-agent',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.deploymentEnvironment,
    ...(config.serviceVersion ? { [ATTR_SERVICE_VERSION]: config.serviceVersion } : {}),
    ...(config.productName ? { [ATTR_PRODUCT_NAME]: config.productName } : {}),
  });

  const headers: Record<string, string> = {};
  if (config.otelApiKey) headers['x-api-key'] = config.otelApiKey;

  const exporter = new OTLPLogExporter({
    url: `${config.otelEndpoint}/v1/logs`,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });

  provider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter })],
  });

  otelLogger = provider.getLogger('product-telemetry');

  logger.info(
    `[Telemetry] Initialized → ${config.otelEndpoint} (env: ${config.deploymentEnvironment}, version: ${config.serviceVersion || '<unset>'})`,
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

  // debug, not info — some events fire per message/invocation and would
  // otherwise dominate the application log.
  logger.debug(`[Telemetry] Tracking event: ${event} (user: ${userId || 'unknown'})`);

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

/**
 * Tracing options for a `generateText` or `generateObject` call, routed to
 * Langfuse. Returns an empty object when Langfuse isn't configured, so call
 * sites can spread it unconditionally:
 *
 *   generateText({ ..., ...langfuseTelemetry('thread-title') })
 *
 * `recordContent: false` traces the call without its prompt or its completion —
 * the timing, the model and the token counts still arrive, the words do not. For
 * a call whose input is somebody else's speech rather than the operator's own
 * data, which is why the meeting gate passes it. Langfuse is a *stronger*
 * disclosure than a log line, not a weaker one: it is a durable store on another
 * host, so a call the log deliberately does not record must not arrive there
 * either.
 *
 * `identifiers` ride the SDK's runtime context, not a telemetry field: the
 * `metadata` option this used to pass no longer exists, and since it was spread
 * out of a declared return type rather than written as a literal, nothing
 * rejected it — the values were simply dropped before reaching a span. Each key
 * has to be opted in by name, and arrives as `ai.settings.context.<key>`.
 *
 * An embedding call takes telemetry but no runtime context, so it has its own
 * `langfuseEmbedTelemetry()` rather than this one — see there.
 */
export function langfuseTelemetry(
  functionId: string,
  identifiers?: Record<string, string>,
  options?: { recordContent?: boolean },
): {
  runtimeContext?: Record<string, string>;
  experimental_telemetry?: {
    isEnabled: true;
    functionId: string;
    includeRuntimeContext?: Record<string, boolean>;
    recordInputs?: boolean;
    recordOutputs?: boolean;
  };
} {
  if (!isLangfuseEnabled()) return {};
  return {
    ...(identifiers ? { runtimeContext: identifiers } : {}),
    experimental_telemetry: {
      isEnabled: true,
      functionId,
      ...(identifiers
        ? {
            includeRuntimeContext: Object.fromEntries(
              Object.keys(identifiers).map((key) => [key, true]),
            ),
          }
        : {}),
      ...(options?.recordContent === false ? { recordInputs: false, recordOutputs: false } : {}),
    },
  };
}

/**
 * Tracing options for an embedding call (`embed`, `embedMany`), routed to
 * Langfuse. Same contract as `langfuseTelemetry()` minus the identifiers.
 *
 * Separate rather than a flag, because those two take telemetry but no runtime
 * context — and a spread property the callee does not declare is dropped
 * without complaint, since TypeScript checks excess properties only on an
 * object literal, never on what a spread brings in. Attaching identifiers to an
 * embedding call therefore cannot be made a compile error; taking the parameter
 * away is the next best thing, so reaching for one here means switching helpers
 * rather than adding an argument.
 */
export function langfuseEmbedTelemetry(functionId: string): {
  experimental_telemetry?: { isEnabled: true; functionId: string };
} {
  if (!isLangfuseEnabled()) return {};
  return { experimental_telemetry: { isEnabled: true, functionId } };
}
