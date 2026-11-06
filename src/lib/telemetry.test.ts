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

const deploymentId = vi.fn(async () => 'deployment-1');

describe('telemetry (disabled — no OTEL_EXPORTER_OTLP_ENDPOINT)', () => {
  it('initTelemetry does not throw', () => {
    expect(() => initTelemetry(deploymentId)).not.toThrow();
  });

  it('does not read or create a deployment id', () => {
    initTelemetry(deploymentId);
    expect(deploymentId).not.toHaveBeenCalled();
  });

  it('trackEvent is a no-op when not configured', () => {
    initTelemetry(deploymentId);
    expect(() => trackEvent('message feedback', 'user-123', { 'feedback.rating': 'up' })).not.toThrow();
  });

  it('trackEvent with null userId does not throw', () => {
    initTelemetry(deploymentId);
    expect(() => trackEvent('message feedback', null, { 'feedback.rating': 'up' })).not.toThrow();
  });

  it('shutdownTelemetry resolves without error', async () => {
    initTelemetry(deploymentId);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
