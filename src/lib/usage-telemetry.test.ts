/**
 * The hourly `llm usage aggregated` events, read from `llm_calls` in a database
 * built from the committed migrations, so the hour boundaries, the index the
 * read filters on and the stored mark are the real ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../test-utils/migrated-database';

const { database, mockTrackEvent, mockIsTelemetryEnabled, mockFlushTelemetry, mockConfig } = vi.hoisted(() => ({
  database: { client: undefined as PrismaClient | undefined },
  mockTrackEvent: vi.fn(),
  mockIsTelemetryEnabled: vi.fn(),
  mockFlushTelemetry: vi.fn(),
  mockConfig: {} as Record<string, unknown>,
}));

vi.mock('./prisma', () => ({
  prisma: new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) }),
}));
// The real `llmRouting`, so the routing under test is the one `agent started` sends.
vi.mock('./telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./telemetry')>()),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: mockIsTelemetryEnabled,
  flushTelemetry: mockFlushTelemetry,
}));
vi.mock('../config', () => ({ config: mockConfig }));

import { reportClosedHours, startUsageTelemetry } from './usage-telemetry';
import { llmRouting } from './telemetry';
import { LLM_USAGE_REPORTED_THROUGH } from '../services/runtime-state.service';

const OWNER = 'agent-1';
const OTHER_AGENT = 'agent-2';
const SUBAGENT = 'subagent-1';
const CHAT_MODEL = 'global.anthropic.claude-opus-5-5';
const GATE_MODEL = 'global.anthropic.claude-haiku-5-5';

const HOUR = 60 * 60 * 1000;
/** 10:00 UTC; the tests report from a moment after 12:00, so 10:00 and 11:00 are closed. */
const H10 = Date.parse('2026-11-06T10:00:00.000Z');
const H11 = H10 + HOUR;
const H12 = H10 + 2 * HOUR;
const NOW = H12 + 5 * 60 * 1000;

let opened: MigratedDatabase;

function db(): PrismaClient {
  return database.client!;
}

/** One pass, run at the given moment. */
async function reportAt(at: number): Promise<void> {
  vi.setSystemTime(at);
  await reportClosedHours(OWNER);
}

async function storedMark(): Promise<string | undefined> {
  const row = await db().runtimeState.findUnique({ where: { key: LLM_USAGE_REPORTED_THROUGH } });
  return row?.value;
}

async function recordCall(
  at: number,
  model: string,
  counts: Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens', number>> = {},
  agentId = OWNER,
  subagentId: string | null = null,
): Promise<void> {
  await db().llmCall.create({
    data: { agentId, subagentId, purpose: 'chat', model, createdAt: new Date(at), ...counts },
  });
}

/** The attributes of every event sent, in the order sent. */
function events(): Record<string, string>[] {
  return mockTrackEvent.mock.calls.map(([name, userId, props]) => {
    expect(name).toBe('llm usage aggregated');
    expect(userId).toBeUndefined();
    return props as Record<string, string>;
  });
}

function eventFor(hourStart: number, model: string): Record<string, string> | undefined {
  const start = new Date(hourStart).toISOString();
  return events().find((e) => e['usage.period_start'] === start && e['usage.model'] === model);
}

beforeEach(async () => {
  opened = openMigratedDatabase();
  database.client = opened.client;
  for (const id of [OWNER, OTHER_AGENT]) {
    await db().agentWorkspace.create({
      data: { id, userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
    });
  }
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, {
    llmProvider: 'bedrock',
    nexusChatBaseUrl: null,
  });
  mockIsTelemetryEnabled.mockReturnValue(true);
  mockFlushTelemetry.mockResolvedValue(true);
  // Only the clock: the database driver keeps its real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await opened.close();
});

