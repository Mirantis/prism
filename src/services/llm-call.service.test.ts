/**
 * LLM Call Service Tests
 *
 * What gets written, what does not, and that a database failure stays inside
 * this service. The point of the table is coverage — a call is recorded whether
 * or not anything was published — so the cases that matter are the ones where
 * there is no message and no thread.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: { llmCall: { create: vi.fn() } },
  mockLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock('../logger', () => ({ logger: mockLogger }));

import { llmCallService, LLM_CALL_PURPOSES } from './llm-call.service';
import { config } from '../config';

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
});

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

    expect(mockPrisma.llmCall.create).toHaveBeenCalledWith({
      data: {
        agentId: 'agent-1',
        subagentId: null,
        purpose: 'chat',
        model: 'claude-opus-5',
        threadId: 'thread-1',
        totalTokens: 1100,
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
        noCacheTokens: 200,
      },
    });
  });

  it('records a call that has no thread and published nothing', async () => {
    // A suppressed heartbeat, a compaction and a gate all look like this, and
    // they are the reason the table is written at the call.
    for (const purpose of ['heartbeat', 'compaction', 'delivery-gate'] as const) {
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
      'delivery-gate',
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
