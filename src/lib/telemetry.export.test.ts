/**
 * `flushTelemetry` against the real batch processor, with only the OTLP
 * transport replaced: the answer depends on `forceFlush` waiting for the
 * exporter's callback, which a mocked processor would not show.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

type ExportDone = (result: { code: number; error?: Error }) => void;

const { collector } = vi.hoisted(() => ({
  // The result code the collector answers the next export with, after a delay.
  collector: { answer: 0, exported: 0 },
}));

vi.mock('../config', () => ({
  config: {
    otelEndpoint: 'http://example.test',
    otelApiKey: '',
    deploymentEnvironment: 'development',
    serviceVersion: '',
    productName: '',
  },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: class MockOTLPLogExporter {
    export(records: unknown[], done: ExportDone) {
      const code = collector.answer;
      setTimeout(() => {
        if (code === 0) collector.exported += records.length;
        done(code === 0 ? { code } : { code, error: new Error('refused') });
      }, 20);
    }
    forceFlush() {
      return Promise.resolve();
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

import { flushTelemetry, initTelemetry, trackEvent } from './telemetry';

beforeAll(() => {
  initTelemetry(async () => 'deployment-1');
});

describe('flushTelemetry with the real batch processor', () => {
  it('resolves true once the collector accepted the buffered records', async () => {
    collector.answer = 0;
    trackEvent('llm usage aggregated', undefined, { 'usage.model': 'model-a' });

    await expect(flushTelemetry()).resolves.toBe(true);
    expect(collector.exported).toBe(1);
  });

  it('resolves false when the collector refused them, and true for the next accepted flush', async () => {
    collector.answer = 1;
    trackEvent('llm usage aggregated', undefined, { 'usage.model': 'model-a' });
    await expect(flushTelemetry()).resolves.toBe(false);

    collector.answer = 0;
    trackEvent('llm usage aggregated', undefined, { 'usage.model': 'model-a' });
    await expect(flushTelemetry()).resolves.toBe(true);
  });
});
