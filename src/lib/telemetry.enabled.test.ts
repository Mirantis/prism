import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loggerProviderArgs } = vi.hoisted(() => ({
  loggerProviderArgs: [] as Array<{ resource?: { attributes?: Record<string, unknown> } }>,
}));

vi.mock('../config', () => ({
  config: {
    otelEndpoint: 'http://example.test',
    otelApiKey: '',
    deploymentEnvironment: 'staging',
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

describe('telemetry (enabled path)', () => {
  beforeEach(() => {
    loggerProviderArgs.length = 0;
    initTelemetry();
  });

  it('attaches deployment.environment.name to the OTel resource', () => {
    expect(loggerProviderArgs).toHaveLength(1);
    const attrs = loggerProviderArgs[0]?.resource?.attributes ?? {};
    expect(attrs['deployment.environment.name']).toBe('staging');
    expect(attrs['service.name']).toBe('lens-agents-runtime');
    expect(attrs['service.namespace']).toBe('lens-agents');
  });
});
