/**
 * LLM Call Service Tests
 *
 * What gets written, what does not, and that a database failure stays inside
 * this service. The point of the table is coverage — a call is recorded whether
 * or not anything was published — so the cases that matter are the ones where
 * there is no message and no thread.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockLogger, prices } = vi.hoisted(() => ({
  mockPrisma: {
    llmCall: { create: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
  mockLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  prices: new Map<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>(),
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock('../logger', () => ({ logger: mockLogger }));
vi.mock('../lib/model-pricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/model-pricing')>()),
  priceFor: (model: string) => prices.get(model) ?? null,
}));

import { llmCallService, LLM_CALL_PURPOSES } from './llm-call.service';
import { withSpendContext } from '../lib/spend-context';
import { config } from '../config';

/** Dollars per million tokens, so the expected costs below are easy to check by hand. */
const OPUS = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

/** What the AI SDK hands back for a cache-capable provider. */
function usage(over: Partial<Record<string, unknown>> = {}) {
  return {
    inputTokens: 1000,
    outputTokens: 100,
    totalTokens: 1100,
    inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100, noCacheTokens: 200 },
    outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
    ...over,
  };
}

/** The service writes in the background; let the microtask queue drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.llmCall.create.mockResolvedValue({});
  config.agentId = 'agent-1';
  config.chatCacheTtl = '5m';
  prices.clear();
  prices.set('claude-opus-5', OPUS);
});

/** The data of the n-th row written. */
const written = (n = 0) => mockPrisma.llmCall.create.mock.calls[n][0].data;

describe('LLM_CALL_PURPOSES', () => {
  it('has a recorder for every purpose it declares', async () => {
    // A purpose with no recorder is spend nobody counts, which is the one thing
    // this table exists to prevent — and exactly what shipped for the two
    // generateObject gates until a reviewer noticed.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
          sources.push(readFileSync(full, 'utf8'));
        }
      }
    };
    walk(join(__dirname, '..'));
    const src = sources.join('\n');

    // The invoke loop passes `request.mode` through, so the six invoke modes are
    // recorded by that one site rather than by a literal.
    const invokeModes = new Set(['chat', 'heartbeat', 'cron', 'goal', 'webhook', 'subagent']);
    expect(src).toContain('purpose: request.mode');

    const unwired = LLM_CALL_PURPOSES.filter(
      (purpose) => !invokeModes.has(purpose) && !src.includes(`purpose: '${purpose}'`),
    );

    expect(unwired).toEqual([]);
  });
});

