import { describe, it, expect, vi } from 'vitest';

// Test the disabled path (no endpoint configured).
// The enabled path is validated by TypeScript compilation + integration testing.

vi.mock('../config', () => ({
  config: { otelEndpoint: '' },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initTelemetry, trackEvent, shutdownTelemetry } from './telemetry';

describe('telemetry (disabled — no OTEL_EXPORTER_OTLP_ENDPOINT)', () => {
  it('initTelemetry does not throw', () => {
    expect(() => initTelemetry()).not.toThrow();
  });

  it('trackEvent is a no-op when not configured', () => {
    initTelemetry();
    expect(() => trackEvent('message feedback', 'user-123', { 'feedback.rating': 'up' })).not.toThrow();
  });

  it('trackEvent with null userId does not throw', () => {
    initTelemetry();
    expect(() => trackEvent('message feedback', null, { 'feedback.rating': 'up' })).not.toThrow();
  });

  it('shutdownTelemetry resolves without error', async () => {
    initTelemetry();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
