import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loggerProviderArgs } = vi.hoisted(() => ({
  loggerProviderArgs: [] as Array<{
    resource?: { attributes?: Record<string, unknown>; waitForAsyncAttributes?: () => Promise<void> };
  }>,
}));

vi.mock('../config', () => ({
  config: {
    otelEndpoint: 'http://example.test',
    otelApiKey: '',
    deploymentEnvironment: 'staging',
    serviceVersion: 'v2026.6.18060952',
    productName: 'example-product',
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
    constructor(args: (typeof loggerProviderArgs)[number]) {
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
    initTelemetry(async () => 'deployment-1');
  });

  it('attaches deployment.environment.name to the OTel resource', () => {
    expect(loggerProviderArgs).toHaveLength(1);
    const attrs = loggerProviderArgs[0]?.resource?.attributes ?? {};
    expect(attrs['deployment.environment.name']).toBe('staging');
    expect(attrs['service.name']).toBe('prism-agent-runtime');
    expect(attrs['service.namespace']).toBe('prism-agent');
  });

  it('attaches service.version to the OTel resource when configured', () => {
    expect(loggerProviderArgs).toHaveLength(1);
    const attrs = loggerProviderArgs[0]?.resource?.attributes ?? {};
    expect(attrs['service.version']).toBe('v2026.6.18060952');
  });

  it('attaches the deployment id to the OTel resource once it is read', async () => {
    const resource = loggerProviderArgs[0]?.resource;
    await resource?.waitForAsyncAttributes?.();
    expect(resource?.attributes?.['deployment.id']).toBe('deployment-1');
  });

  it('attaches product.name to the OTel resource when configured', () => {
    const attrs = loggerProviderArgs[0]?.resource?.attributes ?? {};
    expect(attrs['product.name']).toBe('example-product');
    expect(attrs['service.name']).toBe('prism-agent-runtime');
    expect(attrs['service.namespace']).toBe('prism-agent');
  });
});
