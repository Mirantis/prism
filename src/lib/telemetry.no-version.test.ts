import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verifies that when SERVICE_VERSION is not set, the OTel resource does *not*
// carry a `service.version` attribute (rather than baking a misleading literal
// like 'unknown'). Companion to telemetry.enabled.test.ts which covers the
// happy path.

const { loggerProviderArgs } = vi.hoisted(() => ({
  loggerProviderArgs: [] as Array<{ resource?: { attributes?: Record<string, unknown> } }>,
}));

vi.mock('../config', () => ({
  config: {
    otelEndpoint: 'http://example.test',
    otelApiKey: '',
    deploymentEnvironment: 'development',
    serviceVersion: '',
  },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: class MockOTLPLogExporter {},
}));

vi.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: class MockLoggerProvider {
    constructor(args: { resource?: { attributes?: Record<string, unknown> } }) {
      loggerProviderArgs.push(args);
    }
    getLogger() {
      return { emit: () => {} };
    }
    shutdown() {
      return Promise.resolve();
    }
  },
  BatchLogRecordProcessor: class MockBatchLogRecordProcessor {},
}));

import { initTelemetry } from './telemetry';

describe('telemetry (enabled, but SERVICE_VERSION unset)', () => {
  beforeEach(() => {
    loggerProviderArgs.length = 0;
    initTelemetry();
  });

  it('omits service.version from the OTel resource when not configured', () => {
    expect(loggerProviderArgs).toHaveLength(1);
    const attrs = loggerProviderArgs[0]?.resource?.attributes ?? {};
    expect(attrs).not.toHaveProperty('service.version');
    // Other resource attributes still flow through.
    expect(attrs['service.name']).toBe('prism-agent-runtime');
    expect(attrs['deployment.environment.name']).toBe('development');
  });
});
