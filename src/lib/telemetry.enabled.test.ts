import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExportDone = (result: { code: number }) => void;
interface CapturedExporter {
  export: (records: unknown[], done: ExportDone) => void;
}

const { loggerProviderArgs, collector, emitted } = vi.hoisted(() => ({
  loggerProviderArgs: [] as Array<{
    resource?: { attributes?: Record<string, unknown>; waitForAsyncAttributes?: () => Promise<void> };
  }>,
  // What the collector answers an export with: a result code, or no answer yet.
  collector: {
    answer: 0 as number | 'none',
    exporter: undefined as CapturedExporter | undefined,
    unanswered: undefined as ExportDone | undefined,
  },
  emitted: [] as Array<{ attributes?: Record<string, unknown> }>,
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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: class MockOTLPLogExporter {
    export(_records: unknown[], done: ExportDone) {
      if (collector.answer === 'none') collector.unanswered = done;
      else done({ code: collector.answer });
    }
  },
}));

vi.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: class MockLoggerProvider {
    constructor(args: (typeof loggerProviderArgs)[number]) {
      loggerProviderArgs.push(args);
    }
    getLogger() {
      return { emit: (record: (typeof emitted)[number]) => emitted.push(record) };
    }
    // As the batch processor does: hand the buffer to the exporter and wait for its answer.
    forceFlush() {
      return new Promise<void>((resolve) => {
        collector.exporter!.export([], () => resolve());
        if (collector.answer === 'none') resolve();
      });
    }
    shutdown() {
      return Promise.resolve();
    }
  },
  BatchLogRecordProcessor: class MockBatchLogRecordProcessor {
    constructor(args: { exporter: CapturedExporter }) {
      collector.exporter = args.exporter;
    }
  },
}));

import { flushTelemetry, initTelemetry, shutdownTelemetry, trackEvent } from './telemetry';
import { LOCAL_OWNER_USER_ID } from './local-owner';

describe('telemetry (enabled path)', () => {
  beforeEach(() => {
    loggerProviderArgs.length = 0;
    emitted.length = 0;
    collector.answer = 0;
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

  it('sends no user.id for the local-owner placeholder', () => {
    trackEvent('agent started', LOCAL_OWNER_USER_ID);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.attributes).not.toHaveProperty('user.id');
  });

  it('sends a real owner id as user.id', () => {
    trackEvent('agent started', 'user-real-1');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.attributes?.['user.id']).toBe('user-real-1');
  });

  it('reports false for a flush whose export the collector refused, and true for the next one', async () => {
    collector.answer = 1;
    await expect(flushTelemetry()).resolves.toBe(false);
    collector.answer = 0;
    await expect(flushTelemetry()).resolves.toBe(true);
  });

  it('reports false while an export has no answer', async () => {
    collector.answer = 'none';
    await expect(flushTelemetry()).resolves.toBe(false);

    // The exporter answers every export in the end, at the latest on its own timeout.
    collector.unanswered?.({ code: 0 });
    collector.answer = 0;
    await expect(flushTelemetry()).resolves.toBe(true);
  });

  it('flushes while running, and reports false once shut down', async () => {
    await expect(flushTelemetry()).resolves.toBe(true);
    await shutdownTelemetry();
    await expect(flushTelemetry()).resolves.toBe(false);
  });
});