describe('reportClosedHours', () => {
  it('sends one event per closed hour and model, with the counts of that hour', async () => {
    await recordCall(H10 + 1000, CHAT_MODEL, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200 });
    await recordCall(H10 + 2000, CHAT_MODEL, { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 });
    await recordCall(H10 + 3000, GATE_MODEL, { inputTokens: 300, outputTokens: 2 });
    // A call the provider reported no usage for is still a call.
    await recordCall(H11 + 1000, GATE_MODEL);

    await reportAt(NOW);

    expect(events()).toHaveLength(3);
    expect(eventFor(H10, CHAT_MODEL)).toEqual({
      'usage.period_start': '2026-11-06T10:00:00.000Z',
      'usage.period_end': '2026-11-06T11:00:00.000Z',
      'usage.provider': 'bedrock',
      'usage.model': CHAT_MODEL,
      'usage.input_tokens': '1500',
      'usage.output_tokens': '150',
      'usage.cache_creation_tokens': '200',
      'usage.cache_read_tokens': '1100',
      'usage.request_count': '2',
      'usage.metering_point': 'harness',
      'usage.llm_routing': 'direct',
      'agent.id': OWNER,
    });
    expect(eventFor(H10, GATE_MODEL)).toMatchObject({ 'usage.input_tokens': '300', 'usage.request_count': '1' });
    expect(eventFor(H11, GATE_MODEL)).toMatchObject({
      'usage.period_end': '2026-11-06T12:00:00.000Z',
      'usage.input_tokens': '0',
      'usage.request_count': '1',
    });
  });

  it('puts a call made on the hour into the hour it starts', async () => {
    await recordCall(H11, CHAT_MODEL, { inputTokens: 10 });

    await reportAt(NOW);

    expect(events()).toHaveLength(1);
    expect(eventFor(H11, CHAT_MODEL)).toMatchObject({ 'usage.input_tokens': '10' });
  });

  it('leaves the open hour, and an hour that ended less than a minute ago, for a later pass', async () => {
    await recordCall(H11 + 1000, CHAT_MODEL);
    await recordCall(H12 + 1000, CHAT_MODEL);

    await reportAt(H12 + 30 * 1000);
    expect(events()).toEqual([]);

    await reportAt(H12 + 61 * 1000);
    expect(events().map((e) => e['usage.period_start'])).toEqual(['2026-11-06T11:00:00.000Z']);
  });

  it('reports each hour once across passes and restarts', async () => {
    await recordCall(H10 + 1000, CHAT_MODEL);

    await reportAt(NOW);
    expect(await db().runtimeState.findUnique({ where: { key: LLM_USAGE_REPORTED_THROUGH } })).toMatchObject({
      value: '2026-11-06T12:00:00.000Z',
    });

    // The same hour again, in this process or the next one, sends nothing.
    await reportAt(NOW + 10 * 60 * 1000);
    expect(events()).toHaveLength(1);

    // A call in the hour after is sent once that hour is closed.
    await recordCall(H12 + 1000, CHAT_MODEL);
    await reportAt(H12 + HOUR + 2 * 60 * 1000);
    expect(events()).toHaveLength(2);
    expect(eventFor(H12, CHAT_MODEL)).toBeDefined();
  });

  it('reports at most the last 24 closed hours on the first pass, with no mark stored', async () => {
    await recordCall(H12 - 25 * HOUR + 1000, CHAT_MODEL);
    await recordCall(H12 - 24 * HOUR + 1000, CHAT_MODEL);

    await reportAt(NOW);

    expect(events().map((e) => e['usage.period_start'])).toEqual([new Date(H12 - 24 * HOUR).toISOString()]);
  });

  it('reports every hour after the mark, however long the runtime was stopped', async () => {
    await db().runtimeState.create({ data: { key: LLM_USAGE_REPORTED_THROUGH, value: '2026-11-06T10:00:00.000Z' } });
    await recordCall(H10 + 1000, CHAT_MODEL);
    await recordCall(H10 + 26 * HOUR + 1000, CHAT_MODEL);

    await reportAt(H10 + 30 * HOUR + 5 * 60 * 1000);

    expect(events().map((e) => e['usage.period_start'])).toEqual([
      '2026-11-06T10:00:00.000Z',
      '2026-11-07T12:00:00.000Z',
    ]);
    expect(await storedMark()).toBe('2026-11-07T16:00:00.000Z');
  });

  it('keeps the mark at the last window the collector accepted', async () => {
    await db().runtimeState.create({ data: { key: LLM_USAGE_REPORTED_THROUGH, value: '2026-11-06T10:00:00.000Z' } });
    await recordCall(H10 + 1000, CHAT_MODEL);
    await recordCall(H10 + 26 * HOUR + 1000, CHAT_MODEL);
    mockFlushTelemetry.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await reportAt(H10 + 30 * HOUR + 5 * 60 * 1000);

    expect(await storedMark()).toBe('2026-11-07T10:00:00.000Z');
  });

  it('starts no second pass while one is running', async () => {
    await recordCall(H10 + 1000, CHAT_MODEL);
    let accept!: (accepted: boolean) => void;
    mockFlushTelemetry.mockImplementationOnce(() => new Promise<boolean>((resolve) => (accept = resolve)));

    vi.setSystemTime(NOW);
    const first = reportClosedHours(OWNER);
    await vi.waitFor(() => expect(mockFlushTelemetry).toHaveBeenCalledTimes(1));
    await reportClosedHours(OWNER);
    accept(true);
    await first;

    expect(events()).toHaveLength(1);
    expect(mockFlushTelemetry).toHaveBeenCalledTimes(1);
  });

  it('reports the owner, with a subagent call counted under it, and no other agent', async () => {
    await recordCall(H10 + 1000, CHAT_MODEL, { inputTokens: 10 });
    await recordCall(H10 + 2000, CHAT_MODEL, { inputTokens: 5 }, OWNER, SUBAGENT);
    await recordCall(H10 + 3000, CHAT_MODEL, { inputTokens: 999 }, OTHER_AGENT);

    await reportAt(NOW);

    expect(events()).toHaveLength(1);
    expect(eventFor(H10, CHAT_MODEL)).toMatchObject({
      'agent.id': OWNER,
      'usage.input_tokens': '15',
      'usage.request_count': '2',
    });
  });

  it.each([
    ['bedrock through the gateway', { llmProvider: 'bedrock', nexusChatBaseUrl: 'https://gateway.test/llm/bedrock/us-east-1' }, 'nexus'],
    ['bedrock direct', { llmProvider: 'bedrock', nexusChatBaseUrl: null }, 'direct'],
    ['anthropic, which has no gateway mount', { llmProvider: 'anthropic', nexusChatBaseUrl: null, nexusApiUrl: 'https://gateway.test' }, 'direct'],
  ])('reports provider and routing as agent started does: %s', async (_label, settings, routing) => {
    Object.assign(mockConfig, settings);
    await recordCall(H10 + 1000, CHAT_MODEL);

    await reportAt(NOW);

    expect(eventFor(H10, CHAT_MODEL)).toMatchObject({
      'usage.provider': settings.llmProvider,
      'usage.llm_routing': routing,
    });
    expect(llmRouting()).toBe(routing);
  });

  it('sends nothing for hours with no calls, and still moves the mark', async () => {
    await reportAt(NOW);

    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(await db().runtimeState.findUnique({ where: { key: LLM_USAGE_REPORTED_THROUGH } })).not.toBeNull();
  });

  it('moves the mark only after the events left the buffer', async () => {
    await recordCall(H10 + 1000, CHAT_MODEL);
    mockFlushTelemetry.mockImplementationOnce(async () => {
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(await storedMark()).toBeUndefined();
      return true;
    });

    await reportAt(NOW);

    expect(mockFlushTelemetry).toHaveBeenCalledTimes(1);
    expect(await storedMark()).toBe('2026-11-06T12:00:00.000Z');
  });

  it('keeps the mark when the collector did not accept the events, and sends the hour again', async () => {
    await recordCall(H10 + 1000, CHAT_MODEL);
    mockFlushTelemetry.mockResolvedValueOnce(false);

    await reportAt(NOW);
    expect(await storedMark()).toBeUndefined();

    await reportAt(NOW);
    expect(events().map((e) => e['usage.period_start'])).toEqual([
      '2026-11-06T10:00:00.000Z',
      '2026-11-06T10:00:00.000Z',
    ]);
    expect(await storedMark()).toBe('2026-11-06T12:00:00.000Z');
  });

  it('keeps the mark when the calls cannot be read, and the next pass sends those hours', async () => {
    await recordCall(H11 + 1000, CHAT_MODEL);
    await db().runtimeState.create({ data: { key: LLM_USAGE_REPORTED_THROUGH, value: '2026-11-06T11:00:00.000Z' } });
    vi.spyOn(db().llmCall, 'findMany').mockRejectedValueOnce(new Error('database is locked'));

    await reportAt(NOW);
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(await storedMark()).toBe('2026-11-06T11:00:00.000Z');

    await reportAt(NOW);
    expect(events().map((e) => e['usage.period_start'])).toEqual(['2026-11-06T11:00:00.000Z']);
  });

  it('does not reject when the database cannot be read', async () => {
    await db().$executeRawUnsafe('DROP TABLE runtime_state');

    vi.setSystemTime(NOW);
    await expect(reportClosedHours(OWNER)).resolves.toBeUndefined();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe('startUsageTelemetry', () => {
  it('starts nothing, sends nothing and stores nothing when telemetry is off', async () => {
    mockIsTelemetryEnabled.mockReturnValue(false);
    await recordCall(H10 + 1000, CHAT_MODEL);

    expect(startUsageTelemetry(OWNER)).toBeUndefined();

    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(await db().runtimeState.count()).toBe(0);
  });

  it('reports at once, and each hour a few minutes after it closes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    await recordCall(H10 + 1000, CHAT_MODEL);

    const timer = startUsageTelemetry(OWNER);
    await vi.waitFor(() => expect(events()).toHaveLength(1));

    await recordCall(H12 + 1000, CHAT_MODEL);
    await vi.advanceTimersByTimeAsync(HOUR - 5 * 60 * 1000);
    expect(events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(eventFor(H12, CHAT_MODEL)).toBeDefined();

    clearInterval(timer);
  });
});
