/**
 * E2E: the `product.name` and `deployment.id` resource attributes and the hourly
 * `llm usage aggregated` event on a real runtime's product telemetry. Each
 * scenario boots its own runtime, since the web suite shares one runtime whose
 * environment and restarts no scenario can control. The runtime exports
 * OTLP/HTTP JSON to a collector this file runs. The usage scenario writes a past
 * call into the database, as the runtime records one, because a live call cannot
 * be made in a closed hour.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
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
    scopeLogs?: { logRecords?: { eventName?: string; attributes?: OtlpAttribute[] }[] }[];
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

function flatten(attributes: OtlpAttribute[] | undefined): Record<string, string> {
  return Object.fromEntries((attributes ?? []).map((a) => [a.key, a.value?.stringValue ?? '']));
}

/** One received record of an event: its attributes and its batch's resource, as flat maps. */
interface ReceivedEvent {
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

/** Every record of the event received so far, in the order received. */
function receivedEvents(collector: Collector, eventName: string): ReceivedEvent[] {
  const found: ReceivedEvent[] = [];
  for (const request of collector.requests) {
    for (const resourceLog of request.resourceLogs ?? []) {
      const resource = flatten(resourceLog.resource?.attributes);
      for (const record of (resourceLog.scopeLogs ?? []).flatMap((s) => s.logRecords ?? [])) {
        if (record.eventName === eventName) found.push({ attributes: flatten(record.attributes), resource });
      }
    }
  }
  return found;
}

/** Wait until `count` records of the event have arrived, and return them all. */
async function waitForEvents(
  collector: Collector,
  eventName: string,
  count: number,
  timeoutMs: number,
): Promise<ReceivedEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = receivedEvents(collector, eventName);
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Telemetry event "${eventName}" not received ${count} time(s) within ${timeoutMs}ms`);
}

/** The resource attributes of the batch holding the event, as a flat map. */
async function waitForEventResource(
  collector: Collector,
  eventName: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const [first] = await waitForEvents(collector, eventName, 1, timeoutMs);
  return first!.resource;
}

const HOUR_MS = 60 * 60 * 1000;
const REPORTED_THROUGH = 'llmUsageReportedThrough';

/** Wait until the boot's usage pass has stored the end of the hours it reported. */
async function waitForUsageMark(dbPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new Database(dbPath, { readonly: true });
    try {
      if (db.prepare('SELECT 1 FROM runtime_state WHERE key = ?').get(REPORTED_THROUGH)) return;
    } finally {
      db.close();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`runtime_state has no ${REPORTED_THROUGH} row after ${timeoutMs}ms`);
}

interface SeededCall {
  agentId: string;
  hourStart: number;
}

/**
 * Write one call ten minutes into the hour three hours ago, and remove the mark,
 * as for a call no pass has reported yet. Columns as `llmCallService.record`
 * writes them, `createdAt` in epoch milliseconds.
 */
function seedUnreportedCall(dbPath: string): SeededCall {
  const hourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 3 * HOUR_MS;
  const db = new Database(dbPath);
  try {
    const { id: agentId } = db.prepare('SELECT id FROM agent_workspaces LIMIT 1').get() as { id: string };
    db.prepare(
      `INSERT INTO llm_calls (id, agentId, purpose, model, totalTokens, inputTokens, outputTokens,
         cacheReadTokens, cacheWriteTokens, noCacheTokens, createdAt)
       VALUES (?, ?, 'chat', 'e2e-model', 1210, 1200, 10, 900, 200, 100, ?)`,
    ).run(randomUUID(), agentId, hourStart + 10 * 60 * 1000);
    db.prepare('DELETE FROM runtime_state WHERE key = ?').run(REPORTED_THROUGH);
    return { agentId, hourStart };
  } finally {
    db.close();
  }
}

let collector: Collector | undefined;
let env: RuntimeTestEnv | undefined;
let resource: Record<string, string> = {};
let started: ReceivedEvent[] = [];
let seeded: SeededCall | undefined;

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
    started = [];
    seeded = undefined;
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

  Scenario('A runtime keeps its deployment id across a restart', ({ Given, When, And, Then }) => {
    Given('a runtime started without PRODUCT_NAME', async () => {
      await bootWithProductName(undefined);
    });
    When('the runtime reports that the agent started', async () => {
      started = await waitForEvents(collector!, 'agent started', 1, 30_000);
    });
    And('the runtime restarts and reports that the agent started again', async () => {
      await env!.restart();
      started = await waitForEvents(collector!, 'agent started', 2, 30_000);
    });
    Then('both boots have the same non-empty deployment.id', () => {
      const [first, second] = started;
      expect(first!.resource['deployment.id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(second!.resource['deployment.id']).toBe(first!.resource['deployment.id']);
    });
  });

  Scenario('A runtime reports the token use of a closed hour', ({ Given, And, When, Then }) => {
    Given('a runtime started without PRODUCT_NAME', async () => {
      await bootWithProductName(undefined);
    });
    And('the agent made a model call three hours ago that is not reported yet', async () => {
      await waitForEvents(collector!, 'agent started', 1, 30_000);
      await waitForUsageMark(env!.dbPath, 30_000);
      seeded = seedUnreportedCall(env!.dbPath);
    });
    When('the runtime restarts', async () => {
      await env!.restart();
      started = await waitForEvents(collector!, 'agent started', 2, 30_000);
    });
    Then('the runtime reports the token use of that hour once, metered by the harness', async () => {
      const [usage] = await waitForEvents(collector!, 'llm usage aggregated', 1, 30_000);
      // A second record would arrive within the exporter's batch delay.
      await new Promise((r) => setTimeout(r, 2_000));
      expect(receivedEvents(collector!, 'llm usage aggregated')).toHaveLength(1);
      expect(usage!.attributes).toMatchObject({
        'usage.period_start': new Date(seeded!.hourStart).toISOString(),
        'usage.period_end': new Date(seeded!.hourStart + HOUR_MS).toISOString(),
        'usage.model': 'e2e-model',
        'usage.input_tokens': '1200',
        'usage.output_tokens': '10',
        'usage.cache_creation_tokens': '200',
        'usage.cache_read_tokens': '900',
        'usage.request_count': '1',
        'usage.metering_point': 'harness',
        'agent.id': seeded!.agentId,
      });
      expect(usage!.resource['deployment.id']).toBe(started[1]!.resource['deployment.id']);
    });
    And('its routing matches the agent started event of the same boot', async () => {
      const [usage] = receivedEvents(collector!, 'llm usage aggregated');
      expect(usage!.attributes['usage.llm_routing']).toBe(started[1]!.attributes['llm.routing']);
      expect(usage!.attributes['usage.provider']).toBe(started[1]!.attributes['llm.provider']);
    });
  });
});