describe('llmCallService.record', () => {
  it('writes one row with the counts and the cache split', async () => {
    llmCallService.record({
      purpose: 'chat',
      model: 'claude-opus-5',
      usage: usage(),
      threadId: 'thread-1',
    });
    await settle();

    expect(written()).toEqual({
      agentId: 'agent-1',
      subagentId: null,
      purpose: 'chat',
      model: 'claude-opus-5',
      threadId: 'thread-1',
      requestId: null,
      sourceKind: null,
      sourceId: null,
      totalTokens: 1100,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      noCacheTokens: 200,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      // 200 × 5 + 700 × 0.5 + 100 × 6.25 + 100 × 25 millionths of a dollar.
      costMicroUsd: 4475,
      costSource: 'catalog',
      createdAt: expect.any(Date),
      bucket: expect.any(Date),
    });
  });

  it('files a call in the 15-minute bucket it was made in', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T10:44:59.999Z'), toFake: ['Date'] });
    try {
      llmCallService.record({ purpose: 'chat', model: 'claude-opus-5', usage: usage() });
    } finally {
      vi.useRealTimers();
    }
    await settle();

    expect(written().createdAt).toEqual(new Date('2026-11-21T10:44:59.999Z'));
    expect(written().bucket).toEqual(new Date('2026-11-21T10:30:00.000Z'));
  });

  it('prices the cache writes of a chat turn at the one-hour lifetime when CHAT_CACHE_TTL asks for it', async () => {
    config.chatCacheTtl = '1h';
    llmCallService.record({ purpose: 'chat', model: 'claude-opus-5', usage: usage() });
    llmCallService.record({ purpose: 'compaction', model: 'claude-opus-5', usage: usage() });
    await settle();

    // The 100 written tokens cost 2 × 5 instead of 6.25 on the chat turn alone.
    expect(written(0).costMicroUsd).toBe(4475 - 625 + 1000);
    expect(written(1).costMicroUsd).toBe(4475);
  });

  it('spends a call on the request and thread of the work it runs in', async () => {
    withSpendContext({ requestId: 'message-1', threadId: 'thread-1', source: { kind: 'cron', id: 'task-1' } }, () => {
      llmCallService.record({ purpose: 'risk-gate', model: 'claude-opus-5', usage: usage() });
      llmCallService.record({ purpose: 'goal-gate', model: 'claude-opus-5', usage: usage(), threadId: 'thread-2', requestId: 'goal-1' });
    });
    await settle();

    expect(written(0)).toMatchObject({ requestId: 'message-1', threadId: 'thread-1', sourceKind: 'cron', sourceId: 'task-1' });
    expect(written(1)).toMatchObject({ requestId: 'goal-1', threadId: 'thread-2' });
  });

  it('leaves a model the catalog has no price for unpriced', async () => {
    llmCallService.record({ purpose: 'chat', model: 'operator-alias', usage: usage() });
    await settle();

    expect(written()).toMatchObject({ costMicroUsd: null, costSource: null, totalTokens: 1100 });
  });

  it('records a call that has no thread and published nothing', async () => {
    // A silent heartbeat, a compaction and a gate all look like this, and
    // they are the reason the table is written at the call.
    for (const purpose of ['heartbeat', 'compaction', 'risk-gate'] as const) {
      llmCallService.record({ purpose, model: 'claude-haiku-4-5', usage: usage() });
    }
    await settle();

    expect(mockPrisma.llmCall.create).toHaveBeenCalledTimes(3);
    for (const call of mockPrisma.llmCall.create.mock.calls) {
      expect(call[0].data.threadId).toBeNull();
    }
    expect(mockPrisma.llmCall.create.mock.calls.map((c) => c[0].data.purpose)).toEqual([
      'heartbeat',
      'compaction',
      'risk-gate',
    ]);
  });

  it('bills the owner and records which subagent ran the call', async () => {
    // The task tool invokes a child workspace under its own id. The owner still
    // paid, so the spend stays on the owner and the child is provenance — which
    // also keeps a past total from moving if that subagent link is later cut.
    llmCallService.record({
      purpose: 'subagent',
      model: 'claude-opus-5',
      usage: usage(),
      agentId: 'subagent-9',
    });
    await settle();

    const { agentId, subagentId } = mockPrisma.llmCall.create.mock.calls[0][0].data;
    expect(agentId).toBe('agent-1');
    expect(subagentId).toBe('subagent-9');
  });

  it("leaves subagentId null for the owner's own work", async () => {
    llmCallService.record({ purpose: 'compaction', model: 'm', usage: usage(), agentId: 'agent-1' });
    await settle();

    expect(mockPrisma.llmCall.create.mock.calls[0][0].data.subagentId).toBeNull();
  });

  it('still records a call the provider reported no usage for', async () => {
    // The row count is what the page calls "model calls", so dropping one to
    // keep the tokens tidy would undercount the calls.
    llmCallService.record({ purpose: 'chat', model: 'mystery-model', usage: undefined });
    await settle();

    const data = mockPrisma.llmCall.create.mock.calls[0][0].data;
    expect(data.model).toBe('mystery-model');
    expect(data.totalTokens).toBe(0);
    expect(data.inputTokens).toBe(0);
  });

  it('writes nothing when there is no agent to attribute the spend to', async () => {
    config.agentId = undefined as unknown as string;

    llmCallService.record({ purpose: 'chat', model: 'm', usage: usage() });
    await settle();

    expect(mockPrisma.llmCall.create).not.toHaveBeenCalled();
  });

  it('swallows a write failure, because accounting must not break a turn', async () => {
    mockPrisma.llmCall.create.mockRejectedValue(new Error('database is locked'));

    expect(() => llmCallService.record({ purpose: 'chat', model: 'm', usage: usage() })).not.toThrow();
    await settle();

    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('swallows a synchronous throw too', async () => {
    // Not just a rejected promise: if the client throws on the way in, that
    // would land in the middle of the turn that made the model call.
    mockPrisma.llmCall.create.mockImplementation(() => {
      throw new TypeError('client is not what we assume');
    });

    expect(() => llmCallService.record({ purpose: 'chat', model: 'm', usage: usage() })).not.toThrow();

    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('does not make the caller wait on the write', async () => {
    let resolveWrite: (value: unknown) => void = () => {};
    mockPrisma.llmCall.create.mockReturnValue(new Promise((r) => { resolveWrite = r; }));

    // Returns void, and returns now — the insert is still outstanding.
    const returned = llmCallService.record({ purpose: 'chat', model: 'm', usage: usage() });

    expect(returned).toBeUndefined();
    resolveWrite({});
  });
});

describe('llmCallService.recordTokens', () => {
  const tokens = {
    totalTokens: 1100, inputTokens: 1000, outputTokens: 100,
    cacheReadTokens: 700, cacheWriteTokens: 100, noCacheTokens: 200,
  };

  it('costs nothing on a subscription', async () => {
    llmCallService.recordTokens({ purpose: 'coding-agent', model: 'claude-opus-5', tokens, subscription: true, reportedCostUsd: 0.2 });
    await settle();

    expect(written()).toMatchObject({ costMicroUsd: 0, costSource: 'subscription', inputTokens: 1000 });
  });

  it('takes the reported cost over the catalog price, and the catalog price when none is reported', async () => {
    llmCallService.recordTokens({ purpose: 'coding-agent', model: 'new-model', tokens, reportedCostUsd: 0.0123456 });
    llmCallService.recordTokens({ purpose: 'coding-agent', model: 'claude-opus-5', tokens, reportedCostUsd: 0.5 });
    llmCallService.recordTokens({ purpose: 'coding-agent', model: 'claude-opus-5', tokens });
    await settle();

    expect(written(0)).toMatchObject({ costMicroUsd: 12346, costSource: 'reported' });
    expect(written(1)).toMatchObject({ costMicroUsd: 500000, costSource: 'reported' });
    expect(written(2)).toMatchObject({ costMicroUsd: 4475, costSource: 'catalog' });
  });

  it('prices a multi-request coding-agent row at the base tier, not from its summed prompt', async () => {
    // Ten requests of 30k prompt tokens each: no single prompt reaches the 100k
    // tier, so the 300k sum must not price the row there.
    prices.set('tiered', { input: 1, output: 2, tiers: [{ above: 100_000, input: 10, output: 20 }] } as never);
    const summed = {
      totalTokens: 310_000, inputTokens: 300_000, outputTokens: 10_000,
      cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 300_000,
    };
    llmCallService.recordTokens({ purpose: 'coding-agent', model: 'tiered', tokens: summed });
    llmCallService.recordTokens({ purpose: 'chat', model: 'tiered', tokens: summed });
    await settle();

    expect(written(0)).toMatchObject({ costMicroUsd: 300_000 * 1 + 10_000 * 2, costSource: 'catalog' });
    // One chat request with a 300k prompt is above the tier.
    expect(written(1)).toMatchObject({ costMicroUsd: 300_000 * 10 + 10_000 * 20, costSource: 'catalog' });
  });

  it('prices the cache writes the caller marks as long at the one-hour lifetime', async () => {
    llmCallService.recordTokens({ purpose: 'coding-agent', model: 'claude-opus-5', tokens: { ...tokens, longCacheWriteTokens: 100 } });
    await settle();

    expect(written().costMicroUsd).toBe(4475 - 625 + 1000);
  });

  it('prices audio at the audio rates', async () => {
    prices.set('voice-model', { input: 4, output: 24, cacheRead: 0.4, inputAudio: 32, outputAudio: 64 } as never);
    llmCallService.recordTokens({
      purpose: 'voice-chat',
      model: 'voice-model',
      tokens: {
        totalTokens: 1300, inputTokens: 1000, outputTokens: 300, cacheReadTokens: 200,
        cacheWriteTokens: 0, noCacheTokens: 800, audioInputTokens: 600, audioOutputTokens: 250,
      },
    });
    await settle();

    // 200 × 4 + 600 × 32 + 200 × 0.4 + 50 × 24 + 250 × 64.
    expect(written()).toMatchObject({ costMicroUsd: 37280, audioInputTokens: 600, audioOutputTokens: 250 });
  });
});

describe('llmCallService.priceUnpricedCalls', () => {
  it('prices the calls whose model the catalog now prices, and leaves the rest', async () => {
    mockPrisma.llmCall.groupBy.mockResolvedValue([{ model: 'claude-opus-5' }, { model: 'operator-alias' }]);
    const row = {
      id: 'call-1', purpose: 'chat', totalTokens: 1100, inputTokens: 1000, outputTokens: 100,
      cacheReadTokens: 700, cacheWriteTokens: 100, noCacheTokens: 200, audioInputTokens: 0, audioOutputTokens: 0,
    };
    mockPrisma.llmCall.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    mockPrisma.llmCall.update.mockImplementation((args) => args);
    mockPrisma.$transaction.mockResolvedValue([]);

    await llmCallService.priceUnpricedCalls();

    expect(mockPrisma.llmCall.groupBy).toHaveBeenCalledWith({
      by: ['model'],
      where: { agentId: 'agent-1', costMicroUsd: null, totalTokens: { gt: 0 } },
    });
    expect(mockPrisma.llmCall.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.llmCall.findMany.mock.calls[0][0].where).toEqual({
      agentId: 'agent-1', model: 'claude-opus-5', costMicroUsd: null, totalTokens: { gt: 0 },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledWith([
      { where: { id: 'call-1' }, data: { costMicroUsd: 4475, costSource: 'catalog' } },
    ]);
  });

  it('logs a failed read and does not reject', async () => {
    mockPrisma.llmCall.groupBy.mockRejectedValue(new Error('locked'));

    await expect(llmCallService.priceUnpricedCalls()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe('llmCallService.newestThreadCall', () => {
  it('reads the newest of the thread\'s calls with the given purposes', async () => {
    const row = { purpose: 'chat', model: 'm', createdAt: new Date() };
    mockPrisma.llmCall.findFirst.mockResolvedValue(row);

    expect(await llmCallService.newestThreadCall('thread-1', ['chat', 'compaction'])).toBe(row);
    expect(mockPrisma.llmCall.findFirst).toHaveBeenCalledWith({
      where: { agentId: 'agent-1', threadId: 'thread-1', purpose: { in: ['chat', 'compaction'] } },
      orderBy: { createdAt: 'desc' },
      select: { purpose: true, model: true, createdAt: true },
    });
  });

  it('answers null when the read fails', async () => {
    mockPrisma.llmCall.findFirst.mockRejectedValue(new Error('locked'));

    expect(await llmCallService.newestThreadCall('thread-1', ['chat'])).toBeNull();
  });
});
