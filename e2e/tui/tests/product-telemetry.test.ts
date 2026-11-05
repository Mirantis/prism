/**
 * E2E: the `product.name` resource attribute on a real runtime's product
 * telemetry. Each scenario boots its own runtime with or without `PRODUCT_NAME`,
 * since the web suite shares one runtime whose environment no scenario can
 * change. The runtime exports OTLP/HTTP JSON to a collector this file runs, and
 * the assertions read the resource of the `agent started` event every boot sends.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/product-telemetry.feature'), 'utf8'),
);

interface OtlpAttribute {
  key: string;
  value?: { stringValue?: string };
}

interface OtlpLogsRequest {
  resourceLogs?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeLogs?: { logRecords?: { eventName?: string }[] }[];
  }[];
}

/** An OTLP/HTTP logs receiver that keeps every request body it is sent. */
interface Collector {
  url: string;
  requests: OtlpLogsRequest[];
  close(): Promise<void>;
}

async function startCollector(): Promise<Collector> {
  const requests: OtlpLogsRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/logs') requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The resource attributes of the batch holding the event, as a flat map. */
async function waitForEventResource(
  collector: Collector,
  eventName: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const request of collector.requests) {
      for (const resourceLog of request.resourceLogs ?? []) {
        const records = (resourceLog.scopeLogs ?? []).flatMap((s) => s.logRecords ?? []);
        if (!records.some((r) => r.eventName === eventName)) continue;
        return Object.fromEntries(
          (resourceLog.resource?.attributes ?? []).map((a) => [a.key, a.value?.stringValue ?? '']),
        );
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Telemetry event "${eventName}" not received within ${timeoutMs}ms`);
}

let collector: Collector | undefined;
let env: RuntimeTestEnv | undefined;
let resource: Record<string, string> = {};

async function bootWithProductName(productName: string | undefined): Promise<void> {
  collector = await startCollector();
  env = await setupRuntime({
    runtimeEnvOverrides: {
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_EXPORTER_OTLP_API_KEY: undefined,
      PRODUCT_NAME: productName,
    },
  });
}

describeFeature(feature, ({ AfterEachScenario, Scenario }) => {
  AfterEachScenario(async () => {
    await env?.cleanup();
    await collector?.close();
    env = undefined;
    collector = undefined;
    resource = {};
  });

  Scenario('A runtime started with PRODUCT_NAME tags its telemetry with it', ({ Given, When, Then, And }) => {
    Given('a runtime started with PRODUCT_NAME "e2e-product"', async () => {
      await bootWithProductName('e2e-product');
    });
    When('the runtime reports that the agent started', async () => {
      resource = await waitForEventResource(collector!, 'agent started', 30_000);
    });
    Then('the telemetry resource has product.name "e2e-product"', () => {
      expect(resource['product.name']).toBe('e2e-product');
    });
    And(
      'the telemetry resource keeps service.name "prism-agent-runtime" and service.namespace "prism-agent"',
      () => {
        expect(resource['service.name']).toBe('prism-agent-runtime');
        expect(resource['service.namespace']).toBe('prism-agent');
      },
    );
  });

  Scenario('A runtime started without PRODUCT_NAME sends no product name', ({ Given, When, Then, And }) => {
    Given('a runtime started without PRODUCT_NAME', async () => {
      await bootWithProductName(undefined);
    });
    When('the runtime reports that the agent started', async () => {
      resource = await waitForEventResource(collector!, 'agent started', 30_000);
    });
    Then('the telemetry resource has no product.name', () => {
      expect(resource).not.toHaveProperty('product.name');
    });
    And(
      'the telemetry resource keeps service.name "prism-agent-runtime" and service.namespace "prism-agent"',
      () => {
        expect(resource['service.name']).toBe('prism-agent-runtime');
        expect(resource['service.namespace']).toBe('prism-agent');
      },
    );
  });
});
