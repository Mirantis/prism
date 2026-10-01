import { describe, expect, it } from 'vitest';
import { webhookOrigin } from './webhook-endpoint';

describe('webhook endpoint origin', () => {
  it('uses the published webhook address', () => {
    expect(webhookOrigin({ publicUrl: 'https://hooks.example.com', port: 3004 },
      { hostname: 'app.example.com', protocol: 'https:' })).toBe('https://hooks.example.com');
  });

  it.each(['app.example.com', '192.168.1.10'])('requires an exposed address for %s', (hostname) => {
    expect(webhookOrigin({ publicUrl: null, port: 3004 }, { hostname, protocol: 'https:' })).toBeNull();
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('builds a local endpoint for %s', (hostname) => {
    expect(webhookOrigin({ publicUrl: null, port: 3314 }, { hostname, protocol: 'http:' }))
      .toBe(`http://${hostname}:3314`);
  });
});
